import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessions/store.js";
import type { AgentEvent } from "../src/types.js";

let dir: string;
let store: SessionStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "t3os-"));
  store = new SessionStore(dir);
});

const text = (t: string): AgentEvent => ({ type: "text", text: t });

describe("SessionStore", () => {
  it("creates, appends and replays in order", async () => {
    const s = await store.create("first");
    await store.append(s.id, { type: "user_message", text: "hi" });
    await store.append(s.id, text("hello"));
    expect(await store.replay(s.id)).toEqual([
      { type: "user_message", text: "hi" },
      text("hello")
    ]);
  });

  it("lists sessions newest-updated first", async () => {
    const a = await store.create("a");
    await new Promise((r) => setTimeout(r, 5));
    const b = await store.create("b");
    await store.append(a.id, text("touch"));
    const listed = await store.list();
    expect(listed[0]!.id).toBe(a.id);
    expect(listed.map((m) => m.id)).toContain(b.id);
  });

  it("resume returns the same event stream as replay", async () => {
    const s = await store.create();
    await store.append(s.id, text("x"));
    expect(await store.resume(s.id)).toEqual(await store.replay(s.id));
  });

  it("fork branches at an offset into a new session", async () => {
    const s = await store.create("origin");
    await store.append(s.id, text("one"));
    await store.append(s.id, text("two"));
    const f = await store.fork(s.id, 1, "branch");
    expect(f.title).toBe("branch");
    expect(await store.replay(f.id)).toEqual([text("one")]);
    expect(await store.replay(s.id)).toEqual([text("one"), text("two")]);
  });

  it("appends metadata in the header line, not the event stream", async () => {
    const s = await store.create("titled");
    await store.append(s.id, text("body"));
    expect(await store.replay(s.id)).toEqual([text("body")]);
  });

  it("records initial settings on create", async () => {
    const s = await store.create("with-settings", {
      model: "google/gemma-4-31B-it",
      effort: "max",
      provider: "local",
      permissionMode: "auto-accept",
    });
    expect(s.settings).toEqual({
      model: "google/gemma-4-31B-it",
      effort: "max",
      provider: "local",
      permissionMode: "auto-accept",
    });
    const meta = await store.getMeta(s.id);
    expect(meta?.settings).toEqual(s.settings);
  });

  it("omit settings when none are provided", async () => {
    const s = await store.create("plain");
    expect(s.settings).toBeUndefined();
    expect((await store.getMeta(s.id))?.settings).toBeUndefined();
  });

  it("updateSettings merges partial settings and survives re-reads", async () => {
    const s = await store.create("seed", { model: "m1", effort: "low" });
    await store.updateSettings(s.id, { model: "m2", provider: "local" });

    const meta = await store.getMeta(s.id);
    expect(meta?.settings).toEqual({ model: "m2", effort: "low", provider: "local" });

    // Ignored undefined values do not clobber existing keys.
    await store.updateSettings(s.id, { permissionMode: "read-only", effort: undefined });
    expect((await store.getMeta(s.id))?.settings).toEqual({
      model: "m2",
      effort: "low",
      provider: "local",
      permissionMode: "read-only",
    });
  });

  it("getMeta returns null for an unknown session", async () => {
    expect(await store.getMeta("does-not-exist")).toBeNull();
  });

  it("fork preserves the origin session's settings", async () => {
    const s = await store.create("origin", { model: "m1", provider: "hf" });
    await store.append(s.id, text("one"));
    const f = await store.fork(s.id, 1, "branch");
    expect(f.settings).toEqual({ model: "m1", provider: "hf" });
    expect((await store.getMeta(f.id))?.settings).toEqual({ model: "m1", provider: "hf" });
  });

  it("deletes a session so it no longer lists or replays", async () => {
    const doomed = await store.create("doomed");
    const kept = await store.create("kept");
    await store.append(doomed.id, text("bye"));

    await store.delete(doomed.id);

    expect((await store.list()).map((m) => m.id)).not.toContain(doomed.id);
    expect((await store.list()).map((m) => m.id)).toContain(kept.id);
    expect(await store.getMeta(doomed.id)).toBeNull();
    await expect(store.replay(doomed.id)).rejects.toThrow();
  });

  it("rejects deleting an unknown session", async () => {
    await expect(store.delete("missing")).rejects.toThrow(/not found/i);
  });
});

describe("SessionStore backups", () => {
  it("backs up a session into a timestamped file under backups/", async () => {
    const s = await store.create("backup-me", { model: "m1", provider: "local" });
    await store.append(s.id, { type: "user_message", text: "hi" });
    await store.append(s.id, text("hello"));

    const result = await store.backup(s.id);
    expect(result.id.startsWith(`${s.id}.backup-`)).toBe(true);
    expect(result.backupPath).toContain(join("backups"));
    expect(existsSync(result.backupPath)).toBe(true);
  });

  it("lists backups newest-first with original id and path", async () => {
    const a = await store.create("a");
    await store.append(a.id, text("a1"));
    const first = await store.backup(a.id);
    await new Promise((r) => setTimeout(r, 10));
    const second = await store.backup(a.id);

    const backups = await store.listBackups();
    expect(backups).toHaveLength(2);
    expect(backups[0]!.id).toBe(second.id);
    expect(backups[1]!.id).toBe(first.id);
    expect(backups.every((b) => b.originalId === a.id)).toBe(true);
    expect(backups[0]!.backupPath).toBe(second.backupPath);
    // Listing does not leak backups as regular sessions.
    expect((await store.list()).map((m) => m.id)).toEqual([a.id]);
  });

  it("returns an empty list when no backups exist", async () => {
    expect(await store.listBackups()).toEqual([]);
  });

  it("restores a backup into a new session preserving events and settings", async () => {
    const s = await store.create("restorable", {
      model: "m9",
      effort: "high",
      provider: "local",
      permissionMode: "read-only",
    });
    await store.append(s.id, { type: "user_message", text: "hi" });
    await store.append(s.id, text("world"));

    const backup = await store.backup(s.id);
    const restored = await store.restoreBackup(backup.backupPath, "restored");

    expect(restored.id).not.toBe(s.id);
    expect(restored.title).toBe("restored");
    expect(restored.settings).toEqual({
      model: "m9",
      effort: "high",
      provider: "local",
      permissionMode: "read-only",
    });
    expect(await store.replay(restored.id)).toEqual([
      { type: "user_message", text: "hi" },
      text("world"),
    ]);
    // The original is untouched.
    expect(await store.replay(s.id)).toEqual([
      { type: "user_message", text: "hi" },
      text("world"),
    ]);
  });

  it("keeps backups in an explicitly configured directory", async () => {
    const s = await store.create("explicit");
    const dir = mkdtempSync(join(tmpdir(), "t3os-backups-"));
    const backup = await store.backup(s.id, dir);
    expect(backup.backupPath.startsWith(dir)).toBe(true);
    const listed = await store.listBackups(dir);
    expect(listed.map((b) => b.originalId)).toEqual([s.id]);
  });
});
