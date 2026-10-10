import type { PermissionMode, ToolClass } from "../types.js";

export type PermissionDecision =
  | { outcome: "allow" }
  | { outcome: "deny"; reason: string }
  | { outcome: "ask"; reason: string };

export interface PermissionRequest {
  tool: string;
  toolClass: ToolClass;
  args: Record<string, unknown>;
}

export interface PermissionPolicy {
  mode: PermissionMode;
  evaluate(request: PermissionRequest): PermissionDecision;
  checkShell(command: string): PermissionDecision;
}

export const HARD_DENY_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*\s+)*\/(\s|$)/,
  /\bmkfs(\.\w+)?\b/,
  /\bdd\b[^\n]*\bof=\/dev\//,
  /:\s*\(\s*\)\s*\{.*\}\s*;\s*:/,
  /\b(shutdown|reboot|poweroff|halt)\b/,
  /\bchmod\s+(-R\s+)?777\s+\//,
];

function matrix(mode: PermissionMode, toolClass: ToolClass): PermissionDecision {
  if (toolClass === "read") return { outcome: "allow" };
  if (mode === "auto-accept") return { outcome: "allow" };
  if (mode === "read-only") {
    return { outcome: "deny", reason: `${toolClass} tools are disabled in read-only mode` };
  }
  return { outcome: "ask", reason: `${toolClass} access requires approval` };
}

export function createPolicy(mode: PermissionMode): PermissionPolicy {
  return {
    mode,
    evaluate(request: PermissionRequest): PermissionDecision {
      if (request.toolClass === "execute") {
        const command = request.args["command"];
        if (typeof command === "string") return this.checkShell(command);
      }
      return matrix(mode, request.toolClass);
    },
    checkShell(command: string): PermissionDecision {
      for (const pattern of HARD_DENY_PATTERNS) {
        if (pattern.test(command)) {
          return { outcome: "deny", reason: `blocked by hard-deny rule: ${pattern}` };
        }
      }
      return matrix(mode, "execute");
    },
  };
}
