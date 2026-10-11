import React, { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { ApprovalOutcome, PermissionRequest } from "@t3os/core";
import type { TranscriptState } from "./transcript.js";

export interface PendingPermission {
  request: PermissionRequest;
  id: string;
}

export interface AppProps {
  state: TranscriptState;
  model: string;
  onSubmit: (text: string) => void;
  busy?: boolean;
  permission?: PendingPermission | null;
  onPermission: (outcome: ApprovalOutcome) => void;
  onOpenToken?: () => void;
  onClear?: () => void;
}

export function App({
  state,
  model,
  onSubmit,
  busy = false,
  permission = null,
  onPermission,
  onOpenToken,
  onClear,
}: AppProps): React.ReactElement {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number>(-1);
  const { exit } = useApp();

  useInput((value, key) => {
    // Ctrl+C: Quit
    if (key.ctrl && value === "c") {
      exit();
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
          Model: <Text bold color="white">{model}</Text>
        </Text>
      </Box>

      {/* Transcript entries */}
      <Box flexDirection="column" marginY={1}>
        {state.entries.length === 0 ? (
          <Box paddingY={1}>
            <Text dimColor>Type a prompt and press Enter to interact with T3OS…</Text>
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
      <Box borderStyle="single" borderColor={busy ? "yellow" : "green"} paddingX={1}>
        {busy ? (
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
          [Enter] Send   [↑/↓] History   [Ctrl+U] Clear Line   [Ctrl+L] Clear Screen
        </Text>
        <Text dimColor>
          [Ctrl+T] HF Token   [Ctrl+C] Exit
        </Text>
      </Box>
    </Box>
  );
}
