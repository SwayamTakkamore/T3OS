import type {
  AgentEvent,
  ErrorScope,
  ToolClass,
  TurnEndReason,
} from "@t3os/core";

export type TranscriptEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      cls: ToolClass;
      args: unknown;
      ok?: boolean;
      output?: string;
    }
  | { kind: "error"; scope: ErrorScope; message: string };

export interface TranscriptState {
  entries: TranscriptEntry[];
  usage: { inputTokens: number; outputTokens: number };
  status: "idle" | "streaming" | "done";
  reason?: TurnEndReason;
}

export function emptyTranscript(): TranscriptState {
  return {
    entries: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    status: "idle",
  };
}

export function reduceTranscript(
  state: TranscriptState,
  event: AgentEvent,
): TranscriptState {
  switch (event.type) {
    case "user_message":
      return {
        ...state,
        status: "streaming",
        entries: [...state.entries, { kind: "user", text: event.text }],
      };
    case "text": {
      const entries = [...state.entries];
      const last = entries[entries.length - 1];
      if (last && last.kind === "assistant") {
        entries[entries.length - 1] = {
          kind: "assistant",
          text: last.text + event.text,
        };
      } else {
        entries.push({ kind: "assistant", text: event.text });
      }
      return { ...state, entries };
    }
    case "tool_call":
      return {
        ...state,
        entries: [
          ...state.entries,
          {
            kind: "tool",
            id: event.id,
            name: event.name,
            cls: event.class,
            args: event.args,
          },
        ],
      };
    case "tool_result": {
      const entries = [...state.entries];
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (entry && entry.kind === "tool" && entry.id === event.id) {
          entries[i] = { ...entry, ok: event.ok, output: event.output };
          break;
        }
      }
      return { ...state, entries };
    }
    case "loop_detected":
      return {
        ...state,
        entries: [
          ...state.entries,
          {
            kind: "error",
            scope: "tool",
            message: `loop detected: ${event.name} (${event.count}x)`,
          },
        ],
      };
    case "error":
      return {
        ...state,
        entries: [
          ...state.entries,
          { kind: "error", scope: event.scope, message: event.message },
        ],
      };
    case "usage":
      return {
        ...state,
        usage: {
          inputTokens: state.usage.inputTokens + event.inputTokens,
          outputTokens: state.usage.outputTokens + event.outputTokens,
        },
      };
    case "turn_end":
      return { ...state, status: "done", reason: event.reason };
    default:
      return state;
  }
}
