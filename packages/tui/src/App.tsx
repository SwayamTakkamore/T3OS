import React, { useEffect, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  GEMMA_PRESETS,
  checkLocalModelInstalled,
  getModelEstimatedSize,
  installLocalModel,
  renderProgressBar,
  resolveLocalModelId,
  type ApprovalOutcome,
  type DownloadProgress,
  type EffortLevel,
  type LocalModelStatus,
  type PermissionMode,
  type PermissionRequest,
  type SessionBackup,
  type SessionMeta,
} from "@t3os/core";
import type { SettingsUpdate } from "./settings.js";
import type { TranscriptState } from "./transcript.js";

export interface PendingPermission {
  request: PermissionRequest;
  id: string;
}

export type SettingsMenuType =
  | "main"
  | "model"
  | "effort"
  | "permission"
  | "provider"
  | "auth"
  | "sessions"
  | "sessions-switch"
  | "sessions-restore"
  | "opencode"
  | "check-model"
  | "check-model-select";

export interface MenuItem {
  label: string;
  value?: string;
  active?: boolean;
  /** Optional section header rendered above the first item of each group. */
  section?: string;
  action: () => void;
}

/** Cached result of the most recent local-cache check for a model. */
interface ModelCheckState {
  model: string;
  loading: boolean;
  status: LocalModelStatus | null;
  error: string | null;
}

export interface AppProps {
  state: TranscriptState;
  model: string;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  providerType?: "hf" | "local";
  onSubmit: (text: string) => void;
  busy?: boolean;
  permission?: PendingPermission | null;
  onPermission: (outcome: ApprovalOutcome) => void;
  onOpenToken?: () => void;
  onClear?: () => void;
  /**
   * Applies model/effort/provider changes atomically and serialized. Preferred
   * over the granular callbacks below because it cannot race: awaiting it
   * guarantees the active provider matches the requested settings, and a
   * rejection means the change was not applied.
   */
  onChangeSettings?: (update: SettingsUpdate) => Promise<void>;
  onChangeModel?: (model: string) => void | Promise<void>;
  onChangeEffort?: (effort: EffortLevel) => void | Promise<void>;
  onChangePermissionMode?: (mode: PermissionMode) => void;
  onChangeProvider?: (provider: "hf" | "local") => void | Promise<void>;
  onCheckModelInstalled?: (model: string) => Promise<boolean>;
  onInstallModel?: (model: string, onProgress: (progress: DownloadProgress) => void, signal?: AbortSignal) => Promise<boolean>;
  /** Active session id, surfaced in the header and the Sessions menu. */
  sessionId?: string;
  /** Available sessions (newest first) for the Switch/Resume submenu. */
  sessions?: SessionMeta[];
  /** Available backups for the Restore submenu. */
  backups?: SessionBackup[];
  /** Start a brand-new session and switch to it. */
  onNewSession?: () => SessionActionResult;
  /** Switch to (resume) an existing session by id. */
  onSwitchSession?: (id: string) => SessionActionResult;
  /** Delete a session by id (from the Switch/Resume list). */
  onDeleteSession?: (id: string) => SessionActionResult;
  /** Back up the active session; may resolve to a status message. */
  onBackupSession?: () => SessionActionResult;
  /** Restore a session from a backup path. */
  onRestoreBackup?: (backupPath: string) => SessionActionResult;
}

/** A session callback may resolve to a status string shown in the palette. */
export type SessionActionResult = void | string | Promise<void | string>;

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Human-friendly timestamp for session/backup lists. */
function formatSessionTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").slice(0, 16);
}

function providerLabel(provider?: "hf" | "local"): string {
  return provider === "local" ? "Local" : "Cloud";
}

function shortModel(model?: string): string {
  if (!model) return "?";
  const parts = model.split("/");
  return parts[parts.length - 1] ?? model;
}

