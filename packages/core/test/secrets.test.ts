import { describe, expect, it } from "vitest";
import { SecretRef, SecretResolver } from "../src/config/secrets.js";

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
});