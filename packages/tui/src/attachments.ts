import * as fs from "node:fs";
import * as path from "node:path";

/**
 * A file or directory the user dragged/dropped (or pasted) into the prompt.
 *
 * `path` keeps the cleaned path exactly as the terminal delivered it (minus
 * `file://` prefixes, quotes and escaped spaces) so it stays copy-pasteable
 * and matchable against the filesystem.
 */
export interface AttachmentItem {
  /** Cleaned filesystem path of the attachment. */
  path: string;
  /** Basename shown in the attachment chip. */
  name: string;
  /** Whether the path points at a directory. */
  isDirectory: boolean;
  /** Human-readable file size (e.g. "1.2 KB"); undefined for directories. */
  size?: string;
  /** Number of entries inside the directory; undefined for files. */
  itemCount?: number;
}

/** Default cap on how much of a single attached file is inlined. */
export const DEFAULT_MAX_BYTES_PER_FILE = 32 * 1024;

/** Upper bound on directory entries listed for an attached directory. */
const MAX_DIRECTORY_ENTRIES = 500;

/** Human-readable byte size, e.g. `512 B`, `1.2 KB`, `2.8 MB`. */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(1)} ${units[index] ?? "TB"}`;
}

/**
 * Removes terminal quoting from a single dropped token: strips `file://` URL
 * prefixes (including the optional `localhost` host), URL-decodes what is left
 * and trims surrounding whitespace.
 */
function cleanToken(raw: string): string {
  let value = raw.trim();
  if (/^file:\/\//i.test(value)) {
    value = value.replace(/^file:\/\//i, "");
    // `file://localhost/tmp/x` → `/tmp/x`
    value = value.replace(/^localhost(?=\/|$)/i, "");
    try {
      value = decodeURIComponent(value);
    } catch {
      // Not valid percent-encoding: keep the raw text.
    }
  }
  return value;
}

/**
 * Splits a dragged/pasted chunk into candidate path tokens.
 *
 * Handles the shapes terminals produce for dropped paths: multiple
 * newline-separated paths, single/double quoted paths containing spaces and
 * backslash-escaped spaces (`/a/b\ c.txt`). Quotes and escapes are removed but
 * existence is not checked here (see {@link parseDroppedPaths}).
 */
export function tokenizePathCandidates(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < input.length; i += 1) {
    const ch = input.charAt(i);

    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      const next = input.charAt(i + 1);
      if (ch === "\\" && (next === quote || next === "\\")) {
        current += next;
        i += 1;
        started = true;
        continue;
      }
      current += ch;
      started = true;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }

    if (ch === "\\") {
      const next = input.charAt(i + 1);
      if (next === " " || next === "\\" || next === '"' || next === "'") {
        current += next;
        i += 1;
        started = true;
        continue;
      }
    }

    if (/\s/.test(ch)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }

    current += ch;
    started = true;
  }

  if (started) tokens.push(current);

  return tokens.map(cleanToken).filter((token) => token.length > 0);
}

/** `fs.existsSync` that never throws (invalid paths, permission errors, …). */
function pathExists(candidate: string): boolean {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
}

/**
 * Extracts the filesystem paths from a dragged/pasted chunk.
 *
 * The whole chunk is tried first so a single unescaped path containing spaces
 * (e.g. `file:///tmp/my file.txt`) still resolves as one path; otherwise the
 * chunk is split into tokens (quotes, `file://`, escaped spaces handled) and
 * only tokens that actually exist on disk are kept, so pasted prose is ignored.
 */
export function parseDroppedPaths(input: string): string[] {
  if (!input) return [];
  const whole = cleanToken(input);
  if (whole.includes("/") && pathExists(whole)) return [whole];
  return tokenizePathCandidates(input).filter((candidate) => pathExists(candidate));
}

/**
 * Decides whether a pasted/dropped chunk should become attachments rather than
 * raw input text: the chunk must resolve entirely to existing paths and look
 * path-like (contain a separator), which keeps ordinary pasted prose — or fast
 * typing that arrives as one chunk — as plain text.
 */
export function isPathDrop(input: string): boolean {
  if (!input) return false;
  const whole = cleanToken(input);
  if (whole.includes("/") && pathExists(whole)) return true;

  const candidates = tokenizePathCandidates(input);
  if (candidates.length === 0) return false;
  if (!candidates.some((candidate) => candidate.includes("/"))) return false;
  return candidates.every((candidate) => pathExists(candidate));
}

/**
 * Inspects a path and builds the attachment metadata shown in the input chip.
 * Returns `null` when the path cannot be stat-ed (missing, unreadable, …).
 */
