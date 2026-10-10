import { readFile, writeFile } from "node:fs/promises";
import { unifiedDiff } from "./diff.js";
import { assertNotAborted, resolveInRoot, type Tool, type ToolContext, type ToolResult } from "./types.js";

function asString(args: unknown, key: string): string | undefined {
  const value = (args as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
}

export const writeFileTool: Tool = {
  class: "write",
  schema: {
    name: "write_file",
    description: "Create or overwrite a file, returning the unified diff of the change.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"]
    }
  },
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    assertNotAborted(ctx);
    const path = asString(args, "path");
    const content = asString(args, "content");
    if (!path || content === undefined) return { ok: false, content: "write_file: missing path or content" };
    const absolute = resolveInRoot(ctx.root, path);
    const before = await readFile(absolute, "utf8").catch(() => "");
    await writeFile(absolute, content, "utf8");
    const diff = unifiedDiff(before, content, path);
    return { ok: true, content: diff || `wrote ${path} (no textual change)`, data: { bytes: Buffer.byteLength(content) } };
  }
};

export const editFileTool: Tool = {
  class: "write",
  schema: {
    name: "edit_file",
    description: "Replace an exact substring in a file. Fails when the substring is absent or not unique.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldString: { type: "string" },
        newString: { type: "string" },
        replaceAll: { type: "boolean" }
      },
      required: ["path", "oldString", "newString"]
    }
  },
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    assertNotAborted(ctx);
    const path = asString(args, "path");
    const oldString = asString(args, "oldString");
    const newString = asString(args, "newString");
    if (!path || oldString === undefined || newString === undefined) {
      return { ok: false, content: "edit_file: missing path, oldString or newString" };
    }
    const replaceAll = (args as Record<string, unknown>).replaceAll === true;
    const absolute = resolveInRoot(ctx.root, path);
    const before = await readFile(absolute, "utf8").catch(() => undefined);
    if (before === undefined) return { ok: false, content: `edit_file: ${path} not found` };
    const occurrences = before.split(oldString).length - 1;
    if (occurrences === 0) return { ok: false, content: `edit_file: oldString not found in ${path}` };
    if (occurrences > 1 && !replaceAll) {
      return { ok: false, content: `edit_file: oldString appears ${occurrences} times in ${path}; add more context` };
    }
    const after = before.split(oldString).join(newString);
    await writeFile(absolute, after, "utf8");
    return { ok: true, content: unifiedDiff(before, after, path) };
  }
};

export const WRITE_TOOLS: Tool[] = [writeFileTool, editFileTool];
