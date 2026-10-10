import type { AgentEvent } from "./types.js";

export type ErrorScope = "provider" | "tool" | "boot" | "config";

export class T3osError extends Error {
  readonly scope: ErrorScope;
  constructor(scope: ErrorScope, message: string) {
    super(message);
    this.name = "T3osError";
    this.scope = scope;
  }
}

export function toErrorEvent(err: unknown, scope: ErrorScope): AgentEvent {
  const message = err instanceof Error ? err.message : String(err);
  const resolved = err instanceof T3osError ? err.scope : scope;
  return { type: "error", scope: resolved, message };
}
