import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import React from "react";
import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { SessionStore } from "@t3os/core";
import type { SessionBackup, SessionMeta } from "@t3os/core";
import { App } from "../src/App.js";
import { emptyTranscript } from "../src/transcript.js";
import { transcriptFromEvents } from "../src/repl.js";

const tick = (ms = 60) => new Promise((resolve) => setTimeout(resolve, ms));

const CTRL_P = "\x10";
const DOWN = "\u001B[B";
const ENTER = "\r";

const session = (over: Partial<SessionMeta>): SessionMeta => ({
  id: "s1",
  title: "untitled",
  createdAt: "2026-01-02T03:04:05.000Z",
  updatedAt: "2026-01-02T03:04:05.000Z",
  eventCount: 0,
  ...over,
});

const backup = (over: Partial<SessionBackup>): SessionBackup => ({
  id: "s1.backup-1",
  originalId: "s1",
  backupPath: "/tmp/backups/s1.backup-1.jsonl",
  createdAt: "2026-01-02T03:04:05.000Z",
  ...over,
});

/** Opens the settings palette and drills into the Sessions menu via the main menu. */
async function openSessionsMenu(
  stdin: { write: (data: string) => void },
): Promise<void> {
  stdin.write(CTRL_P);
  await tick(80);
  for (let i = 0; i < 5; i++) {
    stdin.write(DOWN);
    await tick(30);
  }
  stdin.write(ENTER);
  await tick(80);
}

describe("App sessions menu", () => {
  const sessions = [
    session({
      id: "sess-1",
      title: "First chat",
      eventCount: 3,
      settings: { model: "google/gemma-3-27b-it", provider: "hf", effort: "high" },
    }),
    session({
      id: "sess-2",
      title: "Local run",
      settings: { model: "google/gemma-4-31B-it", provider: "local" },
    }),
  ];

  it("shows the current session id and lists available sessions", async () => {
    const { stdin, lastFrame } = render(
      <App
        state={emptyTranscript()}
        model="google/gemma-3-27b-it"
        effort="high"
        providerType="hf"
        sessionId="sess-1"
        sessions={sessions}
        onSubmit={() => {}}
        onPermission={() => {}}
      />,
    );
    await tick(100);

    // The active session id is surfaced in the header.
    expect(lastFrame()).toContain("Session: sess-1");

    await openSessionsMenu(stdin);
    const frame = lastFrame();
    expect(frame).toContain("Settings Palette ▸ Sessions");
    expect(frame).toContain("Current Session");
    expect(frame).toContain("sess-1");
    expect(frame).toContain("New Session");
    expect(frame).toContain("Switch / Resume Session");
    expect(frame).toContain("2 available");
    expect(frame).toContain("Backup Current Session");
    expect(frame).toContain("Restore Session Backup");

    // Drill into "Switch / Resume Session" (index 2).
    stdin.write(DOWN);
    await tick(30);
    stdin.write(DOWN);
    await tick(30);
    stdin.write(ENTER);
    await tick(80);

    const list = lastFrame();
    expect(list).toContain("Switch / Resume Session");
    expect(list).toContain("First chat");
    expect(list).toContain("Local run");
    // Each row shows the preserved model, provider, and updated time.
    expect(list).toContain("gemma-3-27b-it · Cloud · 2026-01-02 03:04");
    expect(list).toContain("gemma-4-31B-it · Local · 2026-01-02 03:04");
  });

  it("switches to the selected session and reports the resume", async () => {
    const onSwitchSession = vi.fn().mockResolvedValue(undefined);
    const { stdin, lastFrame } = render(
      <App
        state={emptyTranscript()}
        model="google/gemma-3-27b-it"
        sessionId="sess-2"
        sessions={sessions}
        onSubmit={() => {}}
        onPermission={() => {}}
        onSwitchSession={onSwitchSession}
      />,
    );
    await tick(100);
    await openSessionsMenu(stdin);
    stdin.write(DOWN);
    await tick(30);
    stdin.write(DOWN);
    await tick(30);
    stdin.write(ENTER);
    await tick(80);

    // Select the first session (sess-1) in the switch list.
    stdin.write(ENTER);
    await tick(120);

    expect(onSwitchSession).toHaveBeenCalledWith("sess-1");
    const frame = lastFrame();
    expect(frame).toContain("Resumed session sess-1");
  });

  it("starts a new session", async () => {
    const onNewSession = vi.fn();
    const { stdin, lastFrame } = render(
      <App
        state={emptyTranscript()}
        model="google/gemma-3-27b-it"
        sessionId="sess-1"
        sessions={sessions}
        onSubmit={() => {}}
        onPermission={() => {}}
        onNewSession={onNewSession}
      />,
    );
    await tick(100);
    await openSessionsMenu(stdin);

    // "New Session" is index 1.
    stdin.write(DOWN);
    await tick(30);
    stdin.write(ENTER);
    await tick(120);

    expect(onNewSession).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("Started a new session");
  });

  it("backs up the current session and reports the backup path", async () => {
    const onBackupSession = vi
      .fn()
      .mockResolvedValue("✓ Backed up session to /tmp/backups/s1.backup-x.jsonl");
    const { stdin, lastFrame } = render(
      <App
        state={emptyTranscript()}
        model="google/gemma-3-27b-it"
        sessionId="sess-1"
        sessions={sessions}
        onSubmit={() => {}}
        onPermission={() => {}}
        onBackupSession={onBackupSession}
      />,
    );
    await tick(100);
    await openSessionsMenu(stdin);

    // "Backup Current Session" (index 3).
    stdin.write(DOWN);
    await tick(30);
    stdin.write(DOWN);
    await tick(30);
    stdin.write(DOWN);
    await tick(30);
    stdin.write(ENTER);
    await tick(120);

    expect(onBackupSession).toHaveBeenCalledTimes(1);
    expect(lastFrame()).toContain("Backed up session to /tmp/backups/s1.backup-x.jsonl");
  });

  it("warns when there are no backups to restore", async () => {
    const { stdin, lastFrame } = render(
      <App
        state={emptyTranscript()}
        model="google/gemma-3-27b-it"
        sessionId="sess-1"
        sessions={sessions}
        backups={[]}
        onSubmit={() => {}}
        onPermission={() => {}}
      />,
    );
    await tick(100);
    await openSessionsMenu(stdin);

    // "Restore Session Backup" (index 4) with no backups warns instead of opening.
    for (let i = 0; i < 4; i++) {
      stdin.write(DOWN);
      await tick(30);
    }
    stdin.write(ENTER);
    await tick(80);

    const frame = lastFrame();
    expect(frame).toContain("No session backups found");
    expect(frame).toContain("Restore Session Backup");
  });

  it("lists backups and restores the selected one", async () => {
    const backups = [
      backup({ id: "sess-1.backup-a", backupPath: "/tmp/backups/a.jsonl" }),
      backup({ id: "sess-1.backup-b", backupPath: "/tmp/backups/b.jsonl" }),
    ];
    const onRestoreBackup = vi.fn().mockResolvedValue(undefined);
    const { stdin, lastFrame } = render(
      <App
        state={emptyTranscript()}
        model="google/gemma-3-27b-it"
        sessionId="sess-1"
        sessions={sessions}
        backups={backups}
        onSubmit={() => {}}
        onPermission={() => {}}
        onRestoreBackup={onRestoreBackup}
      />,
    );
    await tick(100);
    await openSessionsMenu(stdin);

    // "Restore Session Backup" (index 4) with backups opens the restore list.
    for (let i = 0; i < 4; i++) {
      stdin.write(DOWN);
      await tick(30);
    }
    stdin.write(ENTER);
    await tick(80);

    let frame = lastFrame();
    expect(frame).toContain("Restore Session Backup");
    expect(frame).toContain("sess-1.backup-a");
    expect(frame).toContain("sess-1.backup-b");

    stdin.write(ENTER);
    await tick(120);
    expect(onRestoreBackup).toHaveBeenCalledWith("/tmp/backups/a.jsonl");
  });

  it("deletes the highlighted session with the d key", async () => {
    const onDeleteSession = vi.fn().mockResolvedValue(undefined);
    const { stdin, lastFrame } = render(
      <App
        state={emptyTranscript()}
        model="google/gemma-3-27b-it"
        sessionId="sess-2"
        sessions={sessions}
        onSubmit={() => {}}
        onPermission={() => {}}
        onDeleteSession={onDeleteSession}
      />,
    );
    await tick(100);
    await openSessionsMenu(stdin);

    // Drill into "Switch / Resume Session" (index 2).
    stdin.write(DOWN);
    await tick(30);
    stdin.write(DOWN);
    await tick(30);
    stdin.write(ENTER);
    await tick(80);

    // The selected row advertises the delete affordance.
    let frame = lastFrame();
    expect(frame).toContain("[d] Delete");

    // "d" deletes the highlighted session (sess-1).
    stdin.write("d");
    await tick(120);

    expect(onDeleteSession).toHaveBeenCalledWith("sess-1");
    frame = lastFrame();
    expect(frame).toContain("Deleted session sess-1");
  });
});

