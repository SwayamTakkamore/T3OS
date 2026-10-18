import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildPromptWithAttachments,
  createAttachment,
  formatAttachmentsContext,
  formatSize,
  isPathDrop,
  parseDroppedPaths,
  tokenizePathCandidates,
} from "../src/attachments.js";

let tmpDir: string;
let filePath: string;
let spacedFilePath: string;
let dirPath: string;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3os-attachments-"));
  filePath = path.join(tmpDir, "notes.txt");
  fs.writeFileSync(filePath, "hello attachments\nsecond line\n");

  spacedFilePath = path.join(tmpDir, "my file.txt");
  fs.writeFileSync(spacedFilePath, "spaced content");

  dirPath = path.join(tmpDir, "project");
  fs.mkdirSync(dirPath);
  fs.writeFileSync(path.join(dirPath, "index.ts"), "export {};\n");
  fs.mkdirSync(path.join(dirPath, "lib"));
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("formatSize", () => {
  it("formats bytes, kilobytes and megabytes", () => {
    expect(formatSize(0)).toBe("0 B");
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(2048)).toBe("2.0 KB");
    expect(formatSize(1024 * 1024 * 3.5)).toBe("3.5 MB");
  });
});

describe("tokenizePathCandidates", () => {
  it("splits newline separated paths", () => {
    expect(tokenizePathCandidates("/tmp/a.txt\n/tmp/b.txt")).toEqual([
      "/tmp/a.txt",
      "/tmp/b.txt",
    ]);
  });

  it("strips file:// prefixes and URL-decodes", () => {
    expect(tokenizePathCandidates("file:///tmp/a%20b.txt")).toEqual(["/tmp/a b.txt"]);
    expect(tokenizePathCandidates("file://localhost/tmp/c.txt")).toEqual(["/tmp/c.txt"]);
  });

  it("strips single and double quotes", () => {
    expect(tokenizePathCandidates(`'/tmp/a b.txt'`)).toEqual(["/tmp/a b.txt"]);
    expect(tokenizePathCandidates(`"/tmp/a b.txt"`)).toEqual(["/tmp/a b.txt"]);
  });

  it("unescapes backslash-escaped spaces", () => {
    expect(tokenizePathCandidates("/tmp/a\\ b.txt")).toEqual(["/tmp/a b.txt"]);
  });
});

describe("parseDroppedPaths", () => {
  it("returns only paths that exist on disk", () => {
    expect(parseDroppedPaths(filePath)).toEqual([filePath]);
    expect(parseDroppedPaths("/definitely/not/here-12345.txt")).toEqual([]);
  });

  it("handles drops with file:// and quoted/escaped spaces", () => {
    expect(parseDroppedPaths(`file://${spacedFilePath}`)).toEqual([spacedFilePath]);
    expect(parseDroppedPaths(`'${spacedFilePath}'`)).toEqual([spacedFilePath]);
    expect(parseDroppedPaths(spacedFilePath.replace(/ /g, "\\ "))).toEqual([spacedFilePath]);
  });

  it("returns multiple paths from a multi-line drop, keeping only existing ones", () => {
    expect(parseDroppedPaths(`${filePath}\n/nope/missing.txt\n${dirPath}`)).toEqual([
      filePath,
      dirPath,
    ]);
  });

  it("ignores ordinary pasted prose", () => {
    expect(parseDroppedPaths("hello world, please explain things")).toEqual([]);
  });
});

describe("isPathDrop", () => {
  it("accepts existing paths and rejects prose", () => {
    expect(isPathDrop(filePath)).toBe(true);
    expect(isPathDrop(`file://${spacedFilePath}`)).toBe(true);
    expect(isPathDrop("hello world")).toBe(false);
    expect(isPathDrop("/definitely/not/here-999.txt")).toBe(false);
  });

  it("rejects a chunk that mixes prose with a path", () => {
    expect(isPathDrop(`please see ${filePath}`)).toBe(false);
  });
});

describe("createAttachment", () => {
  it("describes a file with a formatted size", () => {
    const attachment = createAttachment(filePath);
    expect(attachment).not.toBeNull();
    expect(attachment).toMatchObject({
      path: filePath,
      name: "notes.txt",
      isDirectory: false,
    });
    expect(attachment?.size).toMatch(/B$/);
  });

  it("describes a directory with an item count", () => {
    const attachment = createAttachment(dirPath);
    expect(attachment).toMatchObject({
      path: dirPath,
      name: "project",
      isDirectory: true,
      itemCount: 2,
    });
    expect(attachment?.size).toBeUndefined();
  });

  it("returns null for missing paths", () => {
    expect(createAttachment(path.join(tmpDir, "does-not-exist"))).toBeNull();
  });
});

describe("formatAttachmentsContext", () => {
  it("returns an empty string without attachments", () => {
    expect(formatAttachmentsContext([])).toBe("");
  });

  it("inlines file contents with a path header", () => {
    const attachment = createAttachment(filePath);
    const context = formatAttachmentsContext(attachment ? [attachment] : []);
    expect(context).toContain("## Attached context");
    expect(context).toContain("📄 notes.txt");
    expect(context).toContain(`Path: ${filePath}`);
    expect(context).toContain("hello attachments");
    expect(context).toContain("second line");
  });

  it("lists directory entries", () => {
    const attachment = createAttachment(dirPath);
    const context = formatAttachmentsContext(attachment ? [attachment] : []);
    expect(context).toContain("📁 project (2 items)");
    expect(context).toContain("index.ts");
    expect(context).toContain("📁 lib");
  });

  it("truncates file contents at maxBytesPerFile", () => {
    const bigPath = path.join(tmpDir, "big.txt");
    fs.writeFileSync(bigPath, "x".repeat(4096));
    const attachment = createAttachment(bigPath);
    const context = formatAttachmentsContext(attachment ? [attachment] : [], 64);
    expect(context).toContain("_(truncated to 64 B of 4.0 KB)_");
    // Only the capped payload is inlined, not the whole file.
    expect(context).not.toContain("x".repeat(1024));
  });
});

describe("buildPromptWithAttachments", () => {
  it("returns the prompt unchanged when there are no attachments", () => {
    expect(buildPromptWithAttachments("just text", [])).toBe("just text");
  });

  it("combines the prompt with attachment context", () => {
    const attachment = createAttachment(filePath);
    const prompt = buildPromptWithAttachments("explain this", attachment ? [attachment] : []);
    expect(prompt.startsWith("explain this")).toBe(true);
    expect(prompt).toContain("## Attached context");
    expect(prompt).toContain("hello attachments");
  });

  it("falls back to a default instruction for attachment-only submits", () => {
    const attachment = createAttachment(filePath);
    const prompt = buildPromptWithAttachments("   ", attachment ? [attachment] : []);
    expect(prompt).toContain("Please inspect and explain the attached file(s)/directory.");
    expect(prompt).toContain("hello attachments");
  });
});
