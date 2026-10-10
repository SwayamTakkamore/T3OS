import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { globToRegExp } from "../src/tools/glob-match.js";
import { globTool, grepTool, listDirTool, readFileTool } from "../src/tools/read.js";
import type { ToolContext } from "../src/tools/types.js";

let root: string;
let ctx: ToolContext;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "t3os-read-"));
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "docs"));
  writeFileSync(join(root, "src", "a.ts"), "const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(root, "src", "b.ts"), "export const c = 3;\n");
  writeFileSync(join(root, "docs", "readme.md"), "# hello\n");
  ctx = { root };
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("globToRegExp", () => {
  it("matches a double-star across directories", () => {
    const re = globToRegExp("src/**/*.ts");
    expect(re.test("src/a.ts")).toBe(true);
    expect(re.test("src/nested/deep/a.ts")).toBe(true);
    expect(re.test("src/a.md")).toBe(false);
  });

  it("treats a single star as one segment", () => {
    expect(globToRegExp("*.ts").test("a.ts")).toBe(true);
    expect(globToRegExp("*.ts").test("dir/a.ts")).toBe(false);
  });
});

describe("read_file", () => {
  it("returns numbered lines within a range", async () => {
    const result = await readFileTool.run({ path: "src/a.ts", offset: 2, limit: 1 }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toBe("2: export const b = 2;");
  });

  it("refuses a path that escapes the root", async () => {
    await expect(readFileTool.run({ path: "../../etc/passwd" }, ctx)).rejects.toThrow(/escapes/);
  });
});

describe("list_dir", () => {
  it("lists entries with their kind", async () => {
    const result = await listDirTool.run({ path: "." }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain("src/");
    expect(result.content).toContain("docs/");
  });
});

describe("glob", () => {
  it("returns matching paths sorted", async () => {
    const result = await globTool.run({ pattern: "src/**/*.ts" }, ctx);
    expect(result.data).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("grep", () => {
  it("reports path:line matches with a file filter", async () => {
    const result = await grepTool.run({ pattern: "export const", include: "*.ts" }, ctx);
    expect(result.content).toContain("src/a.ts:2: export const b = 2;");
    expect(result.content).toContain("src/b.ts:1: export const c = 3;");
    expect(result.content).not.toContain("readme.md");
  });
});
