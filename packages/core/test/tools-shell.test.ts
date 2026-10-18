import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runShell, runShellTool } from "../src/tools/shell.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "t3os-shell-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("runShell", () => {
  it("captures stdout and a zero exit code", async () => {
    const result = await runShell({ cwd: root, command: "echo hello" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("hello");
    expect(result.timedOut).toBe(false);
  });

  it("captures stderr and a non-zero exit code", async () => {
    const result = await runShell({ cwd: root, command: "echo problem 1>&2; exit 3" });
    expect(result.exitCode).toBe(3);
    expect(result.stderr.trim()).toBe("problem");
  });

  it("runs inside the provided cwd", async () => {
    await writeFile(join(root, "marker.txt"), "x", "utf8");
    const result = await runShell({ cwd: root, command: "ls" });
    expect(result.stdout).toContain("marker.txt");
  });

  it("kills a command that exceeds its timeout", async () => {
    const result = await runShell({ cwd: root, command: "sleep 5", timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("truncates output past maxBytes", async () => {
    const result = await runShell({
      cwd: root,
      command: "printf 'a%.0s' $(seq 1 5000)",
      maxBytes: 100,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThanOrEqual(200);
  });
});

describe("runShellTool", () => {
  it("reports a failing command as an unsuccessful result", async () => {
    const result = await runShellTool.run({ command: "exit 7" }, { root });
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({ exitCode: 7 });
  });

  it.each<[string, unknown]>([
    ["cmd", { cmd: "echo via-alias" }],
    ["script", { script: "echo via-alias" }],
    ["a bare string", "echo via-alias"]
  ])("runs a command given as %s", async (_label, args) => {
    const result = await runShellTool.run(args, { root });
    expect(result.ok).toBe(true);
    expect(result.content).toBe("via-alias");
  });

  it("prefers command over cmd and script", async () => {
    const result = await runShellTool.run(
      { command: "echo primary", cmd: "echo secondary", script: "echo tertiary" },
      { root },
    );
    expect(result.content).toBe("primary");
  });

  it("reports a missing command", async () => {
    const result = await runShellTool.run({}, { root });
    expect(result.ok).toBe(false);
    expect(result.content).toContain("missing required argument 'command'");
  });

  it("rejects a cwd that escapes the workspace root", async () => {
    await expect(
      runShellTool.run({ command: "pwd", cwd: "../.." }, { root }),
    ).rejects.toThrow("escapes workspace root");
  });

  it("is classified as an execute tool", () => {
    expect(runShellTool.class).toBe("execute");
  });
});
