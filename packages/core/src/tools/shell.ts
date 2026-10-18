import { spawn } from "node:child_process";
import { T3osError } from "../errors.js";
import { assertNotAborted, resolveInRoot, type Tool, type ToolContext, type ToolResult } from "./types.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

function asString(args: unknown, key: string): string | undefined {
  const value = (args as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
}

function asNumber(args: unknown, key: string): number | undefined {
  const value = (args as Record<string, unknown> | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface RunShellOptions {
  cwd: string;
  command: string;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

export function runShell(opts: RunShellOptions): Promise<ShellResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;

  return new Promise<ShellResult>((resolvePromise) => {
    const child = spawn("bash", ["-lc", opts.command], {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const append = (target: "out" | "err", chunk: Buffer): void => {
      const text = chunk.toString("utf8");
      if (target === "out") {
        stdout += text;
        if (stdout.length > maxBytes) {
          stdout = stdout.slice(0, maxBytes);
          truncated = true;
        }
      } else {
        stderr += text;
        if (stderr.length > maxBytes) {
          stderr = stderr.slice(0, maxBytes);
          truncated = true;
        }
      }
    };

    const killGroup = (): void => {
      try {
        if (typeof child.pid === "number") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };

    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ exitCode, stdout, stderr, timedOut, truncated });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);

    const onAbort = (): void => {
      killGroup();
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => append("out", chunk));
    child.stderr?.on("data", (chunk: Buffer) => append("err", chunk));
    child.on("error", () => finish(127));
    child.on("close", (code) => finish(code ?? 1));
  });
}

export const runShellTool: Tool = {
  class: "execute",
  schema: {
    name: "run_shell",
    description:
      "Run a shell command with bash -lc in the workspace root and return its combined output. " +
      "Use for builds, tests, git status, and other terminal operations.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute." },
        cwd: {
          type: "string",
          description: "Relative working directory inside the workspace root. Defaults to the root."
        },
        timeoutMs: {
          type: "number",
          description: "Wall-clock timeout in milliseconds. Defaults to 120000."
        }
      },
      required: ["command"]
    }
  },
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    assertNotAborted(ctx);
    const command =
      asString(args, "command") ??
      asString(args, "cmd") ??
      asString(args, "script") ??
      (typeof args === "string" ? args : undefined);
    if (!command) {
      return { ok: false, content: "run_shell: missing required argument 'command'" };
    }

    const rel = asString(args, "cwd");
    let cwd = ctx.root;
    if (rel) {
      try {
        cwd = resolveInRoot(ctx.root, rel);
      } catch {
        throw new T3osError("tool", `cwd escapes workspace root: ${rel}`);
      }
    }

    const timeoutMs = asNumber(args, "timeoutMs");
    const runOpts: RunShellOptions = { cwd, command };
    if (timeoutMs !== undefined) runOpts.timeoutMs = timeoutMs;
    if (ctx.signal) runOpts.signal = ctx.signal;
    const result = await runShell(runOpts);

    const ok = result.exitCode === 0 && !result.timedOut;
    const parts: string[] = [];
    if (result.stdout.trim()) parts.push(result.stdout.trimEnd());
    if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trimEnd()}`);
    if (result.timedOut) parts.push("[timed out]");
    if (result.truncated) parts.push("[output truncated]");
    if (!ok) parts.push(`[exit code ${result.exitCode}]`);

    return {
      ok,
      content: parts.join("\n") || "(no output)",
      data: {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        truncated: result.truncated
      }
    };
  }
};
