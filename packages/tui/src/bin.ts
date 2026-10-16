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
  type ConfigFile,
  type EffortLevel,
  type PermissionMode,
  type Provider,
} from "@t3os/core";
import { startRepl } from "./repl.js";

// Parse CLI flags (e.g. node bin.js --model gemma-4 --effort max --session <id>)
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

const flagsForConfig: Partial<ConfigFile> = {};
if (flags.model) flagsForConfig.model = flags.model;
if (
  flags.effort === "low" ||
  flags.effort === "medium" ||
  flags.effort === "high" ||
  flags.effort === "max"
) {
  flagsForConfig.effort = flags.effort;
}
if (flags.provider === "hf" || flags.provider === "local") {
  flagsForConfig.provider = flags.provider;
}

const config = await new ConfigLoader({
  cwd: process.cwd(),
  homeDir: homedir(),
  env: process.env,
  flags: flagsForConfig,
}).resolve();

async function makeProvider(
  modelId: string = config.model,
  effort: EffortLevel = config.effort,
  providerType: "hf" | "local" = config.provider
): Promise<Provider> {
  const resolved = resolvePreset(modelId, effort);
  if (providerType === "local") {
    return new LocalProvider({ modelId: resolved.id });
  }
  const token = await new SecretResolver({ env: process.env }).resolve(
    new SecretRef("HF_TOKEN")
  );
  if (!token) {
    throw new T3osError(
      "config",
      "HF_TOKEN is not set; run `t3os auth login` or `t3os auth set <token>`"
    );
  }
  return new HuggingFaceProvider({
    model: resolved.id,
    token,
    contextLength: resolved.contextLength,
  });
}

const store = new SessionStore(config.sessionDir);

// Decide which session to open: `--session <id>` (or `--session latest`)
// restores that session, including its preserved settings. Otherwise a fresh
// session is created, seeded from the settings resolved from config — which
// includes the last-used settings persisted to `.t3os/config.json`.
const requestedSession = flags.session;
let sessionId: string;
let initialModel = config.model;
let initialEffort: EffortLevel = config.effort;
let initialProviderType: "hf" | "local" = config.provider;
let initialPermissionMode: PermissionMode = config.permissionMode;

if (requestedSession) {
  const targetId =
    requestedSession === "latest" ? (await store.list())[0]?.id : requestedSession;
  const meta = targetId ? await store.getMeta(targetId) : null;
  if (!meta) {
    console.error(`Session not found: ${requestedSession}`);
    process.exit(1);
  }
  sessionId = meta.id;
  if (meta.settings?.model) initialModel = meta.settings.model;
  if (meta.settings?.effort) initialEffort = meta.settings.effort;
  if (meta.settings?.provider) initialProviderType = meta.settings.provider;
  if (meta.settings?.permissionMode) initialPermissionMode = meta.settings.permissionMode;
} else {
  const created = await store.create("tui", {
    model: config.model,
    effort: config.effort,
    provider: config.provider,
    permissionMode: config.permissionMode,
  });
  sessionId = created.id;
}

const effectivePreset = resolvePreset(initialModel, initialEffort);

let provider: Provider;
try {
  provider = await makeProvider(effectivePreset.id, initialEffort, initialProviderType);
} catch (error) {
  if (error instanceof T3osError && error.message.includes("HF_TOKEN")) {
    const opened = openBrowser(HF_TOKEN_URL);
    console.error("HF_TOKEN is not set.");
    console.error(
      `Create one at ${HF_TOKEN_URL}${opened ? " (opening your browser…)" : ""}`
    );
    console.error("Then run `t3os auth login` to store it.");
    process.exit(1);
  }
  throw error;
}

await startRepl({
  provider,
  store,
  sessionId,
  policy: createPolicy(initialPermissionMode),
  root: config.projectRoot,
  model: effectivePreset.id,
  effort: initialEffort,
  providerType: initialProviderType,
  permissionMode: initialPermissionMode,
  onOpenToken: () => {
    openBrowser(HF_TOKEN_URL);
  },
  onUpdateProvider: async (newModel, newEffort, newProviderType) => {
    return makeProvider(newModel, newEffort, newProviderType);
  },
  onUpdatePolicy: (newMode: PermissionMode) => {
    return createPolicy(newMode);
  },
});