export function App({
  state,
  model,
  effort = "high",
  permissionMode = "ask",
  providerType = "hf",
  onSubmit,
  busy = false,
  permission = null,
  onPermission,
  onOpenToken,
  onClear,
  onChangeModel,
  onChangeEffort,
  onChangePermissionMode,
  onChangeProvider,
  onChangeSettings,
  onCheckModelInstalled,
  onInstallModel,
  sessionId,
  sessions,
  backups,
  onNewSession,
  onSwitchSession,
  onDeleteSession,
  onBackupSession,
  onRestoreBackup,
}: AppProps): React.ReactElement {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const { exit } = useApp();

  // Settings Palette State
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [currentMenu, setCurrentMenu] = useState<SettingsMenuType>("main");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  // Session id awaiting a second Ctrl+D press before actually deleting.
  const [confirmDeleteSessionId, setConfirmDeleteSessionId] = useState<string | null>(null);

  // Switching menus cancels any pending session-delete confirmation.
  useEffect(() => {
    setConfirmDeleteSessionId(null);
  }, [currentMenu]);

  const [activeModel, setActiveModel] = useState<string>(model);
  const [activeEffort, setActiveEffort] = useState<EffortLevel>(effort);
  const [activePermissionMode, setActivePermissionMode] = useState<PermissionMode>(permissionMode);
  const [activeProviderType, setActiveProviderType] = useState<"hf" | "local">(providerType);

  // Local Model Switch & Install Dialog state
  const [localDialogStep, setLocalDialogStep] = useState<
    "none" | "confirm" | "ask_install" | "downloading" | "confirm_cancel"
  >("none");
  const [pendingLocalModel, setPendingLocalModel] = useState<string>("");
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const downloadAbortControllerRef = React.useRef<AbortController | null>(null);
  const [spinnerIndex, setSpinnerIndex] = useState(0);
  /** While a download runs, controls whether the animated download view is
   * shown or the download simply continues in the background (banner only). */
  const [downloadViewVisible, setDownloadViewVisible] = useState(true);

  // Check Model state (Settings Palette ▸ T3 Engine ▸ Check Model)
  const [modelToCheck, setModelToCheck] = useState<string>("");
  const [checkState, setCheckState] = useState<ModelCheckState | null>(null);
  const checkSeqRef = React.useRef(0);

  /** Model inspected by the Check Model view: explicit selection first, then
   * any in-flight download target, then the active model. */
  const checkTarget = modelToCheck || pendingLocalModel || activeModel;

  React.useEffect(() => {
    if (localDialogStep !== "downloading") return;
    const timer = setInterval(() => {
      setSpinnerIndex((prev) => (prev + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, [localDialogStep]);

  // Sync props if changed externally
  React.useEffect(() => {
    setActiveModel(model);
    setModelToCheck("");
  }, [model]);
  React.useEffect(() => {
    setActiveEffort(effort);
  }, [effort]);
  React.useEffect(() => {
    setActivePermissionMode(permissionMode);
  }, [permissionMode]);
  React.useEffect(() => {
    setActiveProviderType(providerType);
  }, [providerType]);

  /**
   * Checks whether `target` is present in the local model cache and stores the
   * result (installed flag, cache path, details) for the Check Model view and
   * the main-menu status value. The host-provided `onCheckModelInstalled`
   * verdict wins over the filesystem probe when present.
   */
  const runCheck = async (target: string): Promise<void> => {
    const seq = ++checkSeqRef.current;
    setCheckState({ model: target, loading: true, status: null, error: null });
    try {
      const status = await checkLocalModelInstalled(target);
      // A directory that exists but lacks usable weights is "incomplete", not
      // installed. Only the pure filesystem probe carries that nuance — when a
      // host verdict overrides the probe, its verdict wins outright.
      const fsIncomplete = !status.isInstalled && status.incomplete === true;
      const installed = onCheckModelInstalled
        ? await onCheckModelInstalled(target)
        : status.isInstalled;
      if (seq !== checkSeqRef.current) return;
      setCheckState({
        model: target,
        loading: false,
        status: {
          ...status,
          isInstalled: installed,
          incomplete: onCheckModelInstalled ? false : fsIncomplete,
          details: installed
            ? status.isInstalled
              ? status.details ?? "Present in local cache"
              : "Verified in local cache"
            : fsIncomplete && !onCheckModelInstalled
              ? status.details ?? "Model not found in local cache"
              : "Model not found in local cache",
        },
        error: null,
      });
    } catch (err) {
      if (seq !== checkSeqRef.current) return;
      setCheckState({
        model: target,
        loading: false,
        status: null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // Keep the Check Model status fresh for the active model (also priming the
  // main-menu "Check Model" row before the submenu is ever opened).
  React.useEffect(() => {
    void runCheck(model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [model]);

  const initiateLocalModelSwitch = (targetModel: string) => {
    setPendingLocalModel(targetModel);
    setModelToCheck("");
    setLocalDialogStep("confirm");
    setIsSettingsOpen(false);
  };

  /**
   * Applies a settings change atomically (via `onChangeSettings` when
   * available) and reflects it in the header optimistically. If the change
   * fails, the optimistic state is reverted to the last committed props so the
   * UI never shows a provider that is not actually active, and the error is
   * surfaced through `statusMessage`.
   *
   * Returns `true` when the change was applied.
   */
  const applySettingsChange = async (
    update: SettingsUpdate,
    failureContext: string,
  ): Promise<boolean> => {
    if (update.provider !== undefined) setActiveProviderType(update.provider);
    if (update.model !== undefined) setActiveModel(update.model);
    if (update.effort !== undefined) setActiveEffort(update.effort);

    try {
      if (onChangeSettings) {
        await onChangeSettings(update);
      } else {
        // Legacy fallback: apply strictly in sequence so no callback ever
        // observes a half-updated (and therefore stale) provider state.
        if (update.model !== undefined) await onChangeModel?.(update.model);
        if (update.effort !== undefined) await onChangeEffort?.(update.effort);
        if (update.provider !== undefined) await onChangeProvider?.(update.provider);
      }
      return true;
    } catch (err) {
      setActiveProviderType(providerType);
      setActiveModel(model);
      setActiveEffort(effort);
      const detail = err instanceof Error ? err.message : String(err);
      setStatusMessage(`✖ ${failureContext}: ${detail}`);
      return false;
    }
  };

  /** Builds the atomic update for a switch to local mode, including the model
   * only when it actually changes. */
  const localSwitchUpdate = (target: string): SettingsUpdate =>
    target === activeModel ? { provider: "local" } : { provider: "local", model: target };

  const handleConfirmSwitchToLocal = async () => {
    const target = pendingLocalModel || activeModel;
    setStatusMessage(`Checking local installation for ${target}…`);

    const isInstalled = onCheckModelInstalled
      ? await onCheckModelInstalled(target)
      : (await checkLocalModelInstalled(target)).isInstalled;

    if (isInstalled) {
      setLocalDialogStep("none");
      const applied = await applySettingsChange(
        localSwitchUpdate(target),
        `Failed to switch ${target} to local mode`,
      );
      if (applied) {
        setStatusMessage(`✓ Local model ${target} is installed. Switched to local mode.`);
      }
    } else {
      setLocalDialogStep("ask_install");
    }
  };

  /**
   * Starts downloading/installing the Check-Model target.
   *
   * @param fromPalette When the install was triggered from inside the Check
   * Model view, the palette stays open and progress is rendered inline;
   * otherwise the standalone animated download overlay takes over the screen.
   */
  const handleConfirmInstall = async (fromPalette = false) => {
    const target = checkTarget;
    setPendingLocalModel(target);
    setLocalDialogStep("downloading");
    setDownloadViewVisible(!fromPalette);
    setDownloadProgress(null);

    const controller = new AbortController();
    downloadAbortControllerRef.current = controller;

    try {
      let success = false;
      if (onInstallModel) {
        success = await onInstallModel(
          target,
          (prog) => setDownloadProgress(prog),
          controller.signal,
        );
      } else {
        const result = await installLocalModel(target, {
          onProgress: (prog) => setDownloadProgress(prog),
          signal: controller.signal,
        });
        success = result.success;
        if (!success && result.error && !controller.signal.aborted) {
          throw new Error(result.error);
        }
      }

      if (controller.signal.aborted) {
        setLocalDialogStep("none");
        setDownloadViewVisible(true);
        setStatusMessage("✖ Download cancelled. Remaining on Cloud.");
        void runCheck(target);
        return;
      }

      if (success) {
        const verification = await checkLocalModelInstalled(target);
        const resolvedPath = verification.path || "configured";
        setLocalDialogStep("none");
        setDownloadViewVisible(true);
        const applied = await applySettingsChange(
          localSwitchUpdate(target),
          `Model ${target} downloaded, but switching to local mode failed`,
        );
        if (applied) {
          setStatusMessage(`✓ Local ONNX model ${resolveLocalModelId(target)} downloaded and path set (${resolvedPath}). Switched to local mode.`);
        }
        void runCheck(target);
      } else {
        setLocalDialogStep("none");
        setDownloadViewVisible(true);
        setStatusMessage(`✖ Installation of ${target} failed.`);
        void runCheck(target);
      }
    } catch (err) {
      setLocalDialogStep("none");
      setDownloadViewVisible(true);
      if (controller.signal.aborted) {
        setStatusMessage("✖ Download cancelled. Remaining on Cloud.");
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        setStatusMessage(`✖ Installation failed: ${errorMsg}`);
      }
      void runCheck(target);
    } finally {
      downloadAbortControllerRef.current = null;
    }
  };

  // Build menu items based on current menu
  /**
   * Runs an async session action (new/switch/backup/restore) and surfaces its
   * result (or failure) as a palette status message.
   */
  const runSessionAction = (
    fallbackMessage: string,
    action?: () => SessionActionResult,
  ): void => {
    if (!action) return;
    void (async () => {
      try {
        const result = await action();
        setStatusMessage(typeof result === "string" ? result : fallbackMessage);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        setStatusMessage(`✖ Session action failed: ${detail}`);
      }
    })();
  };

  const getMenuItems = (): MenuItem[] => {
    if (currentMenu === "model") {
      const items: MenuItem[] = GEMMA_PRESETS.map((preset) => {
        let gen = "Gemma 2";
        if (preset.id.includes("gemma-4")) gen = "Gemma 4";
        else if (preset.id.includes("gemma-3")) gen = "Gemma 3";
        return {
          label: `[${gen}] ${preset.id}`,
          value: `${preset.contextLength} ctx`,
          active: preset.id === activeModel,
          action: () => {
            if (activeProviderType === "local") {
              initiateLocalModelSwitch(preset.id);
              return;
            }
            setCurrentMenu("main");
            setSelectedIndex(0);
            void applySettingsChange(
              { model: preset.id },
              `Failed to switch model to ${preset.id}`,
            ).then((applied) => {
              if (applied) setStatusMessage(`Model updated to ${preset.id}`);
            });
          },
        };
      });
      items.push({
        label: "← Back to Main Menu",
        action: () => {
          setCurrentMenu("main");
          setSelectedIndex(0);
        },
      });
      return items;
    }

    if (currentMenu === "effort") {
      const effortOptions: Array<{ level: EffortLevel; label: string; desc: string }> = [
        { level: "low", label: "Low", desc: "0.2 temp • concise (50% max tokens)" },
        { level: "medium", label: "Medium", desc: "0.7 temp • balanced (100% max tokens)" },
        { level: "high", label: "High", desc: "0.8 temp • thorough (150% max tokens)" },
        { level: "max", label: "Max", desc: "0.9 temp • extended reasoning (200% max tokens)" },
      ];
      const items: MenuItem[] = effortOptions.map((opt) => ({
        label: opt.label,
        value: opt.desc,
        active: opt.level === activeEffort,
        action: () => {
          setCurrentMenu("main");
          setSelectedIndex(1);
          void applySettingsChange(
            { effort: opt.level },
            `Failed to set effort profile to ${opt.level}`,
          ).then((applied) => {
            if (applied) setStatusMessage(`Effort profile set to ${opt.level}`);
          });
        },
      }));
      items.push({
        label: "← Back to Main Menu",
        action: () => {
          setCurrentMenu("main");
          setSelectedIndex(1);
        },
      });
      return items;
    }

    if (currentMenu === "permission") {
      const permOptions: Array<{ mode: PermissionMode; label: string; desc: string }> = [
        { mode: "ask", label: "Ask", desc: "Prompt confirmation before risky actions" },
        { mode: "auto-accept", label: "Auto-Accept", desc: "Automatically execute tools without asking" },
        { mode: "read-only", label: "Read-Only", desc: "Block filesystem writes & commands" },
      ];
      const items: MenuItem[] = permOptions.map((opt) => ({
        label: opt.label,
        value: opt.desc,
        active: opt.mode === activePermissionMode,
        action: () => {
          setActivePermissionMode(opt.mode);
          onChangePermissionMode?.(opt.mode);
          setStatusMessage(`Permission mode set to ${opt.mode}`);
          setCurrentMenu("main");
          setSelectedIndex(2);
        },
      }));
      items.push({
        label: "← Back to Main Menu",
        action: () => {
          setCurrentMenu("main");
          setSelectedIndex(2);
        },
      });
      return items;
    }

    if (currentMenu === "provider") {
      const providerOptions: Array<{ type: "hf" | "local"; label: string; desc: string }> = [
        { type: "hf", label: "Hugging Face (Cloud)", desc: "Inference API using HF_TOKEN" },
        { type: "local", label: "Hugging Face (Local)", desc: "@huggingface/transformers ONNX engine" },
      ];
      const items: MenuItem[] = providerOptions.map((opt) => ({
        label: opt.label,
        value: opt.desc,
        active: opt.type === activeProviderType,
        action: () => {
          if (opt.type === "local") {
            initiateLocalModelSwitch(activeModel);
            return;
          }
          setCurrentMenu("main");
          setSelectedIndex(3);
          void applySettingsChange(
            { provider: "hf" },
            "Failed to switch to Hugging Face (Cloud)",
          ).then((applied) => {
            if (applied) setStatusMessage("Provider set to Hugging Face (Cloud)");
          });
        },
      }));
      items.push({
        label: "← Back to Main Menu",
        action: () => {
          setCurrentMenu("main");
          setSelectedIndex(3);
        },
      });
      return items;
    }

    if (currentMenu === "opencode") {
      const infoItems: Array<{ label: string; value: string }> = [
        { label: "Target Model", value: "opencode/big-pickle" },
        { label: "Provider Instance", value: "OpenCode (Local & Remote)" },
        { label: "Reasoning Profile", value: "High / Extra High" },
        { label: "Auto-Delegation", value: "Enabled (Task Orchestrator)" },
      ];
      const items: MenuItem[] = infoItems.map((info) => ({
        label: info.label,
        value: info.value,
        action: () => {},
      }));
      items.push({
        label: "← Back to Main Menu",
        action: () => {
          setCurrentMenu("main");
          setSelectedIndex(5);
        },
      });
      return items;
    }

    if (currentMenu === "check-model") {
      const target = checkTarget;
      const isDownloading =
        localDialogStep === "downloading" && pendingLocalModel === target;
      const isChecked = checkState?.model === target && !checkState.loading;
      const installed = isChecked && (checkState?.status?.isInstalled ?? false);

      const items: MenuItem[] = [];
      if (isDownloading) {
        items.push({
          label: "Cancel Download",
          value: `${downloadProgress?.percent ?? 0}% complete — confirm first`,
          action: () => {
            setLocalDialogStep("confirm_cancel");
          },
        });
      } else if (!isChecked) {
        // Check in flight: only safe actions are offered until it resolves.
      } else if (!installed) {
        const incomplete = checkState?.status?.incomplete === true;
        items.push({
          label: incomplete ? "Download & Complete Installation" : "Download & Install Model",
          value: getModelEstimatedSize(target),
          action: () => {
            void handleConfirmInstall(true);
          },
        });
      } else if (activeProviderType !== "local") {
        items.push({
          label: "Switch Provider to Local Mode",
          value: "currently Cloud",
          action: () => {
            initiateLocalModelSwitch(target);
          },
        });
      }
      items.push({
        label: "Re-check Local Cache",
        value: "refresh",
        action: () => {
          void runCheck(target);
        },
      });
      items.push({
        label: "Check Different Model",
        value: `${GEMMA_PRESETS.length} presets`,
        action: () => {
          setCurrentMenu("check-model-select");
          setSelectedIndex(0);
        },
      });
      items.push({
        label: "← Back to Main Menu",
        action: () => {
          setCurrentMenu("main");
          setSelectedIndex(4);
        },
      });
      return items;
    }

    if (currentMenu === "check-model-select") {
      const items: MenuItem[] = GEMMA_PRESETS.map((preset) => {
        let gen = "Gemma 2";
        if (preset.id.includes("gemma-4")) gen = "Gemma 4";
        else if (preset.id.includes("gemma-3")) gen = "Gemma 3";
        return {
          label: `[${gen}] ${preset.id}`,
          value: getModelEstimatedSize(preset.id),
          active: preset.id === checkTarget,
          action: () => {
            setModelToCheck(preset.id);
            setCurrentMenu("check-model");
            setSelectedIndex(0);
            void runCheck(preset.id);
          },
        };
      });
      items.push({
        label: "← Back to Check Model",
        action: () => {
          setCurrentMenu("check-model");
          setSelectedIndex(0);
        },
      });
      return items;
    }

    if (currentMenu === "auth") {
      return [
        {
          label: "Open HF Token Webpage in Browser",
          value: "https://huggingface.co/settings/tokens",
          action: () => {
            onOpenToken?.();
            setStatusMessage("Opening Hugging Face tokens page in browser…");
          },
        },
        {
          label: "← Back to Main Menu",
          action: () => {
            setCurrentMenu("main");
            setSelectedIndex(6);
          },
        },
      ];
    }

    if (currentMenu === "sessions") {
      return [
        {
          label: "Current Session",
          value: sessionId ?? "(none)",
          action: () => {
            setStatusMessage(
              sessionId ? `Active session: ${sessionId}` : "No active session",
            );
          },
        },
        {
          label: "New Session",
          value: "fresh transcript",
          action: () => {
            runSessionAction("Started a new session", onNewSession);
          },
        },
        {
          label: "Switch / Resume Session",
          value: `${sessions?.length ?? 0} available`,
          action: () => {
            setCurrentMenu("sessions-switch");
            setSelectedIndex(0);
          },
        },
        {
          label: "Backup Current Session",
          value: "export",
          action: () => {
            runSessionAction("Session backed up", onBackupSession);
          },
        },
        {
          label: "Restore Session Backup",
          value: `${backups?.length ?? 0} available`,
          action: () => {
            if (!backups || backups.length === 0) {
              setStatusMessage("⚠ No session backups found");
              return;
            }
            setCurrentMenu("sessions-restore");
            setSelectedIndex(0);
          },
        },
        {
          label: "← Back to Main Menu",
          action: () => {
            setCurrentMenu("main");
            setSelectedIndex(7);
          },
        },
      ];
    }

    if (currentMenu === "sessions-switch") {
      const items: MenuItem[] = (sessions ?? []).map((session) => ({
        label: session.title,
        value: `${shortModel(session.settings?.model)} · ${providerLabel(session.settings?.provider)} · ${formatSessionTime(session.updatedAt)}`,
        active: session.id === sessionId,
        action: () => {
          setCurrentMenu("main");
          setSelectedIndex(7);
          runSessionAction(
            `Resumed session ${session.id}`,
            () => onSwitchSession?.(session.id),
          );
        },
      }));
      items.push({
        label: "← Back to Sessions",
        action: () => {
          setCurrentMenu("sessions");
          setSelectedIndex(0);
        },
      });
      return items;
    }

    if (currentMenu === "sessions-restore") {
      const items: MenuItem[] = (backups ?? []).map((backup) => ({
        label: backup.id,
        value: formatSessionTime(backup.createdAt),
        action: () => {
          setCurrentMenu("main");
          setSelectedIndex(7);
          runSessionAction(
            `Restored backup ${backup.id}`,
            () => onRestoreBackup?.(backup.backupPath),
          );
        },
      }));
      items.push({
        label: "← Back to Sessions",
        action: () => {
          setCurrentMenu("sessions");
          setSelectedIndex(4);
        },
      });
      return items;
    }

    // Default: Main Menu — grouped into sections (headers rendered between
    // groups; navigation still moves only over the items themselves).
    return [
      {
        section: "T3 Engine",
        label: "Model Selection",
        value: activeModel,
        action: () => {
          setCurrentMenu("model");
          setSelectedIndex(0);
        },
      },
      {
        section: "T3 Engine",
        label: "Effort & Reasoning",
        value: activeEffort,
        action: () => {
          setCurrentMenu("effort");
          setSelectedIndex(0);
        },
      },
      {
        section: "T3 Engine",
        label: "Permission Policy",
        value: activePermissionMode,
        action: () => {
          setCurrentMenu("permission");
          setSelectedIndex(0);
        },
      },
      {
        section: "T3 Engine",
        label: "AI Provider",
        value: activeProviderType === "local" ? "Hugging Face (Local)" : "Hugging Face (Cloud)",
        action: () => {
          setCurrentMenu("provider");
          setSelectedIndex(0);
        },
      },
      {
        section: "T3 Engine",
        label: "Check Model",
        value: (() => {
          if (localDialogStep === "downloading") {
            return `Downloading ${downloadProgress?.percent ?? 0}%`;
          }
          if (!checkState || checkState.loading) return "Checking…";
          if (checkState.error) return "Check failed";
          if (checkState.status?.incomplete && !checkState.status?.isInstalled) {
            return `Incomplete (${checkState.status.formattedDiskSize})`;
          }
          return checkState.status?.isInstalled ? "Installed" : "Not installed";
        })(),
        action: () => {
          const target = pendingLocalModel || activeModel;
          setModelToCheck("");
          setCurrentMenu("check-model");
          setSelectedIndex(0);
          void runCheck(target);
        },
      },
      {
        section: "OpenCode Integration",
        label: "OpenCode Orchestrator",
        value: "opencode/big-pickle",
        action: () => {
          setCurrentMenu("opencode");
          setSelectedIndex(0);
        },
      },
      {
        section: "T3 Connect",
        label: "Hugging Face Auth",
        value: "Token page",
        action: () => {
          setCurrentMenu("auth");
          setSelectedIndex(0);
        },
      },
      {
        section: "T3 Connect",
        label: "Sessions",
        value: sessionId ? sessionId.slice(0, 19) : "new",
        action: () => {
          setCurrentMenu("sessions");
          setSelectedIndex(0);
        },
      },
      {
        section: "System",
        label: "Clear Transcript",
        value: "Ctrl+L",
        action: () => {
          onClear?.();
          setStatusMessage("Transcript cleared");
        },
      },
      {
        section: "System",
        label: "Close Settings",
        value: "Esc",
        action: () => {
          setIsSettingsOpen(false);
        },
      },
    ];
  };

  const currentItems = getMenuItems();

  const getMenuTitle = (menu: SettingsMenuType): string => {
    switch (menu) {
      case "model":
        return "Model Selection";
      case "effort":
        return "Effort & Reasoning Budget";
      case "permission":
        return "Permission Policy";
      case "provider":
        return "AI Provider";
      case "auth":
        return "Hugging Face Authentication";
      case "sessions":
        return "Sessions";
      case "sessions-switch":
        return "Switch / Resume Session";
      case "sessions-restore":
        return "Restore Session Backup";
      case "opencode":
        return "OpenCode Orchestrator";
      case "check-model":
        return "Check Model";
      case "check-model-select":
        return "Check Different Model";
      default:
        return "Main Menu";
    }
  };

  /** Info panel rendered above the action list of the Check Model submenu. */
  const renderCheckModelInfo = (): React.ReactNode => {
    const target = checkTarget;
    const isDownloading =
      localDialogStep === "downloading" && pendingLocalModel === target;
    const state = checkState?.model === target ? checkState : null;

    return (
      <Box
        flexDirection="column"
        marginBottom={1}
        borderStyle="single"
        borderColor="cyan"
        paddingX={1}
      >
        <Box justifyContent="space-between">
          <Text bold color="cyan">
            Model Status
          </Text>
          <Text color="gray">inspecting local ONNX cache</Text>
        </Box>
        <Box justifyContent="space-between">
          <Text color="gray">Target Model ID</Text>
          <Text color="white">{target}</Text>
        </Box>
        <Box justifyContent="space-between">
          <Text color="gray">ONNX Model Repository</Text>
          <Text color="white">{resolveLocalModelId(target)}</Text>
        </Box>
        <Box justifyContent="space-between">
          <Text color="gray">Estimated Download Size</Text>
          <Text color="white">{getModelEstimatedSize(target)}</Text>
        </Box>
        <Box justifyContent="space-between">
          <Text color="gray">Size on Disk</Text>
          <Text color="white">{state?.status?.formattedDiskSize ?? "0 B"}</Text>
        </Box>

        {isDownloading ? (
          <Box flexDirection="column">
            <Box>
              <Text color="cyan">{SPINNER_FRAMES[spinnerIndex]} </Text>
              <Text color="cyan">
                {renderProgressBar(downloadProgress?.percent ?? 0, 24, spinnerIndex)}{" "}
              </Text>
              <Text bold color="white">
                {downloadProgress?.percent ?? 0}%
              </Text>
            </Box>
            <Box>
              <Text color="green">{downloadProgress?.formattedSpeed ?? "--"}</Text>
              <Text color="gray">{"  •  "}</Text>
              <Text color="magenta">{downloadProgress?.formattedEta ?? "--"}</Text>
            </Box>
            {downloadProgress?.formattedDownloaded && downloadProgress?.formattedTotal ? (
              <Text color="gray">
                {downloadProgress.formattedDownloaded} / {downloadProgress.formattedTotal}
              </Text>
            ) : null}
            {downloadProgress?.statusText ? (
              <Text color="gray">{downloadProgress.statusText}</Text>
            ) : null}
          </Box>
        ) : state?.loading ? (
          <Text color="yellow">⟳ Checking local cache…</Text>
        ) : state?.error ? (
          <Text color="red">✖ Check failed: {state.error}</Text>
        ) : state?.status?.isInstalled ? (
          <Text bold color="green">
            ✓ Installed in local cache ({state.status.formattedDiskSize})
          </Text>
        ) : state?.status?.incomplete ? (
          <Text color="yellow">
            ⚠ Incomplete download ({state.status.formattedDiskSize} of {state.status.estimatedSize})
          </Text>
        ) : state ? (
          <Text color="red">✖ Not installed</Text>
        ) : null}

        {state?.status ? (
          <>
            <Text color="gray">Local cache path:</Text>
            <Text color="white">{state.status.path}</Text>
            {state.status.details ? (
              <Text color="gray">{state.status.details}</Text>
            ) : null}
          </>
        ) : null}
      </Box>
    );
  };

  useInput((value, key) => {
    // Ctrl+C: Quit
    if (key.ctrl && value === "c") {
      exit();
      return;
    }

    // Handle Local Model Dialog Prompts (Confirmation -> Not Installed Check -> Install Prompt -> Downloading -> Confirm Cancel)
    if (localDialogStep !== "none") {
      if (localDialogStep === "downloading") {
        if (!downloadViewVisible) {
          // Download runs in the background: fall through so the palette and
          // transcript keep handling input normally.
        } else {
          if (key.ctrl && (value === "p" || value === "\x10")) {
            // Send the download to the background and open Settings Palette.
            setDownloadViewVisible(false);
            setIsSettingsOpen(true);
            setCurrentMenu("main");
            setSelectedIndex(0);
            setStatusMessage(null);
            return;
          }
          if (key.escape) {
            // Keep the download running while viewing the transcript.
            setDownloadViewVisible(false);
            return;
          }
          if (value === "c") {
            setLocalDialogStep("confirm_cancel");
          }
          return;
        }
      } else if (localDialogStep === "confirm_cancel") {
        if (value === "y" || key.return) {
          downloadAbortControllerRef.current?.abort();
          setLocalDialogStep("none");
          setPendingLocalModel("");
          setDownloadViewVisible(true);
          setStatusMessage("✖ Download cancelled. Remaining on Cloud.");
          return;
        }
        if (value === "n" || key.escape) {
          setLocalDialogStep("downloading");
          // Return to whichever view the user came from (palette when it is
          // open, the animated overlay otherwise).
          setDownloadViewVisible(!isSettingsOpen);
          return;
        }
        return;
      } else if (localDialogStep === "confirm") {
        if (value === "y" || key.return) {
          void handleConfirmSwitchToLocal();
          return;
        }
        if (value === "n" || key.escape) {
          setLocalDialogStep("none");
          setPendingLocalModel("");
          setStatusMessage("Switch to local model cancelled. Remaining on Cloud.");
          return;
        }
        return;
      } else if (localDialogStep === "ask_install") {
        if (value === "y" || key.return) {
          void handleConfirmInstall();
          return;
        }
        if (value === "n" || key.escape) {
          setLocalDialogStep("none");
          setPendingLocalModel("");
          setStatusMessage("Local model installation cancelled. Remaining on Cloud.");
          return;
        }
        return;
      }
    }

    // Ctrl+P toggle settings menu (or \x10)
    if ((key.ctrl && (value === "p" || value === "\x10")) || value === "\x10") {
      setIsSettingsOpen((prev) => !prev);
      setCurrentMenu("main");
      setSelectedIndex(0);
      setStatusMessage(null);
      return;
    }

    // When settings modal is open, navigate options
    if (isSettingsOpen) {
      if (key.escape) {
        setConfirmDeleteSessionId(null);
        if (currentMenu !== "main") {
          setCurrentMenu("main");
          setSelectedIndex(0);
        } else {
          setIsSettingsOpen(false);
        }
        return;
      }

      if (key.upArrow) {
        setConfirmDeleteSessionId(null);
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : currentItems.length - 1));
        return;
      }

      if (key.downArrow) {
        setConfirmDeleteSessionId(null);
        setSelectedIndex((prev) => (prev < currentItems.length - 1 ? prev + 1 : 0));
        return;
      }

      if (key.return) {
        const item = currentItems[selectedIndex];
        item?.action();
        return;
      }

      // Ctrl+D deletes the highlighted session from the Switch/Resume list.
      // The first press arms a confirmation; a second Ctrl+D on the same
      // session performs the deletion.
      if (
        currentMenu === "sessions-switch" &&
        ((key.ctrl && (value === "d" || value === "\x04")) || value === "\x04")
      ) {
        const target = sessions?.[selectedIndex];
        if (target) {
          if (confirmDeleteSessionId !== target.id) {
            setConfirmDeleteSessionId(target.id);
            setStatusMessage(
              "⚠ Press Ctrl+D again to confirm deleting session " + target.id,
            );
            return;
          }
          setConfirmDeleteSessionId(null);
          const remaining = (sessions?.length ?? 0) - 1;
          if (remaining > 0) {
            setSelectedIndex((prev) => Math.min(prev, remaining - 1));
          } else {
            setCurrentMenu("sessions");
            setSelectedIndex(0);
          }
          runSessionAction(`Deleted session ${target.id}`, () =>
            onDeleteSession?.(target.id),
          );
        }
        return;
      }

      if (key.backspace || key.delete) {
        if (currentMenu !== "main") {
          setCurrentMenu("main");
          setSelectedIndex(0);
        } else {
          setIsSettingsOpen(false);
        }
        return;
      }

      return;
    }

    // Ctrl+L: Clear transcript
    if (key.ctrl && value === "l") {
      onClear?.();
      return;
    }

    // Ctrl+U: Clear current prompt input line
    if (key.ctrl && value === "u") {
      setInput("");
      setHistoryIndex(-1);
      return;
    }

    // Ctrl+T: Open Hugging Face token settings
    if ((key.ctrl && (value === "t" || value === "\x14")) || value === "\x14") {
      onOpenToken?.();
      return;
    }

    // Handle interactive permission prompts
    if (permission) {
      if (value === "y") onPermission("allow");
      else if (value === "a") onPermission("always");
      else if (value === "d") onPermission("session");
      else if (value === "n") onPermission("deny");
      return;
    }

    if (busy) return;

    // Up arrow: Navigate command history backwards
    if (key.upArrow) {
      if (history.length > 0) {
        const nextIndex = historyIndex < history.length - 1 ? historyIndex + 1 : historyIndex;
        setHistoryIndex(nextIndex);
        setInput(history[history.length - 1 - nextIndex] ?? "");
      }
      return;
    }

    // Down arrow: Navigate command history forwards
    if (key.downArrow) {
      if (historyIndex > 0) {
        const nextIndex = historyIndex - 1;
        setHistoryIndex(nextIndex);
        setInput(history[history.length - 1 - nextIndex] ?? "");
      } else if (historyIndex === 0) {
        setHistoryIndex(-1);
        setInput("");
      }
      return;
    }

    // Enter: Submit prompt
    if (key.return) {
      const trimmed = input.trim();
      if (trimmed.length > 0) {
        setHistory((prev) => [...prev, trimmed]);
        setHistoryIndex(-1);
        onSubmit(trimmed);
      }
      setInput("");
      return;
    }

    // Backspace / Delete
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }

    // Regular typing
    if (!key.ctrl && !key.meta && value && value.charCodeAt(0) >= 32) {
      setInput((current) => current + value);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      {/* Header bar */}
      <Box
        borderStyle="round"
        borderColor="cyan"
        paddingX={1}
        justifyContent="space-between"
      >
        <Box flexDirection="column">
          <Text bold color="cyan">
            T3OS Agent
          </Text>
          <Text color="gray">
            Session: {sessionId ?? "(new)"}
          </Text>
        </Box>
        <Text color="gray">
          Provider: <Text bold color={activeProviderType === "local" ? "green" : "magenta"}>[{activeProviderType === "local" ? "LOCAL" : "CLOUD"}]</Text>{" "}
          Model: <Text bold color="white">{activeModel}</Text> ({activeEffort})
        </Text>
      </Box>

      {/* Step 1: Switch Confirmation */}
      {localDialogStep === "confirm" ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="cyan"
          paddingX={2}
          paddingY={0}
          marginY={1}
        >
          <Box justifyContent="space-between" marginY={0}>
            <Text bold color="cyan">
              ⚡ Switch to Local Model
            </Text>
            <Text color="gray">
              {getModelEstimatedSize(pendingLocalModel || activeModel)}
            </Text>
          </Box>
          <Box marginY={0} justifyContent="space-between">
            <Text color="white">
              Target: <Text bold color="yellow">{pendingLocalModel || activeModel}</Text>
            </Text>
            <Box>
              <Text bold color="green">
                [y] Confirm Switch
              </Text>
              <Text color="gray">   </Text>
              <Text bold color="red">
                [n] Cancel (Stay on Cloud)
              </Text>
            </Box>
          </Box>
        </Box>
      ) : null}

      {/* Step 2: Model Not Installed, Ask to Install */}
      {localDialogStep === "ask_install" ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="yellow"
          paddingX={2}
          paddingY={0}
          marginY={1}
        >
          <Box justifyContent="space-between" marginY={0}>
            <Text bold color="yellow">
              ⚠ Local Model Not Installed
            </Text>
            <Text color="gray">
              Estimated download size: {getModelEstimatedSize(pendingLocalModel || activeModel)}
            </Text>
          </Box>
          <Box marginY={0} justifyContent="space-between">
            <Text color="white">
              Download <Text bold color="cyan">{pendingLocalModel || activeModel}</Text>?
            </Text>
            <Box>
              <Text bold color="green">
                [y] Install & Switch to Local
              </Text>
              <Text color="gray">   </Text>
              <Text bold color="red">
                [n] Cancel (Stay on Cloud)
              </Text>
            </Box>
          </Box>
        </Box>
      ) : null}

      {/* Step 3: Minimal Animated Download Progress (hidden when the download runs in the background) */}
      {localDialogStep === "downloading" && downloadViewVisible ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="cyan"
          paddingX={2}
          paddingY={0}
          marginY={1}
        >
          <Box flexDirection="column" marginY={0}>
            <Text bold color="cyan">
              Downloading ONNX model {resolveLocalModelId(pendingLocalModel || activeModel)} ({pendingLocalModel || activeModel})…
            </Text>
            <Box justifyContent="flex-end">
              <Text color="red">
                [c] Cancel download   [Esc] Continue in background
              </Text>
            </Box>
          </Box>
          <Box marginY={0}>
            <Text color="cyan">
              {SPINNER_FRAMES[spinnerIndex]}{" "}
            </Text>
            <Text color="cyan">
              {renderProgressBar(downloadProgress?.percent ?? 0, 24, spinnerIndex)}{" "}
            </Text>
            <Text bold color="white">
              {downloadProgress?.percent ?? 0}%
            </Text>
            {downloadProgress?.formattedDownloaded && downloadProgress?.formattedTotal ? (
              <Text color="gray">
                {"  "}•{"  "}{downloadProgress.formattedDownloaded} / {downloadProgress.formattedTotal}
              </Text>
            ) : null}
            <Text color="gray">
              {"  "}•{"  "}
            </Text>
            <Text color="green">
              {downloadProgress?.formattedSpeed ?? "--"}
            </Text>
            <Text color="gray">
              {"  "}•{"  "}
            </Text>
            <Text color="magenta">
              {downloadProgress?.formattedEta ?? "--"}
            </Text>
          </Box>
          {downloadProgress?.statusText ? (
            <Box marginY={0}>
              <Text color="gray">
                {downloadProgress.statusText}
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null}

      {/* Step 4: Minimal Cancel Confirmation */}
      {localDialogStep === "confirm_cancel" ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="red"
          paddingX={2}
          paddingY={0}
          marginY={1}
        >
          <Box justifyContent="space-between" marginY={0}>
            <Text bold color="red">
              ⚠ Cancel Model Download?
            </Text>
            <Text color="gray">
              {downloadProgress?.percent ?? 0}% complete
            </Text>
          </Box>
          <Box marginY={0} justifyContent="space-between">
            <Text bold color="red">
              [y] Yes, cancel download
            </Text>
            <Text bold color="green">
              [n] Continue downloading
            </Text>
          </Box>
        </Box>
      ) : null}

      {/* Settings Modal (Ctrl+P) — also available while a download runs in the background */}
      {isSettingsOpen &&
      (localDialogStep === "none" ||
        (localDialogStep === "downloading" && !downloadViewVisible)) ? (
        <Box
          flexDirection="column"
          borderStyle="double"
          borderColor="magenta"
          paddingX={2}
          paddingY={1}
          marginY={1}
        >
          <Box justifyContent="space-between" marginBottom={1}>
            <Text bold color="magenta">
              ⚡ Settings Palette ▸ {getMenuTitle(currentMenu)}
            </Text>
            <Text dimColor>[Ctrl+P or Esc to close]</Text>
          </Box>

          {statusMessage ? (
            <Box marginBottom={1}>
              <Text
                bold
                color={
                  statusMessage.startsWith("✖")
                    ? "red"
                    : statusMessage.startsWith("⚠")
                      ? "yellow"
                      : "green"
                }
              >
                {statusMessage.startsWith("✓") ||
                statusMessage.startsWith("✖") ||
                statusMessage.startsWith("⚠")
                  ? statusMessage
                  : `✓ ${statusMessage}`}
              </Text>
            </Box>
          ) : null}

          {currentMenu === "check-model" ? renderCheckModelInfo() : null}

          <Box flexDirection="column">
            {currentItems.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              const showHeader =
                item.section &&
                (idx === 0 || currentItems[idx - 1]?.section !== item.section);
              return (
                <React.Fragment key={idx}>
                  {showHeader ? (
                    <Text bold color="yellow">
                      ─── {item.section} ───
                    </Text>
                  ) : null}
                  <Box justifyContent="space-between">
                    <Text
                      color={isSelected ? "cyan" : item.active ? "green" : "white"}
                      bold={isSelected}
                    >
                      {isSelected ? "▸ " : "  "}
                      {item.label}
                      {item.active ? " ✓" : ""}
                    </Text>
                    {item.value ? (
                      <Text color={isSelected ? "yellow" : "gray"}>
                        {item.value}
                        {currentMenu === "sessions-switch" &&
                        isSelected &&
                        idx < (sessions?.length ?? 0)
                          ? confirmDeleteSessionId === sessions?.[idx]?.id
                            ? "   [Ctrl+D] Confirm Delete"
                            : "   [Ctrl+D] Delete"
                          : ""}
                      </Text>
                    ) : null}
                  </Box>
                </React.Fragment>
              );
            })}
          </Box>

          <Box
            marginTop={1}
            borderStyle="single"
            borderColor="gray"
            paddingX={1}
            justifyContent="space-between"
          >
            <Text dimColor>
              {currentMenu === "sessions-switch"
                ? confirmDeleteSessionId
                  ? "[↑/↓] Navigate   [Enter] Select   [Ctrl+D] Confirm Delete   [Esc] Cancel"
                  : "[↑/↓] Navigate   [Enter] Select   [Ctrl+D] Delete"
                : "[↑/↓] Navigate   [Enter] Select"}
            </Text>
            <Text dimColor>
              [Esc / Backspace] Back
            </Text>
          </Box>
        </Box>
      ) : null}

      {/* Background download indicator (download continues while palette/transcript are in use) */}
      {localDialogStep === "downloading" && !downloadViewVisible && !isSettingsOpen ? (
        <Box marginY={0} paddingX={1} borderStyle="single" borderColor="cyan">
          <Text color="cyan">
            {SPINNER_FRAMES[spinnerIndex]} Downloading {pendingLocalModel || activeModel} —{" "}
            {downloadProgress?.percent ?? 0}%
          </Text>
          <Text dimColor>  [Ctrl+P] Settings ▸ Check Model for details</Text>
        </Box>
      ) : null}

      {/* Status notification banner on main screen */}
      {statusMessage && !isSettingsOpen && localDialogStep === "none" ? (
        <Box marginY={0} paddingX={1}>
          <Text color={statusMessage.startsWith("✖") ? "red" : statusMessage.startsWith("⚠") ? "yellow" : "green"}>
            {statusMessage}
          </Text>
        </Box>
      ) : null}

      {/* Transcript entries */}
      <Box flexDirection="column" marginY={1}>
        {state.entries.length === 0 && !isSettingsOpen && localDialogStep === "none" ? (
          <Box paddingY={1}>
            <Text dimColor>Type a prompt and press Enter to interact with T3OS… (Press Ctrl+P for settings)</Text>
          </Box>
        ) : null}

        {state.entries.map((entry, index) => {
          if (entry.kind === "user") {
            return (
              <Box key={index} marginY={0}>
                <Text bold color="green">
                  ❯{" "}
                </Text>
                <Text bold color="white">
                  {entry.text}
                </Text>
              </Box>
            );
          }
          if (entry.kind === "assistant") {
            return (
              <Box key={index} paddingLeft={2} marginY={0}>
                <Text color="gray">{entry.text}</Text>
              </Box>
            );
          }
          if (entry.kind === "tool") {
            const mark = entry.ok === undefined ? "…" : entry.ok ? "ok" : "fail";
            const color = entry.ok === false ? "red" : "yellow";
            return (
              <Box key={index} paddingLeft={2} marginY={0}>
                <Text color={color}>
                  ⚙ {entry.name} [{mark}]
                </Text>
              </Box>
            );
          }
          return (
            <Box key={index} paddingLeft={2} marginY={0}>
              <Text bold color="red">
                ✖ [{entry.scope}] {entry.message}
              </Text>
            </Box>
          );
        })}
      </Box>

      {/* Permission prompt banner */}
      {permission ? (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderColor="yellow"
          paddingX={1}
          marginY={1}
        >
          <Text bold color="yellow">
            ⚠ Permission Required: {permission.request.tool} ({permission.request.toolClass})
          </Text>
          <Text color="white">
            [y] Allow once   [a] Always allow   [d] Allow session   [n] Deny
          </Text>
        </Box>
      ) : null}

      {/* Input or status line */}
      <Box borderStyle="single" borderColor={localDialogStep !== "none" ? "cyan" : isSettingsOpen ? "magenta" : busy ? "yellow" : "green"} paddingX={1}>
        {localDialogStep === "confirm" ? (
          <Text color="cyan">
            [y] Confirm switch   [n] Cancel
          </Text>
        ) : localDialogStep === "ask_install" ? (
          <Text color="yellow">
            [y] Download model   [n] Cancel
          </Text>
        ) : localDialogStep === "downloading" && downloadViewVisible ? (
          <Text color="cyan">
            {SPINNER_FRAMES[spinnerIndex]} Downloading… [c] Cancel   [Esc] Background
          </Text>
        ) : localDialogStep === "confirm_cancel" ? (
          <Text color="red">
            Cancel download? [y] Yes   [n] No
          </Text>
        ) : isSettingsOpen ? (
          <Text color="magenta">
            ⚡ Settings Menu active — use [↑/↓] to navigate, [Enter] to choose
          </Text>
        ) : busy ? (
          <Text color="yellow">
            ⚙ Working… please wait
          </Text>
        ) : (
          <Box>
            <Text bold color="green">
              ❯{" "}
            </Text>
            <Text color="white">{input}</Text>
            <Text color="gray">█</Text>
          </Box>
        )}
      </Box>

      {/* Footer keybinding helper */}
      <Box justifyContent="space-between" marginTop={1}>
        <Text dimColor>
          [Ctrl+P] Settings   [Enter] Send   [↑/↓] History   [Ctrl+U] Clear Line   [Ctrl+L] Clear Screen
        </Text>
        <Text dimColor>
          [Ctrl+T] HF Token   [Ctrl+C] Exit
        </Text>
      </Box>
    </Box>
  );
}
