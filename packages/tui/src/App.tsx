import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import {
  GEMMA_PRESETS,
  checkLocalModelInstalled,
  getModelEstimatedSize,
  installLocalModel,
  type ApprovalOutcome,
  type EffortLevel,
  type PermissionMode,
  type PermissionRequest,
} from "@t3os/core";
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
  | "auth";

export interface MenuItem {
  label: string;
  value?: string;
  active?: boolean;
  action: () => void;
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
  onChangeModel?: (model: string) => void;
  onChangeEffort?: (effort: EffortLevel) => void;
  onChangePermissionMode?: (mode: PermissionMode) => void;
  onChangeProvider?: (provider: "hf" | "local") => void;
  onCheckModelInstalled?: (model: string) => Promise<boolean>;
  onInstallModel?: (model: string, onProgress: (msg: string) => void) => Promise<boolean>;
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
  onCheckModelInstalled,
  onInstallModel,
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

  const [activeModel, setActiveModel] = useState<string>(model);
  const [activeEffort, setActiveEffort] = useState<EffortLevel>(effort);
  const [activePermissionMode, setActivePermissionMode] = useState<PermissionMode>(permissionMode);
  const [activeProviderType, setActiveProviderType] = useState<"hf" | "local">(providerType);

  // Local Model Switch & Install Dialog state
  const [localDialogStep, setLocalDialogStep] = useState<"none" | "confirm" | "ask_install" | "installing">("none");
  const [pendingLocalModel, setPendingLocalModel] = useState<string>("");
  const [installProgressMsg, setInstallProgressMsg] = useState<string>("");

