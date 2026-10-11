import React from "react";
import { render } from "ink";
import {
  builtInTools,
  runTurn,
  type ApprovalOutcome,
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
  onTurnEnd?: (reason: TurnEndReason) => void;
  onOpenToken?: () => void;
}

export async function startRepl(options: ReplOptions): Promise<void> {
  let state: TranscriptState = emptyTranscript();
  let busy = false;
  let pending: PendingPermission | null = null;
  let resolvePermission: ((outcome: ApprovalOutcome) => void) | null = null;

  const view = (): React.ReactElement =>
    React.createElement(App, {
      state,
      model: options.model,
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
      provider: options.provider,
      store: options.store,
      sessionId: options.sessionId,
      policy: options.policy,
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
