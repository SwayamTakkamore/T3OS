import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import {
  ConfigLoader,
  GEMMA_PRESETS,
  HF_TOKEN_URL,
  HuggingFaceProvider,
  LocalProvider,
  SecretRef,
  SecretResolver,
  SessionStore,
  T3osError,
  VERSION,
  builtInTools,
  createPolicy,
  openBrowser,
  runTurn,
  systemKeyring,
  type ConfigFile,
  type Keyring,
  type PermissionMode,
  type Provider,
  type ResolvedConfig,
} from "@t3os/core";
import { parseArgs } from "./args.js";

export interface CliDeps {
  cwd: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  out: (line: string) => void;
  err: (line: string) => void;
  keyring?: Keyring;
  makeProvider?: (config: ResolvedConfig, deps: CliDeps) => Promise<Provider>;
  openBrowser?: (url: string) => boolean;
  promptToken?: (question: string) => Promise<string | undefined>;
}

const USAGE = [
  "Usage: t3os <command> [options]",
  "",
  "Commands:",
  "  help                     Show this help",
  "  version                  Print the T3OS version",
  "  models                   List the bundled Gemma presets",
  "  auth status              Report whether HF_TOKEN is configured",
  "  auth set <token>         Store HF_TOKEN in the system keyring",
  "  auth login               Open the HF token page and store HF_TOKEN",
  "  config show              Print the resolved configuration",
  "  config get <key>         Print one resolved configuration value",
  "  config set <key> <value> Write a value to .t3os/config.json",
  "  run <prompt...>          Run a one-shot agent turn",
  "",
  "Options:",
  "  --model <id>             Override the model",
  "  --permission <mode>      ask | auto-accept | read-only",
  "  --provider <name>        hf | local",
].join("\n");

const CONFIG_KEYS = [
  "model",
  "provider",
  "permissionMode",
  "maxTurns",
  "loopThreshold",
  "theme",
  "sessionDir",
  "projectRoot",
  "toolAllow",
  "toolDeny",
] as const;

type ConfigKey = (typeof CONFIG_KEYS)[number];

async function resolveConfig(
  deps: CliDeps,
  flags: Record<string, string | boolean>
): Promise<ResolvedConfig> {
  const overrides: Partial<ConfigFile> = {};
  if (typeof flags.model === "string") overrides.model = flags.model;
  if (typeof flags.permission === "string") {
    overrides.permissionMode = flags.permission as PermissionMode;
  }
  if (flags.provider === "hf" || flags.provider === "local") {
    overrides.provider = flags.provider;
  }
  const loader = new ConfigLoader({
    cwd: deps.cwd,
    homeDir: deps.homeDir,
    env: deps.env,
    flags: overrides,
  });
  return loader.resolve();
}

async function resolveToken(deps: CliDeps): Promise<string | undefined> {
  const resolver = new SecretResolver({
    env: deps.env,
    keyring: deps.keyring ?? systemKeyring,
  });
  return resolver.resolve(new SecretRef("HF_TOKEN"));
}

async function defaultProvider(
  config: ResolvedConfig,
  deps: CliDeps
): Promise<Provider> {
  if (config.provider === "local") {
    return new LocalProvider({ modelId: config.model });
  }
  const token = await resolveToken(deps);
  if (!token) {
    throw new T3osError(
      "config",
      "HF_TOKEN is not set; run `t3os auth login` or `t3os auth set <token>`"
    );
  }
  return new HuggingFaceProvider({ model: config.model, token });
}

function cmdModels(deps: CliDeps): number {
  for (const preset of GEMMA_PRESETS) {
    deps.out(`${preset.id}\t${preset.contextLength} ctx\t${preset.maxTokens} max`);
  }
  return 0;
}

async function promptForToken(question: string): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } finally {
    rl.close();
  }
}

async function cmdAuth(deps: CliDeps, args: string[]): Promise<number> {
  const sub = args[0];
  const keyring = deps.keyring ?? systemKeyring;
  if (sub === "login") {
    deps.out(`Create a HuggingFace token at ${HF_TOKEN_URL}`);
    const opened = (deps.openBrowser ?? openBrowser)(HF_TOKEN_URL);
    if (opened) deps.out("opening your browser…");
    else deps.err(`could not open a browser; visit ${HF_TOKEN_URL}`);
    const token = await (deps.promptToken ?? promptForToken)(
      "Paste your HuggingFace token: "
    );
    if (!token) {
      deps.err("no token provided");
      return 1;
    }
    await keyring.set("HF_TOKEN", token);
    deps.out("HF_TOKEN stored");
    return 0;
  }
  if (sub === "set") {
    const value = args[1];
    if (!value) {
      deps.err("usage: t3os auth set <token>");
      return 1;
    }
    await keyring.set("HF_TOKEN", value);
    deps.out("HF_TOKEN stored");
    return 0;
  }
  if (sub === "status") {
    const token = await resolveToken(deps);
    deps.out(`HF_TOKEN: ${token ? "configured" : "not configured"}`);
    return 0;
  }
  deps.err(`unknown auth subcommand: ${sub ?? "(none)"}`);
  return 1;
}

