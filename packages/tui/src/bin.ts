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
  createPolicy,
  type Provider,
} from "@t3os/core";
import { startRepl } from "./repl.js";

const config = await new ConfigLoader({
  cwd: process.cwd(),
  homeDir: homedir(),
  env: process.env,
}).resolve();

async function makeProvider(): Promise<Provider> {
  if (config.provider === "local") {
    return new LocalProvider({ modelId: config.model });
  }
  const token = await new SecretResolver({ env: process.env }).resolve(
    new SecretRef("HF_TOKEN"),
  );
  if (!token) {
    throw new T3osError(
      "config",
      "HF_TOKEN is not set; run `t3os auth set <token>`",
    );
  }
  return new HuggingFaceProvider({ model: config.model, token });
}

const provider = await makeProvider();
const store = new SessionStore(config.sessionDir);
const session = await store.create("tui");

await startRepl({
  provider,
  store,
  sessionId: session.id,
  policy: createPolicy(config.permissionMode),
  root: config.projectRoot,
  model: config.model,
});
