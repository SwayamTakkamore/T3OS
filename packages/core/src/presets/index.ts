import { GEMMA_PRESETS } from "./gemma.js";

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface ModelPreset {
  id: string;
  family: "gemma" | "generic";
  chatTemplate: "gemma" | "generic";
  contextLength: number;
  maxTokens: number;
  temperature: number;
  stopTokens: string[];
}

const GENERIC: ModelPreset = {
  id: "generic",
  family: "generic",
  chatTemplate: "generic",
  contextLength: 4096,
  maxTokens: 1024,
  temperature: 0.7,
  stopTokens: []
};

// Aliases mapping user shortcuts to specific Gemma models and parameter versions
export const GEMMA_ALIASES: Record<string, string> = {
  // Gemma 4
  "gemma-4": "google/gemma-4-31B-it",
  "gemma4": "google/gemma-4-31B-it",
  "gemma-4-31b": "google/gemma-4-31B-it",
  "gemma-4-26b": "google/gemma-4-26B-A4B-it",

  // Gemma 3
  "gemma-3": "google/gemma-3-27b-it",
  "gemma3": "google/gemma-3-27b-it",
  "gemma-3-27b": "google/gemma-3-27b-it",
  "gemma-3-12b": "google/gemma-3-12b-it",
  "gemma-3-4b": "google/gemma-3-4b-it",

  // Gemma 2
  "gemma-2": "google/gemma-2-9b-it",
  "gemma2": "google/gemma-2-9b-it",
  "gemma-2-27b": "google/gemma-2-27b-it",
  "gemma-2-9b": "google/gemma-2-9b-it",
  "gemma-2-2b": "google/gemma-2-2b-it",
};

/**
 * Resolves a model identifier or alias (e.g. "gemma-4", "gemma-3-4b", "google/gemma-4-31B-it")
 * and optionally applies an effort/reasoning profile (low, medium, high, max).
 */
export function resolvePreset(modelId: string, effort?: EffortLevel): ModelPreset {
  const normalizedId = GEMMA_ALIASES[modelId.toLowerCase()] ?? modelId;
  const exact = GEMMA_PRESETS.find((p) => p.id === normalizedId);
  const base = exact ?? (normalizedId.startsWith("google/gemma") ? { ...GEMMA_PRESETS[0]!, id: normalizedId } : { ...GENERIC, id: normalizedId });

  if (!effort) return { ...base, id: normalizedId };

  // Adjust temperature and max output tokens according to effort profile
  switch (effort) {
    case "low":
      return {
        ...base,
        id: normalizedId,
        temperature: 0.2,
        maxTokens: Math.max(512, Math.floor(base.maxTokens * 0.5)),
      };
    case "high":
      return {
        ...base,
        id: normalizedId,
        temperature: 0.8,
        maxTokens: Math.floor(base.maxTokens * 1.5),
      };
    case "max":
      return {
        ...base,
        id: normalizedId,
        temperature: 0.9,
        maxTokens: Math.min(base.contextLength, base.maxTokens * 2),
      };
    case "medium":
    default:
      return { ...base, id: normalizedId };
  }
}

export { GEMMA_PRESETS };
