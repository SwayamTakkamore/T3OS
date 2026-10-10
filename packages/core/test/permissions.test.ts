import { describe, expect, it } from "vitest";
import { HARD_DENY_PATTERNS, createPolicy } from "../src/permissions/policy.js";

describe("createPolicy", () => {
  it("always allows read tools", () => {
    for (const mode of ["read-only", "ask", "auto-accept"] as const) {
      const policy = createPolicy(mode);
      expect(policy.evaluate({ tool: "read_file", toolClass: "read", args: {} })).toEqual({
        outcome: "allow",
      });
    }
  });

  it("denies write and execute tools in read-only mode", () => {
    const policy = createPolicy("read-only");
    expect(policy.evaluate({ tool: "write_file", toolClass: "write", args: {} }).outcome).toBe("deny");
    expect(policy.evaluate({ tool: "run_shell", toolClass: "execute", args: {} }).outcome).toBe("deny");
  });

  it("asks for write and execute tools in ask mode", () => {
    const policy = createPolicy("ask");
    expect(policy.evaluate({ tool: "write_file", toolClass: "write", args: {} }).outcome).toBe("ask");
    expect(policy.evaluate({ tool: "run_shell", toolClass: "execute", args: {} }).outcome).toBe("ask");
  });

  it("allows write and execute tools in auto-accept mode", () => {
    const policy = createPolicy("auto-accept");
    expect(policy.evaluate({ tool: "write_file", toolClass: "write", args: {} }).outcome).toBe("allow");
    expect(policy.evaluate({ tool: "run_shell", toolClass: "execute", args: {} }).outcome).toBe("allow");
  });
});

describe("checkShell", () => {
  it("hard-denies dangerous commands even in auto-accept mode", () => {
    const policy = createPolicy("auto-accept");
    for (const command of ["rm -rf /", "mkfs.ext4 /dev/sda", "shutdown now", ":(){ :|:& };:"]) {
      const decision = policy.checkShell(command);
      expect(decision.outcome).toBe("deny");
    }
  });

  it("falls back to the mode matrix for ordinary commands", () => {
    const readOnly = createPolicy("read-only");
    expect(readOnly.checkShell("ls -la").outcome).toBe("deny");

    const ask = createPolicy("ask");
    expect(ask.checkShell("ls -la")).toEqual({
      outcome: "ask",
      reason: "execute access requires approval",
    });
  });

  it("exposes the hard-deny patterns", () => {
    expect(HARD_DENY_PATTERNS.length).toBeGreaterThan(0);
  });
});
