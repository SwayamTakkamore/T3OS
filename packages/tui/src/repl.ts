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

export async function startRepl(options: ReplOptions): Promise<void> {
  let state: TranscriptState = emptyTranscript();
  let busy = false;
  let pending: PendingPermission | null = null;
  let resolvePermission: ((outcome: ApprovalOutcome) => void) | null = null;

  let currentProvider = options.provider;
  let currentPolicy = options.policy;
  let currentModel = options.model;
  let currentEffort = options.effort ?? "high";
  let currentPermissionMode = options.permissionMode ?? "ask";
  let currentProviderType = options.providerType ?? "hf";

  const view = (): React.ReactElement =>
    React.createElement(App, {
      state,
      model: currentModel,
      effort: currentEffort,
      permissionMode: currentPermissionMode,
      providerType: currentProviderType,
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
      onChangeModel: async (newModel: string) => {
        currentModel = newModel;
        if (options.onUpdateProvider) {
          try {
            currentProvider = await options.onUpdateProvider(
              currentModel,
              currentEffort,
              currentProviderType
            );
          } catch {
            // Keep existing provider if re-creation fails
          }
        }
        draw();
      },
      onChangeEffort: async (newEffort: EffortLevel) => {
        currentEffort = newEffort;
        if (options.onUpdateProvider) {
          try {
            currentProvider = await options.onUpdateProvider(
              currentModel,
              currentEffort,
              currentProviderType
            );
          } catch {
            // Keep existing provider if re-creation fails
          }
        }
        draw();
      },
      onChangeProvider: async (newType: "hf" | "local") => {
        currentProviderType = newType;
        if (options.onUpdateProvider) {
          try {
            currentProvider = await options.onUpdateProvider(
              currentModel,
              currentEffort,
              currentProviderType
            );
          } catch {
            // Keep existing provider if re-creation fails
          }
        }
        draw();
      },
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

  const draw = (): void => {
    instance.rerender(view());
  };

  const instance = render(view());

  async function turn(text: string): Promise<void> {
    busy = true;
    state = reduceTranscript(state, { type: "user_message", text });
    draw();
    const result = await runTurn({
      provider: currentProvider,
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
