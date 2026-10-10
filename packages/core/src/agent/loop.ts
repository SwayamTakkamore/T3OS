import { createHash } from "node:crypto";
import { toErrorEvent } from "../errors.js";
import type { PermissionPolicy, PermissionRequest } from "../permissions/policy.js";
import type { Provider } from "../provider/types.js";
import type { SessionStore } from "../sessions/store.js";
import type { Tool, ToolContext } from "../tools/types.js";
import type { AgentEvent, Message, ToolCall, ToolClass, TurnEndReason } from "../types.js";
import { eventsToMessages } from "./project.js";

export type ApprovalOutcome = "allow" | "deny" | "session" | "always";

export interface RunTurnOptions {
  provider: Provider;
  store: SessionStore;
  sessionId: string;
  policy: PermissionPolicy;
  root: string;
  tools?: Tool[];
  prompt?: string;
  signal?: AbortSignal;
  onPermission?: (request: PermissionRequest, id: string) => Promise<ApprovalOutcome>;
  onEvent?: (event: AgentEvent) => void;
  maxSteps?: number;
  maxRepeat?: number;
}

export interface TurnResult {
  reason: TurnEndReason;
  text: string;
  steps: number;
  inputTokens: number;
  outputTokens: number;
  events: AgentEvent[];
}

const DEFAULT_MAX_STEPS = 24;
const DEFAULT_MAX_REPEAT = 3;

export function hashArgs(args: unknown): string {
  return createHash("sha1").update(stableStringify(args)).digest("hex").slice(0, 8);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}

function parseArgs(json: string): unknown {
  if (json.trim() === "") return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export async function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const {
    provider,
    store,
    sessionId,
    policy,
    root,
    tools = [],
    signal,
    onPermission,
    maxSteps = DEFAULT_MAX_STEPS,
    maxRepeat = DEFAULT_MAX_REPEAT,
  } = opts;

  const events: AgentEvent[] = [];
  const byName = new Map(tools.map((tool) => [tool.schema.name, tool]));
  const schemas = tools.map((tool) => tool.schema);
  const sessionAllowed = new Set<string>();
  const alwaysAllowed = new Set<string>();
  const repeats = new Map<string, number>();

  const emit = async (event: AgentEvent): Promise<void> => {
    events.push(event);
    opts.onEvent?.(event);
    await store.append(sessionId, event);
  };

  let text = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let steps = 0;
  let reason: TurnEndReason = "complete";

  if (opts.prompt !== undefined) {
    await emit({ type: "user_message", text: opts.prompt });
  }

  const messages: Message[] = eventsToMessages(await store.replay(sessionId));

  while (steps < maxSteps) {
    if (signal?.aborted) {
      reason = "cancelled";
      break;
    }
    steps += 1;

    const calls: ToolCall[] = [];
    const partial = new Map<string, { name: string; json: string }>();
    let stepText = "";

    try {
      stream: for await (const delta of provider.streamChat(
        messages,
        schemas,
        signal ? { signal } : undefined,
      )) {
        switch (delta.type) {
          case "text":
            stepText += delta.text;
            await emit({ type: "text", text: delta.text });
            break;
          case "tool_call_start":
            partial.set(delta.id, { name: delta.name, json: "" });
            break;
          case "tool_call_delta": {
            const entry = partial.get(delta.id);
            if (entry) entry.json += delta.argsJsonDelta;
            break;
          }
          case "tool_call_end": {
            const entry = partial.get(delta.id);
            if (entry) {
              calls.push({ id: delta.id, name: entry.name, args: parseArgs(entry.json) });
              partial.delete(delta.id);
            }
            break;
          }
          case "usage":
            inputTokens += delta.inputTokens;
            outputTokens += delta.outputTokens;
            await emit({
              type: "usage",
              inputTokens: delta.inputTokens,
              outputTokens: delta.outputTokens,
            });
            break;
          case "done":
            break stream;
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        reason = "cancelled";
        break;
      }
      await emit(toErrorEvent(error, "provider"));
      reason = "error";
      break;
    }

    text += stepText;

    if (calls.length === 0) {
      reason = "complete";
      break;
    }

    for (const call of calls) {
      const argsHash = hashArgs(call.args);
      const key = `${call.name}:${argsHash}`;
      const count = (repeats.get(key) ?? 0) + 1;
      repeats.set(key, count);

      if (count > maxRepeat) {
        await emit({ type: "loop_detected", name: call.name, argsHash, count });
        reason = "loop";
        break;
      }

      const tool = byName.get(call.name);
      const toolClass: ToolClass = tool?.class ?? "execute";
      await emit({
        type: "tool_call",
        id: call.id,
        name: call.name,
        args: call.args,
        class: toolClass,
      });

      if (!tool) {
        await emit({
          type: "tool_result",
          id: call.id,
          name: call.name,
          ok: false,
          output: `unknown tool: ${call.name}`,
        });
        continue;
      }

      const request: PermissionRequest = {
        tool: call.name,
        toolClass,
        args: asRecord(call.args),
      };
      const preflight = policy.evaluate(request);
      let decision: ApprovalOutcome = "deny";
      let allowed = false;

      if (preflight.outcome === "allow") {
        decision = "allow";
        allowed = true;
      } else if (preflight.outcome === "deny") {
        decision = "deny";
      } else if (alwaysAllowed.has(call.name)) {
        decision = "always";
        allowed = true;
      } else if (sessionAllowed.has(key)) {
        decision = "session";
        allowed = true;
      } else if (onPermission) {
        decision = await onPermission(request, call.id);
        if (decision === "session") sessionAllowed.add(key);
        if (decision === "always") alwaysAllowed.add(call.name);
        allowed = decision === "allow" || decision === "session" || decision === "always";
      }

      await emit({
        type: "permission_decision",
        id: call.id,
        decision,
        mode: policy.mode,
        argsHash,
      });

      if (!allowed) {
        await emit({
          type: "tool_result",
          id: call.id,
          name: call.name,
          ok: false,
          output: `permission denied (${decision})`,
        });
        continue;
      }

      const ctx: ToolContext = { root, ...(signal ? { signal } : {}) };
      try {
        const result = await tool.run(asRecord(call.args), ctx);
        await emit({
          type: "tool_result",
          id: call.id,
          name: call.name,
          ok: result.ok,
          output: result.content,
        });
      } catch (error) {
        await emit(toErrorEvent(error, "tool"));
        await emit({
          type: "tool_result",
          id: call.id,
          name: call.name,
          ok: false,
          output: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (reason === "loop") break;

    messages.length = 0;
    messages.push(...eventsToMessages(await store.replay(sessionId)));
  }

  if (steps >= maxSteps && reason === "complete") reason = "loop";

  await emit({ type: "turn_end", reason });

  return { reason, text, steps, inputTokens, outputTokens, events };
}
