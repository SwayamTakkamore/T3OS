export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface Message {
  role: Role;
  content: string;
  toolCallId?: string;
  name?: string;
  toolCalls?: ToolCall[];
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type ToolClass = "read" | "write" | "execute";

export type Delta =
  | { type: "text"; text: string }
  | { type: "tool_call_start"; id: string; name: string }
  | { type: "tool_call_delta"; id: string; argsJsonDelta: string }
  | { type: "tool_call_end"; id: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "done" };

export type PermissionMode = "ask" | "auto-accept" | "read-only";

export type TurnEndReason = "complete" | "cancelled" | "loop" | "error";

export type AgentEvent =
  | { type: "user_message"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown; class: ToolClass }
  | {
      type: "permission_decision";
      id: string;
      decision: "allow" | "deny" | "session" | "always";
      mode: PermissionMode;
      argsHash: string;
    }
  | { type: "tool_result"; id: string; name: string; ok: boolean; output: string }
  | { type: "loop_detected"; name: string; argsHash: string; count: number }
  | { type: "error"; scope: "provider" | "tool" | "boot" | "config"; message: string }
  | { type: "usage"; inputTokens: number; outputTokens: number }
  | { type: "turn_end"; reason: TurnEndReason };
