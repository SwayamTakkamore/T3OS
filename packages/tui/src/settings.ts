import type { EffortLevel, Provider } from "@t3os/core";

export type ProviderType = "hf" | "local";

/** A partial settings change. Fields that are omitted keep their current value. */
export interface SettingsUpdate {
  model?: string;
  effort?: EffortLevel;
  provider?: ProviderType;
}

/** The full set of settings that determine which provider is active. */
export interface SettingsSnapshot {
  model: string;
  effort: EffortLevel;
  providerType: ProviderType;
}

export interface SettingsController {
  /**
   * Applies a settings update atomically.
   *
   * Updates are serialized through an internal queue and resolved against the
   * most recent requested settings, so a slow provider creation (for example a
   * Hugging Face token lookup) can never resolve after and overwrite a newer
   * one (for example a switch to the local provider).
   *
   * Resolves once the provider for the latest requested settings is in effect,
   * or rejects if creating that provider fails. In that case the previous
   * provider and committed settings are left untouched.
   */
  applySettings(update: SettingsUpdate): Promise<void>;
  /** The settings currently in effect. */
  committed(): SettingsSnapshot;
  /** The provider currently in effect. */
  provider(): Provider;
}

export interface SettingsControllerOptions {
  initial: SettingsSnapshot;
  initialProvider: Provider;
  /**
   * Creates the provider for the given settings. When omitted, the existing
   * provider is kept and only settings bookkeeping is updated.
   */
  createProvider?: (settings: SettingsSnapshot) => Promise<Provider>;
  /** Called after a successful commit. */
  onCommit?: (settings: SettingsSnapshot) => void;
}

/**
 * Owns the mutable model/effort/provider state for the REPL and guarantees that
 * `provider()` always reflects the latest committed settings.
 */
export function createSettingsController(
  options: SettingsControllerOptions
): SettingsController {
  let committed: SettingsSnapshot = { ...options.initial };
  let requested: SettingsSnapshot = { ...options.initial };
  let provider = options.initialProvider;
  let sequence = 0;
  let queue: Promise<void> = Promise.resolve();

  const applySettings = (update: SettingsUpdate): Promise<void> => {
    if (
      update.model === undefined &&
      update.effort === undefined &&
      update.provider === undefined
    ) {
      return Promise.resolve();
    }

    // Fold the update onto the most recent request. Newer requests always
    // build on the fullest known intent, so superseding an in-flight request
    // never drops part of the change.
    requested = {
      model: update.model ?? requested.model,
      effort: update.effort ?? requested.effort,
      providerType: update.provider ?? requested.providerType,
    };
    const target: SettingsSnapshot = requested;
    const mySequence = (sequence += 1);

    const run = async (): Promise<void> => {
      // A newer request arrived before this one started; it already carries
      // this update's intent, so there is nothing left to do.
      if (mySequence !== sequence) return;

      let next = provider;
      if (options.createProvider) {
        try {
          next = await options.createProvider(target);
        } catch (error) {
          if (mySequence === sequence) {
            // The latest request failed. Roll the pending request back to the
            // committed settings so later partial updates cannot inherit a
            // provider state that was never applied.
            requested = { ...committed };
            throw error;
          }
          // A superseded request failed: the newer request is authoritative.
          return;
        }
      }

      if (mySequence !== sequence) return;

      provider = next;
      committed = target;
      requested = { ...target };
      options.onCommit?.(target);
    };

    const scheduled = queue.then(run);
    // Keep the queue alive even when a request rejects.
    queue = scheduled.then(
      () => undefined,
      () => undefined
    );
    return scheduled;
  };

  return {
    applySettings,
    committed: () => ({ ...committed }),
    provider: () => provider,
  };
}
