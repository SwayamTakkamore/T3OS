import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PermissionMode } from "../types.js";
import type { EffortLevel } from "../presets/index.js";
import { sessionsDir } from "../sessions/paths.js";
import { DEFAULTS, type ConfigFile, type ResolvedConfig } from "./types.js";

export interface LoaderOptions {
  cwd: string;
  homeDir: string;
  env: NodeJS.ProcessEnv;
  flags?: Partial<ConfigFile>;
}

async function readJson(path: string): Promise<ConfigFile> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as ConfigFile;
  } catch {
    return {};
  }
}

function fromEnv(env: NodeJS.ProcessEnv): ConfigFile {
  const out: ConfigFile = {};
  if (env.T3OS_MODEL) out.model = env.T3OS_MODEL;
  if (env.T3OS_PROVIDER === "hf" || env.T3OS_PROVIDER === "local") out.provider = env.T3OS_PROVIDER;
  if (env.T3OS_EFFORT === "low" || env.T3OS_EFFORT === "medium" || env.T3OS_EFFORT === "high" || env.T3OS_EFFORT === "max") {
    out.effort = env.T3OS_EFFORT as EffortLevel;
  }
  if (env.T3OS_PERMISSION_MODE) out.permissionMode = env.T3OS_PERMISSION_MODE as PermissionMode;
  if (env.T3OS_MAX_TURNS) out.maxTurns = Number(env.T3OS_MAX_TURNS);
  if (env.T3OS_LOOP_THRESHOLD) out.loopThreshold = Number(env.T3OS_LOOP_THRESHOLD);
  if (env.T3OS_SESSION_DIR) out.sessionDir = env.T3OS_SESSION_DIR;
  return out;
}

const listMerge = (a?: string[], b?: string[]): string[] => [...(a ?? []), ...(b ?? [])];

export class ConfigLoader {
  readonly #opts: LoaderOptions;
  constructor(opts: LoaderOptions) {
    this.#opts = opts;
  }

  async resolve(): Promise<ResolvedConfig> {
    const { cwd, homeDir, env, flags } = this.#opts;
    const global = await readJson(join(homeDir, ".config", "t3os", "config.json"));
    const project = await readJson(join(cwd, ".t3os", "config.json"));
    const envCfg = fromEnv(env);

    const layers: ConfigFile[] = [global, project, envCfg, flags ?? {}];
    const pick = <K extends keyof ConfigFile>(key: K): ConfigFile[K] | undefined => {
      let value: ConfigFile[K] | undefined;
      for (const layer of layers) if (layer[key] !== undefined) value = layer[key];
      return value;
    };

    const mcpServers = Object.assign({}, global.mcpServers, project.mcpServers, flags?.mcpServers);

    return {
      model: pick("model") ?? DEFAULTS.model,
      provider: pick("provider") ?? DEFAULTS.provider,
      effort: pick("effort") ?? DEFAULTS.effort,
      permissionMode: pick("permissionMode") ?? DEFAULTS.permissionMode,
      toolAllow: listMerge(pick("toolAllow"), undefined),
      toolDeny: listMerge(pick("toolDeny"), undefined),
      mcpServers,
      sessionDir: pick("sessionDir") ?? sessionsDir(),
      maxTurns: pick("maxTurns") ?? DEFAULTS.maxTurns,
      loopThreshold: pick("loopThreshold") ?? DEFAULTS.loopThreshold,
      theme: pick("theme") ?? DEFAULTS.theme,
      projectRoot: cwd,
    };
  }
}
