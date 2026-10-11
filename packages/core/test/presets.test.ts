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

  it("resolves gemma-4 alias to google/gemma-4-31B-it", () => {
    const preset = resolvePreset("gemma-4");
    expect(preset.id).toBe("google/gemma-4-31B-it");
    expect(preset.contextLength).toBe(32768);
    expect(preset.maxTokens).toBe(4096);
  });

  it("adjusts temperature and maxTokens based on effort parameter", () => {
    const low = resolvePreset("gemma-4", "low");
    expect(low.temperature).toBe(0.2);
    expect(low.maxTokens).toBeLessThan(4096);

    const max = resolvePreset("gemma-4", "max");
    expect(max.temperature).toBe(0.9);
    expect(max.maxTokens).toBeGreaterThan(4096);
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
