import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { editFileTool, writeFileTool } from "../src/tools/write.js";
import type { ToolContext } from "../src/tools/types.js";

let root: string;
let ctx: ToolContext;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "t3os-write-"));
  writeFileSync(join(root, "f.txt"), "one\ntwo\nthree\n");
  ctx = { root };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("write_file", () => {
  it("creates a new file and reports a diff", async () => {
    const result = await writeFileTool.run({ path: "new.txt", content: "hi\n" }, ctx);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "new.txt"), "utf8")).toBe("hi\n");
    expect(result.content).toContain("+++ b/new.txt");
  });
});

describe("edit_file", () => {
  it("replaces a unique substring and returns the diff", async () => {
    const result = await editFileTool.run({ path: "f.txt", oldString: "two", newString: "TWO" }, ctx);
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, "f.txt"), "utf8")).toBe("one\nTWO\nthree\n");
    expect(result.content).toContain("+TWO");
  });

  it("fails when oldString is absent", async () => {
    const result = await editFileTool.run({ path: "f.txt", oldString: "absent", newString: "x" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/not found/);
  });

  it("fails when oldString is ambiguous", async () => {
    const result = await editFileTool.run({ path: "f.txt", oldString: "e", newString: "x" }, ctx);
    expect(result.ok).toBe(false);
    expect(result.content).toMatch(/appears 3 times/);
  });
});
