import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockProvider, VERSION, type Delta, type Keyring } from "@t3os/core";
import { runCli, type CliDeps } from "../src/index.js";

function memoryKeyring(): Keyring {
  const map = new Map<string, string>();
  return {
    async get(name) {
      return map.get(name);
    },
    async set(name, value) {
      map.set(name, value);
    },
  };
}

const roots: string[] = [];

async function harness(overrides: Partial<CliDeps> = {}) {
  const root = await mkdtemp(join(tmpdir(), "t3os-cli-"));
  roots.push(root);
  const out: string[] = [];
  const err: string[] = [];
  const deps: CliDeps = {
    cwd: root,
    homeDir: root,
    env: {},
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...overrides,
  };
  return { deps, out, err, root };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  );
});

describe("runCli", () => {
  it("prints usage for help", async () => {
    const { deps, out } = await harness();
    expect(await runCli(["help"], deps)).toBe(0);
    expect(out.join("\n")).toContain("Usage: t3os");
  });

  it("prints the version", async () => {
    const { deps, out } = await harness();
    expect(await runCli(["version"], deps)).toBe(0);
    expect(out).toEqual([VERSION]);
  });

  it("lists the Gemma models", async () => {
    const { deps, out } = await harness();
    expect(await runCli(["models"], deps)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("google/gemma-2-2b-it");
    expect(text).toContain("google/gemma-2-9b-it");
  });

  it("stores a token without echoing it and reports status", async () => {
    const keyring = memoryKeyring();
    const first = await harness({ keyring });
    expect(await runCli(["auth", "set", "hf_secret"], first.deps)).toBe(0);
    expect(first.out.join("\n")).not.toContain("hf_secret");
    const second = await harness({ keyring });
    expect(await runCli(["auth", "status"], second.deps)).toBe(0);
    expect(second.out).toEqual(["HF_TOKEN: configured"]);
  });

  it("writes and reads a project config value", async () => {
    const { deps, out, root } = await harness();
    expect(await runCli(["config", "set", "maxTurns", "7"], deps)).toBe(0);
    const written = JSON.parse(
      await readFile(join(root, ".t3os", "config.json"), "utf8")
    );
    expect(written.maxTurns).toBe(7);
    const check = await harness({ cwd: root, homeDir: root });
    expect(await runCli(["config", "get", "maxTurns"], check.deps)).toBe(0);
    expect(check.out).toEqual(["7"]);
  });

  it("runs a one-shot turn against an injected mock provider", async () => {
    const script: Delta[] = [
      { type: "text", text: "hi" },
      { type: "usage", inputTokens: 1, outputTokens: 1 },
      { type: "done" },
    ];
    const { deps, out } = await harness({
      makeProvider: async () => new MockProvider([script]),
    });
    expect(await runCli(["run", "say", "hi"], deps)).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("hi");
    expect(text).toContain("[turn_end: complete]");
  });
});
