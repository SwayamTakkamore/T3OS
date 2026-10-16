import { describe, expect, it } from "vitest";
import { LocalProvider, T3osError, type Keyring } from "@t3os/core";
import { makeProvider } from "../src/providerFactory.js";

const noKeyring: Keyring = {
  get: async () => undefined,
  set: async () => {},
};

const withEnv = async (env: NodeJS.ProcessEnv, run: () => Promise<void>): Promise<void> => {
  const previous = process.env.HF_TOKEN;
  delete process.env.HF_TOKEN;
  for (const key of Object.keys(env)) delete process.env[key];
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.HF_TOKEN;
    else process.env.HF_TOKEN = previous;
    for (const key of Object.keys(env)) delete process.env[key];
  }
};

describe("makeProvider", () => {
  it("resolves HF_TOKEN and configures LocalProvider for local inference", async () => {
    await withEnv({ HF_TOKEN: "hf_tui_factory_test" }, async () => {
      const provider = await makeProvider("google/gemma-3-4b-it", "medium", "local", {
        env: { HF_TOKEN: "hf_tui_factory_test" },
        keyring: noKeyring,
      });

      expect(provider).toBeInstanceOf(LocalProvider);
      // Gated models require an authenticated request even for local inference;
      // @huggingface/transformers reads this environment variable directly.
      expect(process.env.HF_TOKEN).toBe("hf_tui_factory_test");
    });
  });

  it("prefers the keyring over the environment when resolving the token", async () => {
    const keyring: Keyring = {
      get: async (name) => (name === "HF_TOKEN" ? "hf_from_keyring" : undefined),
      set: async () => {},
    };

    await withEnv({ HF_TOKEN: "hf_from_env" }, async () => {
      await makeProvider("google/gemma-3-4b-it", "medium", "local", {
        env: { HF_TOKEN: "hf_from_env" },
        keyring,
      });

      expect(process.env.HF_TOKEN).toBe("hf_from_keyring");
    });
  });

  it("still requires HF_TOKEN for the cloud provider", async () => {
    await withEnv({}, async () => {
      const err = await makeProvider("google/gemma-3-4b-it", "medium", "hf", {
        env: {},
        keyring: noKeyring,
      }).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(T3osError);
      expect((err as Error).message).toContain("t3os auth login");
    });
  });
});
