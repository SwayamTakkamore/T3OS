import { describe, expect, it, vi } from "vitest";
import { LocalProvider, MockProvider, type Provider } from "@t3os/core";
import {
  createSettingsController,
  type SettingsSnapshot,
} from "../src/settings.js";

const MODEL = "google/gemma-3-4b-it";
const OTHER_MODEL = "google/gemma-3-12b-it";

const hfProvider = (): Provider => new MockProvider([]);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("createSettingsController", () => {
  it("commits a LocalProvider when switching to local even if the in-flight HF creation is slower", async () => {
    const created: string[] = [];
    const controller = createSettingsController({
      initial: { model: MODEL, effort: "high", providerType: "hf" },
      initialProvider: hfProvider(),
      createProvider: async (snapshot) => {
        created.push(snapshot.providerType);
        if (snapshot.providerType === "hf") {
          // Simulates the slow SecretResolver token lookup for the cloud path.
          await delay(60);
          return hfProvider();
        }
        return new LocalProvider({ modelId: snapshot.model });
      },
    });

    // Queue a cloud update and let its slow provider creation actually start.
    const modelChange = controller.applySettings({ model: MODEL });
    await delay(0);
    // Then switch to local while the cloud request is still in flight.
    const localChange = controller.applySettings({ provider: "local" });

    await Promise.all([modelChange, localChange]);

    expect(created).toEqual(["hf", "local"]);
    expect(controller.provider()).toBeInstanceOf(LocalProvider);
    expect(controller.committed()).toEqual({
      model: MODEL,
      effort: "high",
      providerType: "local",
    });
  });

  it("coalesces rapid updates into a single creation for the latest settings", async () => {
    const snapshots: SettingsSnapshot[] = [];
    const controller = createSettingsController({
      initial: { model: MODEL, effort: "high", providerType: "hf" },
      initialProvider: hfProvider(),
      createProvider: async (snapshot) => {
        snapshots.push(snapshot);
        return new LocalProvider({ modelId: snapshot.model });
      },
    });

    const first = controller.applySettings({ model: OTHER_MODEL });
    const second = controller.applySettings({ provider: "local" });

    await Promise.all([first, second]);

    // The first request never started: its intent was folded into the second.
    expect(snapshots).toEqual([
      { model: OTHER_MODEL, effort: "high", providerType: "local" },
    ]);
    expect(controller.provider()).toBeInstanceOf(LocalProvider);
  });

  it("applies model, effort and provider atomically in one creation call", async () => {
    const snapshots: SettingsSnapshot[] = [];
    const controller = createSettingsController({
      initial: { model: MODEL, effort: "high", providerType: "hf" },
      initialProvider: hfProvider(),
      createProvider: async (snapshot) => {
        snapshots.push(snapshot);
        return new LocalProvider({ modelId: snapshot.model });
      },
    });

    await controller.applySettings({
      model: OTHER_MODEL,
      effort: "low",
      provider: "local",
    });

    expect(snapshots).toEqual([
      { model: OTHER_MODEL, effort: "low", providerType: "local" },
    ]);
    expect(controller.committed()).toEqual({
      model: OTHER_MODEL,
      effort: "low",
      providerType: "local",
    });
  });

  it("rejects on failure and leaves the previous provider and settings active", async () => {
    const initial = hfProvider();
    const snapshots: SettingsSnapshot[] = [];
    const controller = createSettingsController({
      initial: { model: MODEL, effort: "high", providerType: "hf" },
      initialProvider: initial,
      createProvider: async (snapshot) => {
        snapshots.push(snapshot);
        if (snapshot.providerType === "local") {
          throw new Error("local engine unavailable");
        }
        return initial;
      },
    });

    await expect(
      controller.applySettings({ provider: "local" })
    ).rejects.toThrow("local engine unavailable");

    // The failed switch must not be reflected anywhere.
    expect(controller.provider()).toBe(initial);
    expect(controller.committed().providerType).toBe("hf");

    // A later partial update must not inherit the failed local provider type.
    await controller.applySettings({ model: OTHER_MODEL });
    expect(snapshots.at(-1)).toEqual({
      model: OTHER_MODEL,
      effort: "high",
      providerType: "hf",
    });
    expect(controller.provider()).toBe(initial);
  });

  it("keeps the existing provider when no factory is supplied", async () => {
    const initial = hfProvider();
    const controller = createSettingsController({
      initial: { model: MODEL, effort: "high", providerType: "hf" },
      initialProvider: initial,
    });

    await controller.applySettings({ model: OTHER_MODEL, provider: "local" });

    expect(controller.provider()).toBe(initial);
    expect(controller.committed()).toEqual({
      model: OTHER_MODEL,
      effort: "high",
      providerType: "local",
    });
  });

  it("resolves immediately for an empty update without re-creating the provider", async () => {
    const createProvider = vi.fn(async (): Promise<Provider> => hfProvider());
    const controller = createSettingsController({
      initial: { model: MODEL, effort: "high", providerType: "hf" },
      initialProvider: hfProvider(),
      createProvider,
    });

    await controller.applySettings({});

    expect(createProvider).not.toHaveBeenCalled();
  });
});