  // Sync props if changed externally
  React.useEffect(() => {
    setActiveModel(model);
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

  const initiateLocalModelSwitch = (targetModel: string) => {
    setPendingLocalModel(targetModel);
    setLocalDialogStep("confirm");
    setIsSettingsOpen(false);
  };

  const handleConfirmSwitchToLocal = async () => {
    const target = pendingLocalModel || activeModel;
    setStatusMessage(`Checking local installation for ${target}…`);

    const isInstalled = onCheckModelInstalled
      ? await onCheckModelInstalled(target)
      : (await checkLocalModelInstalled(target)).isInstalled;

    if (isInstalled) {
      setActiveProviderType("local");
      setActiveModel(target);
      onChangeModel?.(target);
      onChangeProvider?.("local");
      setLocalDialogStep("none");
      setStatusMessage(`✓ Local model ${target} is installed. Switched to local mode.`);
    } else {
      setLocalDialogStep("ask_install");
    }
  };

  const handleConfirmInstall = async () => {
    const target = pendingLocalModel || activeModel;
    setLocalDialogStep("installing");
    setInstallProgressMsg("Preparing local model environment and cache…");

    try {
      let success = false;
      if (onInstallModel) {
        success = await onInstallModel(target, (msg) => setInstallProgressMsg(msg));
      } else {
        const result = await installLocalModel(target, {
          onProgress: (msg) => setInstallProgressMsg(msg),
        });
        success = result.success;
        if (!success && result.error) {
          throw new Error(result.error);
        }
      }

      if (success) {
        setActiveProviderType("local");
        setActiveModel(target);
        onChangeModel?.(target);
        onChangeProvider?.("local");
        setLocalDialogStep("none");
        setStatusMessage(`✓ Model ${target} installed successfully. Switched to local mode.`);
      } else {
        setLocalDialogStep("none");
        setStatusMessage(`✖ Installation of ${target} failed.`);
      }
    } catch (err) {
      setLocalDialogStep("none");
      const errorMsg = err instanceof Error ? err.message : String(err);
      setStatusMessage(`✖ Installation failed: ${errorMsg}`);
    }
  };

  // Build menu items based on current menu
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
            setActiveModel(preset.id);
            onChangeModel?.(preset.id);
            setStatusMessage(`Model updated to ${preset.id}`);
            setCurrentMenu("main");
            setSelectedIndex(0);
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
          setActiveEffort(opt.level);
          onChangeEffort?.(opt.level);
          setStatusMessage(`Effort profile set to ${opt.level}`);
          setCurrentMenu("main");
          setSelectedIndex(1);
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
          setActiveProviderType("hf");
          onChangeProvider?.("hf");
          setStatusMessage("Provider set to Hugging Face (Cloud)");
          setCurrentMenu("main");
          setSelectedIndex(3);
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
            setSelectedIndex(4);
          },
        },
      ];
    }

    // Default: Main Menu
    return [
      {
        label: "Model Selection",
        value: activeModel,
        action: () => {
          setCurrentMenu("model");
          setSelectedIndex(0);
        },
      },
      {
        label: "Effort & Reasoning",
        value: activeEffort,
        action: () => {
          setCurrentMenu("effort");
          setSelectedIndex(0);
        },
      },
      {
        label: "Permission Policy",
        value: activePermissionMode,
        action: () => {
          setCurrentMenu("permission");
          setSelectedIndex(0);
        },
      },
      {
        label: "AI Provider",
        value: activeProviderType === "local" ? "Hugging Face (Local)" : "Hugging Face (Cloud)",
        action: () => {
          setCurrentMenu("provider");
          setSelectedIndex(0);
        },
      },
      {
        label: "Hugging Face Auth",
        value: "Token page",
        action: () => {
          setCurrentMenu("auth");
          setSelectedIndex(0);
        },
      },
      {
        label: "Clear Transcript",
        value: "Ctrl+L",
        action: () => {
          onClear?.();
          setStatusMessage("Transcript cleared");
        },
      },
      {
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
      default:
        return "Main Menu";
    }
  };

  useInput((value, key) => {
    // Ctrl+C: Quit
    if (key.ctrl && value === "c") {
      exit();
      return;
    }

    // Handle Local Model Dialog Prompts (Confirmation -> Not Installed Check -> Install Prompt -> Installing)
    if (localDialogStep !== "none") {
      if (localDialogStep === "installing") {
        return; // Ignore inputs during active installation
      }

      if (localDialogStep === "confirm") {
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
      }

      if (localDialogStep === "ask_install") {
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
        if (currentMenu !== "main") {
          setCurrentMenu("main");
          setSelectedIndex(0);
        } else {
          setIsSettingsOpen(false);
        }
        return;
      }

      if (key.upArrow) {
        setSelectedIndex((prev) => (prev > 0 ? prev - 1 : currentItems.length - 1));
        return;
      }

      if (key.downArrow) {
        setSelectedIndex((prev) => (prev < currentItems.length - 1 ? prev + 1 : 0));
        return;
      }

      if (key.return) {
        const item = currentItems[selectedIndex];
        item?.action();
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
        <Text bold color="cyan">
          T3OS Agent
        </Text>
        <Text color="gray">
          Provider: <Text bold color={activeProviderType === "local" ? "green" : "magenta"}>[{activeProviderType === "local" ? "LOCAL" : "CLOUD"}]</Text>{" "}
          Model: <Text bold color="white">{activeModel}</Text> ({activeEffort})
        </Text>
      </Box>

      {/* Confirmation Dialog Step 1: Switch to Local */}
      {localDialogStep === "confirm" ? (
        <Box
          flexDirection="column"
          borderStyle="double"
          borderColor="cyan"
          paddingX={2}
          paddingY={1}
          marginY={1}
        >
          <Box marginBottom={1}>
            <Text bold color="cyan">
              ⚡ Switch to Local Model
            </Text>
          </Box>
          <Box marginY={0}>
            <Text color="white">
              Do you want to switch to local inference for <Text bold color="yellow">{pendingLocalModel || activeModel}</Text>?
            </Text>
          </Box>
          <Box marginY={0}>
            <Text color="gray">
              Estimated file size: <Text bold color="white">{getModelEstimatedSize(pendingLocalModel || activeModel)}</Text>
            </Text>
          </Box>
          <Box marginTop={1} justifyContent="space-between">
            <Text bold color="green">
              [y] Confirm Switch
            </Text>
            <Text bold color="red">
              [n] Cancel (Stay on Cloud)
            </Text>
          </Box>
        </Box>
      ) : null}

      {/* Confirmation Dialog Step 2: Model Not Installed, Ask to Install with Estimated Size */}
      {localDialogStep === "ask_install" ? (
        <Box
          flexDirection="column"
          borderStyle="double"
          borderColor="yellow"
          paddingX={2}
          paddingY={1}
          marginY={1}
        >
          <Box marginBottom={1}>
            <Text bold color="yellow">
              ⚠ Local Model Not Installed
            </Text>
          </Box>
          <Box marginY={0}>
            <Text color="white">
              Model <Text bold color="cyan">{pendingLocalModel || activeModel}</Text> is not installed locally.
            </Text>
          </Box>
          <Box marginY={0}>
            <Text color="yellow">
              Estimated download size: <Text bold color="white">{getModelEstimatedSize(pendingLocalModel || activeModel)}</Text>
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color="white">
              Do you want to download and install this model locally now?
            </Text>
          </Box>
          <Box marginTop={1} justifyContent="space-between">
            <Text bold color="green">
              [y] Install & Switch to Local
            </Text>
            <Text bold color="red">
              [n] Cancel (Stay on Cloud)
            </Text>
          </Box>
        </Box>
      ) : null}

      {/* Confirmation Dialog Step 3: Installing Model Progress */}
      {localDialogStep === "installing" ? (
        <Box
          flexDirection="column"
          borderStyle="double"
          borderColor="yellow"
          paddingX={2}
          paddingY={1}
          marginY={1}
        >
          <Box marginBottom={1}>
            <Text bold color="yellow">
              ⬇ Installing Local Model: {pendingLocalModel || activeModel}
            </Text>
          </Box>
          <Box marginY={0}>
            <Text color="white">
              Estimated size: <Text bold color="cyan">{getModelEstimatedSize(pendingLocalModel || activeModel)}</Text>
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color="green">
              ⚙ {installProgressMsg || "Downloading and setting up model artifacts…"}
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>Please wait, installation is in progress…</Text>
          </Box>
        </Box>
      ) : null}

      {/* Settings Modal (Ctrl+P) */}
      {isSettingsOpen && localDialogStep === "none" ? (
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
              <Text bold color="green">
                ✓ {statusMessage}
              </Text>
            </Box>
          ) : null}

          <Box flexDirection="column">
            {currentItems.map((item, idx) => {
              const isSelected = idx === selectedIndex;
              return (
                <Box key={idx} justifyContent="space-between">
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
                    </Text>
                  ) : null}
                </Box>
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
              [↑/↓] Navigate   [Enter] Select
            </Text>
            <Text dimColor>
              [Esc / Backspace] Back
            </Text>
          </Box>
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
            ⚡ Switch to Local: press [y] to confirm switch, [n] to cancel
          </Text>
        ) : localDialogStep === "ask_install" ? (
          <Text color="yellow">
            ⚠ Install Local Model: press [y] to install with estimate size, [n] to cancel
          </Text>
        ) : localDialogStep === "installing" ? (
          <Text color="yellow">
            ⬇ Installing local model… please wait
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
