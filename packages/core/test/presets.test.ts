import { describe, expect, it } from "vitest";
import { resolvePreset } from "../src/presets/index.js";
import { renderPrompt } from "../src/provider/local.js";

describe("resolvePreset", () => {
  it("recognises gemma ids as the gemma family", () => {
    const preset = resolvePreset("google/gemma-2-9b-it");
    expect(preset.family).toBe("gemma");
    expect(preset.chatTemplate).toBe("gemma");
    expect(preset.contextLength).toBe(8192);
  });

  it("falls back to a generic preset for unknown ids", () => {
    const preset = resolvePreset("some/other-model");
    expect(preset.family).toBe("generic");
    expect(preset.maxTokens).toBeGreaterThan(0);
  });
});

describe("renderPrompt", () => {
  it("renders gemma turn markers", () => {
    const preset = resolvePreset("google/gemma-2-9b-it");
    const prompt = renderPrompt(
      [
        { role: "system", content: "be brief" },
        { role: "user", content: "hi" }
      ],
      preset
    );
    expect(prompt).toContain("<start_of_turn>user");
    expect(prompt).toContain("hi<end_of_turn>");
    expect(prompt.trimEnd().endsWith("<start_of_turn>model")).toBe(true);
  });
});
