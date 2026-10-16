import React from "react";
import { render } from "ink";
import {
  builtInTools,
  createPolicy,
  runTurn,
  type ApprovalOutcome,
  type EffortLevel,
  type PermissionMode,
  type PermissionPolicy,
  type PermissionRequest,
  type Provider,
  type SessionStore,
  type TurnEndReason,
} from "@t3os/core";
import { App, type PendingPermission } from "./App.js";
import {
  createSettingsController,
  type SettingsController,
  type SettingsSnapshot,
  type SettingsUpdate,
} from "./settings.js";
import {
  emptyTranscript,
  reduceTranscript,
  type TranscriptState,
} from "./transcript.js";

export interface ReplOptions {
  provider: Provider;
  store: SessionStore;
  sessionId: string;
  policy: PermissionPolicy;
  root: string;
  model: string;
  effort?: EffortLevel;
  providerType?: "hf" | "local";
  permissionMode?: PermissionMode;
  onTurnEnd?: (reason: TurnEndReason) => void;
  onOpenToken?: () => void;
  onUpdateProvider?: (
    newModel: string,
    newEffort: EffortLevel,
    newProviderType: "hf" | "local"
  ) => Promise<Provider>;
  onUpdatePolicy?: (newMode: PermissionMode) => PermissionPolicy;
}

export interface ReplSettingsOptions {
  provider: Provider;
  model: string;
  effort?: EffortLevel;
  providerType?: "hf" | "local";
  onUpdateProvider?: (
    newModel: string,
    newEffort: EffortLevel,
    newProviderType: "hf" | "local"
  ) => Promise<Provider>;
  onCommit?: (snapshot: SettingsSnapshot) => void;
}

/**
 * Builds the serialized settings controller backing the REPL. All model,
 * effort and provider changes flow through it, so the active provider
 * (`provider()`) always matches the latest committed settings even when
 * updates are issued concurrently.
 */
export function createReplSettings(options: ReplSettingsOptions): SettingsController {
  const createProvider = options.onUpdateProvider;
  return createSettingsController({
    initial: {
      model: options.model,
      effort: options.effort ?? "high",
      providerType: options.providerType ?? "hf",
    },
    initialProvider: options.provider,
    ...(createProvider
      ? {
          createProvider: (snapshot: SettingsSnapshot): Promise<Provider> =>
            createProvider(snapshot.model, snapshot.effort, snapshot.providerType),
        }
      : {}),
    ...(options.onCommit ? { onCommit: options.onCommit } : {}),
  });
}

export async function startRepl(options: ReplOptions): Promise<void> {
  let state: TranscriptState = emptyTranscript();
  let busy = false;
  let pending: PendingPermission | null = null;
  let resolvePermission: ((outcome: ApprovalOutcome) => void) | null = null;

  let currentPolicy = options.policy;
  let currentPermissionMode = options.permissionMode ?? "ask";

  // Single source of truth for model/effort/provider. All mutations go through
  // applySettings so concurrent changes are serialized and the active provider
  // always matches the latest settings.
  const settings = createReplSettings({
    provider: options.provider,
    model: options.model,
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.providerType ? { providerType: options.providerType } : {}),
    ...(options.onUpdateProvider ? { onUpdateProvider: options.onUpdateProvider } : {}),
  });

  /**
   * Awaits a settings update and redraws. Resolves only when the provider for
   * the requested settings is active; rejects (without disturbing the active
   * provider) when provider creation fails.
   */
  const applySettings = async (update: SettingsUpdate): Promise<void> => {
    try {
      await settings.applySettings(update);
    } finally {
      draw();
    }
  };

  const view = (): React.ReactElement => {
    const snapshot = settings.committed();
    return React.createElement(App, {
      state,
      model: snapshot.model,
      effort: snapshot.effort,
      permissionMode: currentPermissionMode,
      providerType: snapshot.providerType,
      busy,
      permission: pending,
      onSubmit: (text: string) => {
        void turn(text);
      },
      onPermission: (outcome: ApprovalOutcome) => {
        const resolve = resolvePermission;
        pending = null;
        resolvePermission = null;
        if (resolve) resolve(outcome);
        else draw();
      },
      onClear: () => {
        state = emptyTranscript();
        draw();
      },
      onChangeSettings: applySettings,
      onChangeModel: (newModel: string) => applySettings({ model: newModel }),
      onChangeEffort: (newEffort: EffortLevel) => applySettings({ effort: newEffort }),
      onChangeProvider: (newType: "hf" | "local") =>
        applySettings({ provider: newType }),
      onChangePermissionMode: (newMode: PermissionMode) => {
        currentPermissionMode = newMode;
        if (options.onUpdatePolicy) {
          currentPolicy = options.onUpdatePolicy(newMode);
        } else {
          currentPolicy = createPolicy(newMode);
        }
        draw();
      },
      ...(options.onOpenToken ? { onOpenToken: options.onOpenToken } : {}),
    });
  };

  const draw = (): void => {
    instance.rerender(view());
  };

  const instance = render(view());

  async function turn(text: string): Promise<void> {
    busy = true;
    state = reduceTranscript(state, { type: "user_message", text });
    draw();
    const result = await runTurn({
      provider: settings.provider(),
      store: options.store,
      sessionId: options.sessionId,
      policy: currentPolicy,
      root: options.root,
      tools: builtInTools(),
      onEvent: (event) => {
        state = reduceTranscript(state, event);
        draw();
      },
      onPermission: (request: PermissionRequest, id: string) =>
        new Promise<ApprovalOutcome>((resolve) => {
          pending = { request, id };
          resolvePermission = resolve;
          draw();
        }),
    });
    busy = false;
    draw();
    options.onTurnEnd?.(result.reason);
  }

  await instance.waitUntilExit();
}