export function createAttachment(filePath: string): AttachmentItem | null {
  try {
    const stats = fs.statSync(filePath);
    const trimmed = filePath.replace(/[\\/]+$/, "");
    const name = path.basename(trimmed) || trimmed || filePath;

    if (stats.isDirectory()) {
      let itemCount = 0;
      try {
        itemCount = fs.readdirSync(filePath).length;
      } catch {
        itemCount = 0;
      }
      return { path: filePath, name, isDirectory: true, itemCount };
    }

    return { path: filePath, name, isDirectory: false, size: formatSize(stats.size) };
  } catch {
    return null;
  }
}

/** Read at most `maxBytes` from `filePath` without loading huge files whole. */
function readFileCapped(
  filePath: string,
  maxBytes: number,
): { text: string; bytesRead: number; totalBytes: number } | { error: string } {
  try {
    const stats = fs.statSync(filePath);
    const bytesToRead = Math.max(0, Math.min(stats.size, maxBytes));
    const buffer = Buffer.alloc(bytesToRead);
    const fd = fs.openSync(filePath, "r");
    let bytesRead = 0;
    try {
      bytesRead = bytesToRead > 0 ? fs.readSync(fd, buffer, 0, bytesToRead, 0) : 0;
    } finally {
      fs.closeSync(fd);
    }
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    // A byte-capped read can split a multi-byte character; drop the fragment.
    if (bytesRead < stats.size) text = text.replace(/\uFFFD$/, "");
    return { text, bytesRead, totalBytes: stats.size };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Wraps content in a code fence, widening the fence if content contains one. */
function fence(content: string): string {
  const ticks = content.includes("```") ? "````" : "```";
  return `${ticks}\n${content}\n${ticks}`;
}

/** Markdown listing of a directory's entries (capped). */
function renderDirectoryListing(dir: string): string {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `_(could not read directory: ${detail})_`;
  }

  const shown = entries.slice(0, MAX_DIRECTORY_ENTRIES);
  const lines = shown.map((entry) => `${entry.isDirectory() ? "📁 " : "📄 "}${entry.name}`);
  if (entries.length > shown.length) {
    lines.push(`… (${entries.length - shown.length} more entries)`);
  }
  if (lines.length === 0) lines.push("(empty directory)");
  return fence(lines.join("\n"));
}

/** Markdown block describing one attachment, inlining file contents/listings. */
function renderAttachment(
  attachment: AttachmentItem,
  maxBytesPerFile: number,
): string {
  if (attachment.isDirectory) {
    const count = attachment.itemCount ?? 0;
    return [
      `### 📁 ${attachment.name} (${count} ${count === 1 ? "item" : "items"})`,
      `Path: ${attachment.path}`,
      "",
      renderDirectoryListing(attachment.path),
    ].join("\n");
  }

  const sizeLabel = attachment.size ? ` (${attachment.size})` : "";
  const read = readFileCapped(attachment.path, maxBytesPerFile);
  if ("error" in read) {
    return [
      `### 📄 ${attachment.name}${sizeLabel}`,
      `Path: ${attachment.path}`,
      "",
      `_(could not read file: ${read.error})_`,
    ].join("\n");
  }

  const blocks = [`### 📄 ${attachment.name}${sizeLabel}`, `Path: ${attachment.path}`, ""];
  blocks.push(fence(read.text));
  if (read.bytesRead < read.totalBytes) {
    blocks.push(
      `_(truncated to ${formatSize(read.bytesRead)} of ${formatSize(read.totalBytes)})_`,
    );
  }
  return blocks.join("\n");
}

/**
 * Formats attachments into markdown context blocks: file contents (safely
 * capped at `maxBytesPerFile`, default 32 KB) and directory listings.
 * Returns an empty string when there are no attachments.
 */
export function formatAttachmentsContext(
  attachments: AttachmentItem[],
  maxBytesPerFile: number = DEFAULT_MAX_BYTES_PER_FILE,
): string {
  if (attachments.length === 0) return "";
  const blocks = attachments.map((attachment) =>
    renderAttachment(attachment, maxBytesPerFile),
  );
  return ["## Attached context", ...blocks].join("\n\n");
}

/**
 * Combines the user's prompt text with the attached file/directory context.
 * With no attachments the prompt is returned untouched; with no prompt text a
 * sensible default instruction is used so attachment-only submits still ask
 * something.
 */
export function buildPromptWithAttachments(
  promptText: string,
  attachments: AttachmentItem[],
  maxBytesPerFile: number = DEFAULT_MAX_BYTES_PER_FILE,
): string {
  const context = formatAttachmentsContext(attachments, maxBytesPerFile);
  if (!context) return promptText;

  const base =
    promptText.trim() || "Please inspect and explain the attached file(s)/directory.";
  return `${base}\n\n${context}`;
}
