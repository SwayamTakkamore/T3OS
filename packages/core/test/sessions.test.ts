import { mkdtempSync } from "node:fs";
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
});
