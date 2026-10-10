import type { ModelPreset } from "./index.js";

export const GEMMA_PRESETS: ModelPreset[] = [
  {
    id: "google/gemma-2-2b-it",
    family: "gemma",
    chatTemplate: "gemma",
    contextLength: 8192,
    maxTokens: 1024,
    temperature: 0.7,
    stopTokens: ["<end_of_turn>"]
  },
  {
    id: "google/gemma-2-9b-it",
    family: "gemma",
    chatTemplate: "gemma",
    contextLength: 8192,
    maxTokens: 2048,
    temperature: 0.7,
    stopTokens: ["<end_of_turn>"]
  }
];
