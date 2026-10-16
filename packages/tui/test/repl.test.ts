import { describe, expect, it, vi } from "vitest";
import { LocalProvider, MockProvider, type EffortLevel, type Provider } from "@t3os/core";
import { createReplSettings } from "../src/repl.js";

const MODEL = "google/gemma-3-4b-it";
const OTHER_MODEL = "google/gemma-3-12b-it";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Mirrors the provider factory wired up in bin.ts. */
const makeProvider = async (
  model: string,
  _effort: EffortLevel,
  providerType: "hf" | "local"
): Promise<Provider> => {
  if (providerType === "local") {
    return new LocalProvider({ modelId: model });
  }
  // The cloud path resolves the HF token, which is slower than local creation.
  await delay(40);
  return new MockProvider([]);
};

describe("createReplSettings", () => {
  it("sets the active provider to LocalProvider when switching to local", async () => {
    const settings = createReplSettings({
      provider: new MockProvider([]),
      model: MODEL,
      effort: "high",
      providerType: "hf",
      onUpdateProvider: makeProvider,
    });

    await settings.applySettings({ provider: "local" });

    expect(settings.provider()).toBeInstanceOf(LocalProvider);
    expect(settings.committed().providerType).toBe("local");
    expect(settings.committed().model).toBe(MODEL);
  });

  it("keeps LocalProvider active when a model update races the cloud provider", async () => {
    const settings = createReplSettings({
      provider: new MockProvider([]),
      model: MODEL,
      effort: "high",
      providerType: "hf",
      onUpdateProvider: makeProvider,
    });

    // Reproduces the original bug ordering: the model callback fires first
    // (still on the cloud provider) and the provider callback fires second.
    const modelChange = settings.applySettings({ model: MODEL });
    await delay(0); // let the slow cloud creation start
    const providerChange = settings.applySettings({ provider: "local" });

    await Promise.all([modelChange, providerChange]);

    expect(settings.provider()).toBeInstanceOf(LocalProvider);
    expect(settings.committed().providerType).toBe("local");
  });

  it("rejects when local provider creation fails so the UI can surface it", async () => {
    const cloudProvider = new MockProvider([]);
    const settings = createReplSettings({
      provider: cloudProvider,
      model: MODEL,
      effort: "high",
      providerType: "hf",
      onUpdateProvider: vi.fn(async (_model, _effort, providerType) => {
        if (providerType === "local") throw new Error("local engine unavailable");
        return cloudProvider;
      }) as unknown as typeof makeProvider,
    });

    await expect(settings.applySettings({ provider: "local" })).rejects.toThrow(
      "local engine unavailable"
    );
    // The cloud provider stays active and the committed settings are unchanged.
    expect(settings.provider()).toBe(cloudProvider);
    expect(settings.committed().providerType).toBe("hf");
  });

  it("commits model and provider together in one creation call", async () => {
    const createProvider = vi.fn(makeProvider);
    const settings = createReplSettings({
      provider: new MockProvider([]),
      model: MODEL,
      effort: "high",
      providerType: "hf",
      onUpdateProvider: createProvider,
    });

    await settings.applySettings({ provider: "local", model: OTHER_MODEL });

    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(createProvider).toHaveBeenCalledWith(OTHER_MODEL, "high", "local");
    expect(settings.provider()).toBeInstanceOf(LocalProvider);
    expect(settings.committed()).toEqual({
      model: OTHER_MODEL,
      effort: "high",
      providerType: "local",
    });
  });
});
