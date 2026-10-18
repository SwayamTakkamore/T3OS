import React from "react";
import { render } from "ink";
import {
  builtInTools,
  createPolicy,
  runTurn,
  saveLastSettings,
  type AgentEvent,
  type ApprovalOutcome,
  type EffortLevel,
  type PermissionMode,
  type PermissionPolicy,
  type PermissionRequest,
  type Provider,
  type SessionBackup,
  type SessionMeta,
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

/** Folds a persisted event stream back into a rendered transcript state. */
export function transcriptFromEvents(events: AgentEvent[]): TranscriptState {
  return events.reduce(
    (acc, event) => reduceTranscript(acc, event),
    emptyTranscript()
  );
}

export async function startRepl(options: ReplOptions): Promise<void> {
  let state: TranscriptState = emptyTranscript();
  let busy = false;
  let pending: PendingPermission | null = null;
  let resolvePermission: ((outcome: ApprovalOutcome) => void) | null = null;
  let currentAbortController: AbortController | null = null;

  // The active session can change while the REPL runs (switch / new / restore).
  let sessionId = options.sessionId;
  let sessions: SessionMeta[] = [];
  let backups: SessionBackup[] = [];

  let currentPolicy = options.policy;
  let currentPermissionMode = options.permissionMode ?? "ask";

  /**
   * Persists the committed settings both to the active session header (so
   * resuming restores them) and to the project config (so the last chosen
   * model/effort/provider/permission mode survive restarts).
   */
  async function persistSettings(snapshot: SettingsSnapshot): Promise<void> {
    const projectSettings = {
      model: snapshot.model,
      effort: snapshot.effort,
      provider: snapshot.providerType,
      permissionMode: currentPermissionMode,
    };
    await Promise.allSettled([
      options.store.updateSettings(sessionId, projectSettings),
      saveLastSettings(options.root, projectSettings),
    ]);
  }

  // Single source of truth for model/effort/provider. All mutations go through
  // applySettings so concurrent changes are serialized and the active provider
  // always matches the latest settings.
  const settings = createReplSettings({
    provider: options.provider,
    model: options.model,
    ...(options.effort ? { effort: options.effort } : {}),
    ...(options.providerType ? { providerType: options.providerType } : {}),
    ...(options.onUpdateProvider ? { onUpdateProvider: options.onUpdateProvider } : {}),
    onCommit: (snapshot: SettingsSnapshot) => {
      void persistSettings(snapshot);
    },
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

  /** Reloads the session/backup lists and redraws so the palette stays fresh. */
  async function refreshSessions(): Promise<void> {
    const [sessionList, backupList] = await Promise.all([
      options.store.list().catch((): SessionMeta[] => []),
      options.store.listBackups().catch((): SessionBackup[] => []),
    ]);
    sessions = sessionList;
    backups = backupList;
    draw();
  }

  /** Starts a fresh session seeded with the currently active settings. */
  async function newSession(): Promise<string> {
    const snapshot = settings.committed();
    const meta = await options.store.create("tui", {
      model: snapshot.model,
      effort: snapshot.effort,
      provider: snapshot.providerType,
      permissionMode: currentPermissionMode,
    });
    sessionId = meta.id;
    state = emptyTranscript();
    draw();
    await persistSettings(snapshot);
    await refreshSessions();
    return `Started new session ${meta.id}`;
  }

  /**
   * Resumes a session: replays its transcript, restores its preserved settings
   * (including permission mode) and switches the active provider accordingly.
   */
  async function switchSession(id: string): Promise<string> {
    const meta = await options.store.getMeta(id);
    if (!meta) return `✖ Session ${id} not found`;

    sessionId = id;
    state = transcriptFromEvents(await options.store.replay(id));

    if (meta.settings?.permissionMode) {
      currentPermissionMode = meta.settings.permissionMode;
    }
    currentPolicy = options.onUpdatePolicy
      ? options.onUpdatePolicy(currentPermissionMode)
      : createPolicy(currentPermissionMode);
    draw();

    const restored = meta.settings;
    if (restored && (restored.model || restored.effort || restored.provider)) {
      try {
        await settings.applySettings({
          ...(restored.model ? { model: restored.model } : {}),
          ...(restored.effort ? { effort: restored.effort } : {}),
          ...(restored.provider ? { provider: restored.provider } : {}),
        });
      } catch {
        // Keep the previously active provider when the restored one cannot start.
      }
    }

    draw();
    await refreshSessions();
    return `Resumed session ${id} (${meta.eventCount} events)`;
  }

  /** Backs up the active session and reports the backup path. */
  async function backupSession(): Promise<string> {
    const result = await options.store.backup(sessionId);
    await refreshSessions();
    return `✓ Backed up session to ${result.backupPath}`;
  }

  /**
   * Deletes a session. When the active session is deleted we fall back to the
   * most recent remaining session, or start a new one when none are left.
   */
  async function deleteSession(id: string): Promise<string> {
    await options.store.delete(id);
    if (id === sessionId) {
      const remaining = await options.store.list().catch((): SessionMeta[] => []);
      if (remaining.length > 0) {
        await switchSession(remaining[0]!.id);
      } else {
        return await newSession();
      }
    }
    await refreshSessions();
    return `Deleted session ${id}`;
  }

  /** Restores a backup into a new session and switches to it. */
  async function restoreBackup(backupPath: string): Promise<string> {
    const restored = await options.store.restoreBackup(backupPath);
    const message = await switchSession(restored.id);
    return `Restored backup into ${restored.id}. ${message}`;
  }

  const view = (): React.ReactElement => {
    const snapshot = settings.committed();
    return React.createElement(App, {
      state,
      model: snapshot.model,
      effort: snapshot.effort,
      permissionMode: currentPermissionMode,
      providerType: snapshot.providerType,
      sessionId,
      sessions,
      backups,
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
      onCancel: () => {
        currentAbortController?.abort();
        if (resolvePermission) {
          const resolve = resolvePermission;
          pending = null;
          resolvePermission = null;
          resolve("deny");
        }
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
        void persistSettings(settings.committed());
        draw();
      },
      onNewSession: () => newSession(),
      onSwitchSession: (id: string) => switchSession(id),
      onDeleteSession: (id: string) => deleteSession(id),
      onBackupSession: () => backupSession(),
      onRestoreBackup: (path: string) => restoreBackup(path),
      ...(options.onOpenToken ? { onOpenToken: options.onOpenToken } : {}),
    });
  };

  const draw = (): void => {
    instance.rerender(view());
  };

  const instance = render(view());

  // Seed the session lists so the palette is populated on first open.
  void refreshSessions();

  async function turn(text: string): Promise<void> {
    busy = true;
    currentAbortController = new AbortController();
    draw();
    try {
      const result = await runTurn({
        provider: settings.provider(),
        store: options.store,
        sessionId,
        policy: currentPolicy,
        root: options.root,
        tools: builtInTools(),
        prompt: text,
        signal: currentAbortController.signal,
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
      options.onTurnEnd?.(result.reason);
    } finally {
      busy = false;
      currentAbortController = null;
      draw();
    }
  }

  await instance.waitUntilExit();
}
