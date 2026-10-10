#!/usr/bin/env node
import { homedir } from "node:os";
import {
  ConfigLoader,
  HuggingFaceProvider,
  LocalProvider,
  SecretRef,
  SecretResolver,
  SessionStore,
  T3osError,
  builtInTools,
  createPolicy,
  runTurn as runTurnCore,
  type Provider,
} from "@t3os/core";
import { startServer } from "./server.js";
import type { TurnRunner } from "./app.js";

async function makeProvider(model: string, kind: "hf" | "local"): Promise<Provider> {
  if (kind === "local") return new LocalProvider({ modelId: model });
  const token = await new SecretResolver({ env: process.env }).resolve(new SecretRef("HF_TOKEN"));
  if (!token) {
    throw new T3osError("config", "HF_TOKEN is not set; run `t3os auth set <token>`");
  }
  return new HuggingFaceProvider({ model, token });
}

async function main(): Promise<void> {
  const config = await new ConfigLoader({
    cwd: process.cwd(),
    homeDir: homedir(),
    env: process.env,
  }).resolve();
  const store = new SessionStore(config.sessionDir);
  const provider = await makeProvider(config.model, config.provider);
  const policy = createPolicy(config.permissionMode);
  const tools = builtInTools();

  const runTurn: TurnRunner = async ({ sessionId, prompt, onEvent }) => {
    const result = await runTurnCore({
      provider,
      store,
      sessionId,
      policy,
      root: config.projectRoot,
      tools,
      prompt,
      onEvent,
      maxSteps: config.maxTurns,
      maxRepeat: config.loopThreshold,
    });
    return { reason: result.reason };
  };

  const port = Number.parseInt(process.env.T3OS_PORT ?? "8787", 10);
  const server = await startServer({ store, runTurn, port });
  console.log(`t3os server listening on ${server.url}`);
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
