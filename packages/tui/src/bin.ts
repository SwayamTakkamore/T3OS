#!/usr/bin/env node
import { homedir } from "node:os";
import {
  ConfigLoader,
  HF_TOKEN_URL,
  HuggingFaceProvider,
  LocalProvider,
  SecretRef,
  SecretResolver,
  SessionStore,
  T3osError,
  createPolicy,
  openBrowser,
  resolvePreset,
  type Provider,
} from "@t3os/core";
import { startRepl } from "./repl.js";

// Parse CLI flags (e.g. node bin.js --model gemma-4 --effort max)
const argv = process.argv.slice(2);
const flags: Record<string, string> = {};
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]!;
  if (arg.startsWith("--")) {
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("-")) {
      flags[key] = next;
      i += 1;
    }
  }
}

const config = await new ConfigLoader({
  cwd: process.cwd(),
  homeDir: homedir(),
  env: process.env,
  flags: {
    ...(flags.model ? { model: flags.model } : {}),
    ...(flags.effort && (flags.effort === "low" || flags.effort === "medium" || flags.effort === "high" || flags.effort === "max")
      ? { effort: flags.effort }
      : {}),
    ...(flags.provider === "hf" || flags.provider === "local" ? { provider: flags.provider } : {}),
  },
}).resolve();

const preset = resolvePreset(config.model, config.effort);

async function makeProvider(): Promise<Provider> {
  if (config.provider === "local") {
    return new LocalProvider({ modelId: preset.id });
  }
  const token = await new SecretResolver({ env: process.env }).resolve(
    new SecretRef("HF_TOKEN"),
  );
  if (!token) {
    throw new T3osError(
      "config",
      "HF_TOKEN is not set; run `t3os auth login` or `t3os auth set <token>`",
    );
  }
  return new HuggingFaceProvider({
    model: preset.id,
    token,
    contextLength: preset.contextLength,
  });
}

let provider: Provider;
try {
  provider = await makeProvider();
} catch (error) {
  if (error instanceof T3osError && error.message.includes("HF_TOKEN")) {
    const opened = openBrowser(HF_TOKEN_URL);
    console.error("HF_TOKEN is not set.");
    console.error(
      `Create one at ${HF_TOKEN_URL}${opened ? " (opening your browser…)" : ""}`,
    );
    console.error("Then run `t3os auth login` to store it.");
    process.exit(1);
  }
  throw error;
}
const store = new SessionStore(config.sessionDir);
const session = await store.create("tui");

await startRepl({
  provider,
  store,
  sessionId: session.id,
  policy: createPolicy(config.permissionMode),
  root: config.projectRoot,
  model: `${preset.id} (${config.effort})`,
  onOpenToken: () => {
    openBrowser(HF_TOKEN_URL);
  },
});
