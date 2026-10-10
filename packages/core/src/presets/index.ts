import { GEMMA_PRESETS } from "./gemma.js";

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

export function resolvePreset(modelId: string): ModelPreset {
  const exact = GEMMA_PRESETS.find((p) => p.id === modelId);
  if (exact) return exact;
  if (modelId.startsWith("google/gemma")) {
    return { ...GEMMA_PRESETS[1]!, id: modelId };
  }
  return { ...GENERIC, id: modelId };
}

export { GEMMA_PRESETS };
