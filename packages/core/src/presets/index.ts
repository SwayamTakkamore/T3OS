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
 * Mapping from canonical Google Gemma model IDs to ONNX-converted
 * repositories on the Hugging Face Hub. `@huggingface/transformers`
 * (Transformers.js) is an ONNX runtime: it resolves weights from the
 * `onnx/` subfolder of a repo, which standard safetensors-only checkpoints
 * (e.g. `google/gemma-3-4b-it`) do not provide. These community ONNX
 * repos ship `onnx/*.onnx` weights plus tokenizer and config.
 */
export const LOCAL_ONNX_MODEL_MAP: Record<string, string> = {
  "google/gemma-3-4b-it": "onnx-community/gemma-3-4b-it-ONNX",
  "google/gemma-3-1b-it": "onnx-community/gemma-3-1b-it-ONNX",
  "google/gemma-3-270m-it": "onnx-community/gemma-3-270m-it-ONNX",
  "google/gemma-4-E2B-it": "onnx-community/gemma-4-E2B-it-ONNX",
  "google/gemma-4-E4B-it": "onnx-community/gemma-4-E4B-it-ONNX",
  "google/gemma-4-26B-A4B-it": "justinchuby/gemma-4-26b-a4b-it-onnx",
  "google/gemma-2-9b-it": "onnx-community/gemma-2-9b-it-ONNX-DirectML-GenAI-INT4",
  "google/gemma-2-2b-it": "onnx-community/gemma-2-2b-jpn-it",
};

// Case-insensitive index so lookups survive id casing differences (e.g. "gemma-4-26b-a4b-it").
const LOCAL_ONNX_MODEL_MAP_LOWER = new Map(
  Object.entries(LOCAL_ONNX_MODEL_MAP).map(([key, value]) => [key.toLowerCase(), value])
);

/**
 * Resolves a model identifier for local Transformers.js inference:
 * normalises aliases via `GEMMA_ALIASES`, then maps to the corresponding
 * ONNX-converted repository when one is known. Unmapped ids pass through
 * unchanged (assumed to already provide ONNX weights).
 */
export function resolveLocalModelId(modelId: string): string {
  const normalized = GEMMA_ALIASES[modelId.toLowerCase()] ?? modelId;
  return (
    LOCAL_ONNX_MODEL_MAP[normalized] ??
    LOCAL_ONNX_MODEL_MAP_LOWER.get(normalized.toLowerCase()) ??
    normalized
  );
}

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
