import {
  HuggingFaceProvider,
  LocalProvider,
  SecretRef,
  SecretResolver,
  T3osError,
  resolvePreset,
  type EffortLevel,
  type Keyring,
  type Provider,
} from "@t3os/core";

export interface ProviderFactoryDeps {
  /** Environment consulted for `HF_TOKEN`; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Keyring consulted before `env`; defaults to the system keyring. */
  keyring?: Keyring;
}

/**
 * Builds the provider for the given model/effort/provider kind.
 *
 * The Hugging Face token is resolved for **both** provider kinds: gated models
 * (e.g. Gemma) require an authenticated request even for local inference, and
 * `@huggingface/transformers` reads `process.env.HF_TOKEN` when fetching files
 * from the Hugging Face Hub.
 */
export async function makeProvider(
  modelId: string,
  effort: EffortLevel,
  providerType: "hf" | "local",
  deps: ProviderFactoryDeps = {}
): Promise<Provider> {
  const env = deps.env ?? process.env;
  const resolved = resolvePreset(modelId, effort);
  const token = await new SecretResolver({ env, keyring: deps.keyring }).resolve(
    new SecretRef("HF_TOKEN")
  );
  if (token) {
    process.env.HF_TOKEN = token;
  }

  if (providerType === "local") {
    return new LocalProvider({ modelId: resolved.id, token });
  }

  if (!token) {
    throw new T3osError(
      "config",
      "HF_TOKEN is not set; run `t3os auth login` or `t3os auth set <token>`"
    );
  }
  return new HuggingFaceProvider({
    model: resolved.id,
    token,
    contextLength: resolved.contextLength,
  });
}