function coerce(key: string, raw: string): unknown {
  if (key === "maxTurns" || key === "loopThreshold") return Number(raw);
  if (key === "toolAllow" || key === "toolDeny") {
    return raw
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }
  return raw;
}

async function writeProjectConfig(
  cwd: string,
  key: string,
  raw: string
): Promise<void> {
  const path = join(cwd, ".t3os", "config.json");
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    current = {};
  }
  current[key] = coerce(key, raw);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(current, null, 2)}\n`, "utf8");
}

async function cmdConfig(deps: CliDeps, args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === "show") {
    const config = await resolveConfig(deps, {});
    for (const key of CONFIG_KEYS) {
      deps.out(`${key}=${JSON.stringify((config as unknown as Record<string, unknown>)[key])}`);
    }
    return 0;
  }
  if (sub === "get") {
    const key = args[1];
    if (!key || !CONFIG_KEYS.includes(key as ConfigKey)) {
      deps.err(`unknown config key: ${key ?? "(none)"}`);
      return 1;
    }
    const config = await resolveConfig(deps, {});
    deps.out(JSON.stringify((config as unknown as Record<string, unknown>)[key]));
    return 0;
  }
  if (sub === "set") {
    const key = args[1];
    const value = args[2];
    if (!key || !value || !CONFIG_KEYS.includes(key as ConfigKey)) {
      deps.err("usage: t3os config set <key> <value>");
      return 1;
    }
    await writeProjectConfig(deps.cwd, key, value);
    deps.out(`set ${key} in .t3os/config.json`);
    return 0;
  }
  deps.err(`unknown config subcommand: ${sub ?? "(none)"}`);
  return 1;
}

async function cmdRun(
  deps: CliDeps,
  positionals: string[],
  flags: Record<string, string | boolean>
): Promise<number> {
  const prompt = positionals.join(" ").trim();
  if (!prompt) {
    deps.err("usage: t3os run <prompt...>");
    return 1;
  }
  const config = await resolveConfig(deps, flags);
  let provider: Provider;
  try {
    provider = await (deps.makeProvider ?? defaultProvider)(config, deps);
  } catch (error) {
    if (error instanceof T3osError && error.message.includes("HF_TOKEN")) {
      const opened = (deps.openBrowser ?? openBrowser)(HF_TOKEN_URL);
      deps.err("HF_TOKEN is not set.");
      deps.err(
        `Create one at ${HF_TOKEN_URL}${opened ? " (opening your browser…)" : ""}`
      );
      deps.err("Then run `t3os auth login` or set HF_TOKEN to continue.");
      return 1;
    }
    throw error;
  }
  const store = new SessionStore(config.sessionDir);
  const session = await store.create(prompt.slice(0, 40));
  const result = await runTurn({
    provider,
    store,
    sessionId: session.id,
    policy: createPolicy(config.permissionMode),
    root: config.projectRoot,
    tools: builtInTools(),
    prompt,
    maxSteps: config.maxTurns,
    maxRepeat: config.loopThreshold,
  });
  for (const event of result.events) {
    if (event.type === "text") deps.out(event.text);
    else if (event.type === "tool_call") deps.out(`[tool] ${event.name}`);
    else if (event.type === "tool_result") {
      deps.out(`[${event.ok ? "ok" : "fail"}] ${event.name}`);
    } else if (event.type === "error") {
      deps.err(`[error:${event.scope}] ${event.message}`);
    }
  }
  deps.out(`[turn_end: ${result.reason}]`);
  return result.reason === "error" ? 1 : 0;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const { command, positionals, flags } = parseArgs(argv);
  switch (command) {
    case "help":
    case "--help":
    case "-h":
      deps.out(USAGE);
      return 0;
    case "version":
      deps.out(VERSION);
      return 0;
    case "models":
      return cmdModels(deps);
    case "auth":
      return cmdAuth(deps, positionals);
    case "config":
      return cmdConfig(deps, positionals);
    case "run":
      return cmdRun(deps, positionals, flags);
    default:
      deps.err(`unknown command: ${command}`);
      deps.out(USAGE);
      return 1;
  }
}
