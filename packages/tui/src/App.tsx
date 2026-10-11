import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
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
}

export function App({
  state,
  model,
  onSubmit,
  busy = false,
  permission = null,
  onPermission,
  onOpenToken,
}: AppProps): React.ReactElement {
  const [input, setInput] = useState("");

  useInput((value, key) => {
    // In node/ink, Ctrl+T can arrive either with key.ctrl === true && value === "t",
    // or as raw control character ASCII 20 (\x14)
    if ((key.ctrl && (value === "t" || value === "\x14")) || value === "\x14") {
      onOpenToken?.();
      return;
    }
    if (permission) {
      if (value === "y") onPermission("allow");
      else if (value === "a") onPermission("always");
      else if (value === "d") onPermission("session");
      else if (value === "n") onPermission("deny");
      return;
    }
    if (busy) return;
    if (key.return) {
      if (input.trim().length > 0) onSubmit(input);
      setInput("");
      return;
    }
    if (key.backspace || key.delete) {
      setInput((current) => current.slice(0, -1));
      return;
    }
    if (!key.ctrl && !key.meta && value && value.charCodeAt(0) >= 32) {
      setInput((current) => current + value);
    }
  });

  return (
    <Box flexDirection="column">
      <Text color="cyan">t3os · {model}</Text>
      {state.entries.map((entry, index) => {
        if (entry.kind === "user") {
          return (
            <Text key={index} color="green">
              › {entry.text}
            </Text>
          );
        }
        if (entry.kind === "assistant") {
          return <Text key={index}>{entry.text}</Text>;
        }
        if (entry.kind === "tool") {
          const mark = entry.ok === undefined ? "…" : entry.ok ? "ok" : "fail";
          return (
            <Text key={index} color="yellow">
              ⚙ {entry.name} [{mark}]
            </Text>
          );
        }
        return (
          <Text key={index} color="red">
            ! {entry.message}
          </Text>
        );
      })}
      {permission ? (
        <Box flexDirection="column">
          <Text color="magenta">
            permission: {permission.request.tool} ({permission.request.toolClass})
          </Text>
          <Text>[y] allow [a] always [d] this session [n] deny</Text>
        </Box>
      ) : busy ? (
        <Text dimColor>working…</Text>
      ) : (
        <Text color="gray">› {input}</Text>
      )}
      <Text dimColor>[ctrl+t] get HF token</Text>
    </Box>
  );
}