describe("App session restore", () => {
  it("restores a session's transcript history and preserved settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "t3os-tui-sessions-"));
    const store = new SessionStore(dir);
    const created = await store.create("chat", {
      model: "google/gemma-4-31B-it",
      effort: "low",
      provider: "local",
      permissionMode: "read-only",
    });
    await store.append(created.id, { type: "user_message", text: "hello there" });
    await store.append(created.id, { type: "text", text: "hi back" });

    // What the TUI does when a session is resumed: replay events into a transcript
    // and read the preserved settings back off the session header.
    const meta = await store.getMeta(created.id);
    expect(meta?.settings).toEqual({
      model: "google/gemma-4-31B-it",
      effort: "low",
      provider: "local",
      permissionMode: "read-only",
    });

    const restored = transcriptFromEvents(await store.replay(created.id));
    expect(restored.entries.map((entry) => entry.kind)).toEqual(["user", "assistant"]);
    expect(restored.entries[0]).toMatchObject({ kind: "user", text: "hello there" });
    expect(restored.entries[1]).toMatchObject({ kind: "assistant", text: "hi back" });

    // The restored state + settings drive the same UI a resumed session renders.
    const { lastFrame } = render(
      <App
        state={restored}
        model={meta!.settings!.model!}
        effort={meta!.settings!.effort}
        providerType={meta!.settings!.provider}
        permissionMode={meta!.settings!.permissionMode}
        sessionId={created.id}
        onSubmit={() => {}}
        onPermission={() => {}}
      />,
    );
    await tick(60);

    const frame = lastFrame();
    expect(frame).toContain("Session:");
    expect(frame).toContain(created.id);
    expect(frame).toContain("hello there");
    expect(frame).toContain("hi back");
    expect(frame).toContain("[LOCAL]");
    expect(frame).toContain("google/gemma-4-31B-it");
    expect(frame).toContain("(low)");
  });
});
