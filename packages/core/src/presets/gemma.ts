import type { ModelPreset } from "./index.js";

export const GEMMA_PRESETS: ModelPreset[] = [
  // Gemma 4 Generation
  {
    id: "google/gemma-4-31B-it",
    family: "gemma",
    chatTemplate: "gemma",
    contextLength: 32768,
    maxTokens: 4096,
    temperature: 0.7,
    stopTokens: ["<end_of_turn>"]
  },
  {
    id: "google/gemma-4-26B-A4B-it",
    family: "gemma",
    chatTemplate: "gemma",
    contextLength: 32768,
    maxTokens: 4096,
    temperature: 0.7,
    stopTokens: ["<end_of_turn>"]
  },

  // Gemma 3 Generation
  {
    id: "google/gemma-3-27b-it",
    family: "gemma",
    chatTemplate: "gemma",
    contextLength: 16384,
    maxTokens: 4096,
    temperature: 0.7,
    stopTokens: ["<end_of_turn>"]
  },
  {
    id: "google/gemma-3-12b-it",
    family: "gemma",
    chatTemplate: "gemma",
    contextLength: 16384,
    maxTokens: 3072,
    temperature: 0.7,
    stopTokens: ["<end_of_turn>"]
  },
  {
    id: "google/gemma-3-4b-it",
    family: "gemma",
    chatTemplate: "gemma",
    contextLength: 8192,
    maxTokens: 2048,
    temperature: 0.7,
    stopTokens: ["<end_of_turn>"]
  },

  // Gemma 2 Generation
  {
    id: "google/gemma-2-27b-it",
    family: "gemma",
    chatTemplate: "gemma",
    contextLength: 8192,
    maxTokens: 4096,
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
  },
  {
    id: "google/gemma-2-2b-it",
    family: "gemma",
    chatTemplate: "gemma",
    contextLength: 8192,
    maxTokens: 1024,
    temperature: 0.7,
    stopTokens: ["<end_of_turn>"]
  }
];
