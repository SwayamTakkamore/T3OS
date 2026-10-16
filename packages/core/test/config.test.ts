import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigLoader } from "../src/config/loader.js";
import { saveLastSettings } from "../src/config/lastSettings.js";

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
  });

  it("global overrides defaults, project overrides global, env overrides project, flags win (permissions)", async () => {
    const { home, cwd } = scaffold();
    writeFileSync(join(cwd, ".t3os", "config.json"),
      JSON.stringify({ model: "project-model", permissionMode: "read-only" }));
    const cfg = await new ConfigLoader({
      cwd, homeDir: home, env: { T3OS_MODEL: "env-model" }
    }).resolve();
    expect(cfg.model).toBe("env-model");
    expect(cfg.permissionMode).toBe("read-only");
  });

  it("reads maxTurns from env", async () => {
    const { home, cwd } = scaffold();
    const cfg = await new ConfigLoader({
      cwd, homeDir: home, env: { T3OS_MAX_TURNS: "9" }
    }).resolve();
    expect(cfg.maxTurns).toBe(9);
  });

  it("merges mcp servers from global and project", async () => {
    const { home, cwd } = scaffold();
    writeFileSync(join(home, ".config", "t3os", "config.json"),
      JSON.stringify({ mcpServers: { fs: { transport: "stdio" } } }));
    writeFileSync(join(cwd, ".t3os", "config.json"),
      JSON.stringify({ mcpServers: { web: { transport: "sse" } } }));
    const cfg = await new ConfigLoader({ cwd, homeDir: home, env: {} }).resolve();
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(["fs", "web"]);
  });
});

describe("saveLastSettings", () => {
  it("remembers the last chosen settings across launches", async () => {
    const home = mkdtempSync(join(tmpdir(), "t3os-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "t3os-repo-"));

    await saveLastSettings(cwd, {
      model: "google/gemma-4-26B-A4B-it",
      provider: "local",
      effort: "max",
      permissionMode: "auto-accept",
    });
    // A later partial save preserves the previously written keys.
    await saveLastSettings(cwd, { model: "google/gemma-4-26B-A4B-it" });

    const onDisk = JSON.parse(readFileSync(join(cwd, ".t3os", "config.json"), "utf8"));
    expect(onDisk).toMatchObject({
      model: "google/gemma-4-26B-A4B-it",
      provider: "local",
      effort: "max",
      permissionMode: "auto-accept",
    });

    const cfg = await new ConfigLoader({ cwd, homeDir: home, env: {} }).resolve();
    expect(cfg.model).toBe("google/gemma-4-26B-A4B-it");
    expect(cfg.provider).toBe("local");
    expect(cfg.effort).toBe("max");
    expect(cfg.permissionMode).toBe("auto-accept");
  });

  it("ignores undefined values and creates the config directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "t3os-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "t3os-repo-"));

    await saveLastSettings(cwd, { model: "m1", effort: undefined });

    expect(JSON.parse(readFileSync(join(cwd, ".t3os", "config.json"), "utf8"))).toEqual({
      model: "m1",
    });
    const cfg = await new ConfigLoader({ cwd, homeDir: home, env: {} }).resolve();
    expect(cfg.model).toBe("m1");
    expect(cfg.effort).toBe("high");
  });

  it("preserves unrelated keys already present in the project config", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "t3os-repo-"));
    mkdirSync(join(cwd, ".t3os"), { recursive: true });
    writeFileSync(join(cwd, ".t3os", "config.json"),
      JSON.stringify({ maxTurns: 7, mcpServers: { fs: { transport: "stdio" } } }));

    await saveLastSettings(cwd, { model: "m2" });

    const onDisk = JSON.parse(readFileSync(join(cwd, ".t3os", "config.json"), "utf8"));
    expect(onDisk.model).toBe("m2");
    expect(onDisk.maxTurns).toBe(7);
    expect(onDisk.mcpServers).toEqual({ fs: { transport: "stdio" } });
  });
});
