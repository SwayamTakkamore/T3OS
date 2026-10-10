import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigLoader } from "../src/config/loader.js";

function scaffold() {
  const home = mkdtempSync(join(tmpdir(), "t3os-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "t3os-repo-"));
  mkdirSync(join(home, ".config", "t3os"), { recursive: true });
  mkdirSync(join(cwd, ".t3os"), { recursive: true });
  return { home, cwd };
}

describe("ConfigLoader precedence", () => {
  it("defaults when nothing is set", async () => {
    const { home, cwd } = scaffold();
    const cfg = await new ConfigLoader({ cwd, homeDir: home, env: {} }).resolve();
    expect(cfg.provider).toBe("hf");
    expect(cfg.permissionMode).toBe("ask");
    expect(cfg.model.length).toBeGreaterThan(0);
  });

  it("global overrides defaults, project overrides global, env overrides project, flags win", async () => {
    const { home, cwd } = scaffold();
    writeFileSync(join(home, ".config", "t3os", "config.json"),
      JSON.stringify({ model: "global-model", maxTurns: 5 }));
    writeFileSync(join(cwd, ".t3os", "config.json"),
      JSON.stringify({ model: "project-model", permissionMode: "read-only" }));
    const cfg = await new ConfigLoader({
      cwd, homeDir: home, env: { T3OS_MODEL: "env-model", T3OS_MAX_TURNS: "9" },
      flags: { model: "flag-model" }
    }).resolve();
    expect(cfg.model).toBe("flag-model");
    expect(cfg.permissionMode).toBe("read-only");
    expect(cfg.maxTurns).toBe(9);
  });

  it("merges MCP servers across layers", async () => {
    const { home, cwd } = scaffold();
    writeFileSync(join(home, ".config", "t3os", "config.json"),
      JSON.stringify({ mcpServers: { fs: { transport: "stdio", command: "fs-mcp" } } }));
    writeFileSync(join(cwd, ".t3os", "config.json"),
      JSON.stringify({ mcpServers: { web: { transport: "sse", url: "http://x/sse" } } }));
    const cfg = await new ConfigLoader({ cwd, homeDir: home, env: {} }).resolve();
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(["fs", "web"]);
  });
});