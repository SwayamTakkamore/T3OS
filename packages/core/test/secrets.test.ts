import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SecretRef, SecretResolver, systemKeyring } from "../src/config/secrets.js";

const keyringWith = (value?: string) => ({
  get: async () => value,
  set: async () => {}
});

describe("SecretResolver", () => {
  it("prefers the keyring", async () => {
    const r = new SecretResolver({ env: { HF_TOKEN: "from-env" }, keyring: keyringWith("from-keyring") });
    expect(await r.resolve(new SecretRef("HF_TOKEN"))).toBe("from-keyring");
  });

  it("falls back to env when keyring is empty", async () => {
    const r = new SecretResolver({ env: { HF_TOKEN: "from-env" }, keyring: keyringWith(undefined) });
    expect(await r.resolve(new SecretRef("HF_TOKEN"))).toBe("from-env");
  });

  it("returns undefined when absent everywhere", async () => {
    const r = new SecretResolver({ env: {}, keyring: keyringWith(undefined) });
    expect(await r.resolve(new SecretRef("HF_TOKEN"))).toBeUndefined();
  });

  it("falls back to file credentials when secret-tool is unavailable", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "t3os-creds-"));
    const origConfigHome = process.env.XDG_CONFIG_HOME;
    try {
      process.env.XDG_CONFIG_HOME = tempDir;
      await systemKeyring.set("HF_TOKEN", "hf_test_stored_file");
      const retrieved = await systemKeyring.get("HF_TOKEN");
      expect(retrieved).toBe("hf_test_stored_file");

      const resolver = new SecretResolver({ env: {} });
      expect(await resolver.resolve(new SecretRef("HF_TOKEN"))).toBe("hf_test_stored_file");
    } finally {
      if (origConfigHome !== undefined) {
        process.env.XDG_CONFIG_HOME = origConfigHome;
      } else {
        delete process.env.XDG_CONFIG_HOME;
      }
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
