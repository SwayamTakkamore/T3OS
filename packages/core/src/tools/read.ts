import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { globToRegExp } from "./glob-match.js";
import { assertNotAborted, resolveInRoot, type Tool, type ToolContext, type ToolResult } from "./types.js";

const MAX_GREP_MATCHES = 200;

async function walk(dir: string, root: string, out: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      await walk(full, root, out);
    } else if (entry.isFile()) {
      out.push(relative(root, full).split(sep).join("/"));
    }
  }
}

function asString(args: unknown, key: string): string | undefined {
  const value = (args as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" ? value : undefined;
}

function asNumber(args: unknown, key: string): number | undefined {
  const value = (args as Record<string, unknown> | undefined)?.[key];
  return typeof value === "number" ? value : undefined;
}

export const readFileTool: Tool = {
  class: "read",
  schema: {
    name: "read_file",
    description: "Read a UTF-8 text file, returning lines prefixed with their 1-based line number.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path relative to the workspace root." },
        offset: { type: "number", description: "1-based first line to return." },
        limit: { type: "number", description: "Maximum number of lines to return." }
      },
      required: ["path"]
    }
  },
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    assertNotAborted(ctx);
    const path = asString(args, "path");
    if (!path) return { ok: false, content: "read_file: missing path" };
    const absolute = resolveInRoot(ctx.root, path);
    const raw = await readFile(absolute, "utf8");
    const lines = raw.split("\n");
    const offset = Math.max(1, asNumber(args, "offset") ?? 1);
    const limit = Math.max(1, asNumber(args, "limit") ?? lines.length);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const content = slice.map((line, index) => `${offset + index}: ${line}`).join("\n");
    return { ok: true, content, data: { totalLines: lines.length } };
  }
};

export const listDirTool: Tool = {
  class: "read",
  schema: {
    name: "list_dir",
    description: "List the immediate children of a directory with their kind.",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "Directory relative to the workspace root." } },
      required: []
    }
  },
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    assertNotAborted(ctx);
    const absolute = resolveInRoot(ctx.root, asString(args, "path") ?? ".");
    const entries = await readdir(absolute, { withFileTypes: true });
    const lines = await Promise.all(
      entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async (entry) => {
          const full = join(absolute, entry.name);
          if (entry.isDirectory()) return `${entry.name}/`;
          const info = await stat(full);
          return `${entry.name} (${info.size}b)`;
        })
    );
    return { ok: true, content: lines.join("\n"), data: lines };
  }
};

export const globTool: Tool = {
  class: "read",
  schema: {
    name: "glob",
    description: "Find files by glob pattern (supports * and **), relative to the workspace root.",
    parameters: {
      type: "object",
      properties: { pattern: { type: "string" }, path: { type: "string" } },
      required: ["pattern"]
    }
  },
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    assertNotAborted(ctx);
    const pattern = asString(args, "pattern");
    if (!pattern) return { ok: false, content: "glob: missing pattern" };
    const base = resolveInRoot(ctx.root, asString(args, "path") ?? ".");
    const files: string[] = [];
    await walk(base, ctx.root, files);
    const matcher = globToRegExp(pattern);
    const matches = files.filter((file) => matcher.test(file)).sort();
    return { ok: true, content: matches.join("\n"), data: matches };
  }
};

export const grepTool: Tool = {
  class: "read",
  schema: {
    name: "grep",
    description: "Search file contents by regular expression, returning path:line: text.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        path: { type: "string" },
        include: { type: "string", description: "Glob of files to include, for example *.ts." }
      },
      required: ["pattern"]
    }
  },
  async run(args: unknown, ctx: ToolContext): Promise<ToolResult> {
    assertNotAborted(ctx);
    const pattern = asString(args, "pattern");
    if (!pattern) return { ok: false, content: "grep: missing pattern" };
    const expression = new RegExp(pattern);
    const base = resolveInRoot(ctx.root, asString(args, "path") ?? ".");
    const files: string[] = [];
    await walk(base, ctx.root, files);
    const include = asString(args, "include");
    const includeMatcher = include ? globToRegExp(include) : undefined;
    const matches: string[] = [];
    for (const file of files) {
      if (includeMatcher && !includeMatcher.test(file.split("/").pop() ?? file)) continue;
      if (matches.length >= MAX_GREP_MATCHES) break;
      const text = await readFile(join(ctx.root, file), "utf8").catch(() => "");
      const lines = text.split("\n");
      for (let index = 0; index < lines.length; index += 1) {
        if (expression.test(lines[index]!)) {
          matches.push(`${file}:${index + 1}: ${lines[index]}`);
          if (matches.length >= MAX_GREP_MATCHES) break;
        }
      }
    }
    return { ok: true, content: matches.join("\n"), data: matches };
  }
};

export const READ_TOOLS: Tool[] = [readFileTool, listDirTool, globTool, grepTool];
