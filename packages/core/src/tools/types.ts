import { isAbsolute, relative, resolve } from "node:path";
import { T3osError } from "../errors.js";
import type { ToolClass, ToolSchema } from "../types.js";

export interface ToolContext {
  root: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  data?: unknown;
}

export interface Tool {
  schema: ToolSchema;
  class: ToolClass;
  run(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export function resolveInRoot(root: string, candidate: string): string {
  const absolute = resolve(root, candidate);
  const rel = relative(root, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new T3osError("tool", `path escapes workspace root: ${candidate}`);
  }
  return absolute;
}

export function assertNotAborted(ctx: ToolContext): void {
  if (ctx.signal?.aborted) throw new T3osError("tool", "tool aborted");
}
