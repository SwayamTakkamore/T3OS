import type { PermissionMode } from "../types.js";
import type { EffortLevel } from "../presets/index.js";

export interface McpServerConfig {
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  url?: string;
}

export interface ConfigFile {
  model?: string;
  provider?: "hf" | "local";
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  toolAllow?: string[];
  toolDeny?: string[];
  mcpServers?: Record<string, McpServerConfig>;
  sessionDir?: string;
  maxTurns?: number;
  loopThreshold?: number;
  theme?: string;
}

export interface ResolvedConfig {
  model: string;
  provider: "hf" | "local";
  effort: EffortLevel;
  permissionMode: PermissionMode;
  toolAllow: string[];
  toolDeny: string[];
  mcpServers: Record<string, McpServerConfig>;
  sessionDir: string;
  maxTurns: number;
  loopThreshold: number;
  theme: string;
  projectRoot: string;
}

export const DEFAULTS: Omit<ResolvedConfig, "sessionDir" | "projectRoot"> = {
  model: "google/gemma-4-31B-it",
  provider: "hf",
  effort: "high",
  permissionMode: "ask",
  toolAllow: [],
  toolDeny: [],
  mcpServers: {},
  maxTurns: 25,
  loopThreshold: 3,
  theme: "default"
};
