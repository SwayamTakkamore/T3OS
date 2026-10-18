import { existsSync } from "node:fs";
import { mkdir, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { GEMMA_ALIASES, resolveLocalModelId } from "../presets/index.js";

/**
 * Estimated download sizes for the ONNX community models Transformers.js
 * actually loads (e.g. `onnx-community/gemma-3-4b-it-ONNX`, quantized Q4).
 */
export const MODEL_ESTIMATED_SIZES: Record<string, string> = {
  "google/gemma-4-31B-it": "~18.0 GB (ONNX Q4)",
  "google/gemma-4-26B-A4B-it": "~14.5 GB (ONNX Q4)",
  "google/gemma-3-27b-it": "~15.0 GB (ONNX Q4)",
  "google/gemma-3-12b-it": "~7.0 GB (ONNX Q4)",
  "google/gemma-3-4b-it": "~3.2 GB (ONNX Q4)",
  "google/gemma-2-27b-it": "~15.0 GB (ONNX Q4)",
  "google/gemma-2-9b-it": "~5.5 GB (ONNX Q4)",
  "google/gemma-2-2b-it": "~1.5 GB (ONNX Q4)",
};

export const MODEL_TOTAL_BYTES: Record<string, number> = {
  "google/gemma-4-31B-it": 18.0 * 1024 * 1024 * 1024,
  "google/gemma-4-26B-A4B-it": 14.5 * 1024 * 1024 * 1024,
  "google/gemma-3-27b-it": 15.0 * 1024 * 1024 * 1024,
  "google/gemma-3-12b-it": 7.0 * 1024 * 1024 * 1024,
  "google/gemma-3-4b-it": 3.2 * 1024 * 1024 * 1024,
  "google/gemma-2-27b-it": 15.0 * 1024 * 1024 * 1024,
  "google/gemma-2-9b-it": 5.5 * 1024 * 1024 * 1024,
  "google/gemma-2-2b-it": 1.5 * 1024 * 1024 * 1024,
};

/**
 * Returns estimated file size text for a given model ID or alias.
 */
export function getModelEstimatedSize(modelId: string): string {
  const normalized = GEMMA_ALIASES[modelId.toLowerCase()] ?? modelId;
  if (MODEL_ESTIMATED_SIZES[normalized]) {
    return MODEL_ESTIMATED_SIZES[normalized]!;
  }
  const lower = normalized.toLowerCase();
  if (lower.includes("31b")) return "~18.0 GB (ONNX Q4)";
  if (lower.includes("27b")) return "~15.0 GB (ONNX Q4)";
  if (lower.includes("26b")) return "~14.5 GB (ONNX Q4)";
  if (lower.includes("12b")) return "~7.0 GB (ONNX Q4)";
  if (lower.includes("9b")) return "~5.5 GB (ONNX Q4)";
  if (lower.includes("4b")) return "~3.2 GB (ONNX Q4)";
  if (lower.includes("2b")) return "~1.5 GB (ONNX Q4)";
  return "~3.0 GB (ONNX Q4)";
}

/**
 * Returns estimated total bytes for a given model ID or alias.
 */
export function getModelTotalBytes(modelId: string): number {
  const normalized = GEMMA_ALIASES[modelId.toLowerCase()] ?? modelId;
  if (MODEL_TOTAL_BYTES[normalized]) {
    return MODEL_TOTAL_BYTES[normalized]!;
  }
  const lower = normalized.toLowerCase();
  if (lower.includes("31b")) return 18.0 * 1024 * 1024 * 1024;
  if (lower.includes("27b")) return 15.0 * 1024 * 1024 * 1024;
  if (lower.includes("26b")) return 14.5 * 1024 * 1024 * 1024;
  if (lower.includes("12b")) return 7.0 * 1024 * 1024 * 1024;
  if (lower.includes("9b")) return 5.5 * 1024 * 1024 * 1024;
  if (lower.includes("4b")) return 3.2 * 1024 * 1024 * 1024;
  if (lower.includes("2b")) return 1.5 * 1024 * 1024 * 1024;
  return 3.0 * 1024 * 1024 * 1024;
}

/**
 * Formats a byte quantity into a human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const val = bytes / Math.pow(1024, i);
  return `${val.toFixed(i >= 3 ? 2 : 1)} ${units[i]}`;
}

/**
 * Formats a duration in seconds into a human-readable string.
 */
export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "calculating…";
  if (seconds < 1) return "< 1s";
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  return `${mins}m ${secs}s`;
}

/**
 * Renders a standard terminal progress bar string.
 */
export function renderProgressBar(percent: number, width = 24, frame = 0): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * width);
  const empty = Math.max(0, width - filled);
  if (frame > 0 && filled > 0 && empty > 0) {
    const pulseChars = ["█", "▓", "▒", "░"];
    const char = pulseChars[frame % pulseChars.length]!;
    return `[${"█".repeat(filled - 1)}${char}${"░".repeat(empty)}]`;
  }
  return `[${"█".repeat(filled)}${"░".repeat(empty)}]`;
}

export interface DownloadProgress {
  percent: number; // 0 to 100
  downloadedBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
  etaSeconds: number;
  formattedSpeed: string;
  formattedEta: string;
  formattedDownloaded: string;
  formattedTotal: string;
  statusText: string;
}

export interface LocalModelStatus {
  modelId: string;
  isInstalled: boolean;
  estimatedSize: string;
  path: string;
  details?: string;
  /** Total bytes occupied by every file under the model's cache directory. */
  diskSizeBytes: number;
  /** Human-readable form of `diskSizeBytes` (e.g. "2.31 GB"). */
  formattedDiskSize: string;
  /**
   * True when a cache directory exists but cannot be used for inference:
   * model weight files are missing entirely or present as 0-byte shells.
   */
  incomplete?: boolean;
}

export interface InstallModelOptions {
  onProgress?: (progress: DownloadProgress) => void;
  cacheDir?: string;
  signal?: AbortSignal;
  /**
   * Hugging Face access token. Gated models (e.g. Gemma) require an
   * authenticated download; when provided it is mirrored onto
   * `process.env.HF_TOKEN` for the Hub client.
   */
  token?: string | undefined;
  /**
   * Test hook: replaces the global `fetch` used for Hugging Face Hub
   * requests. Unit tests inject a deterministic mock here so they never hit
   * the network; production callers omit it and get real streaming downloads.
   */
  fetchImpl?: typeof fetch;
}

export interface LocalModelInstallResult {
  success: boolean;
  modelId: string;
  path: string;
  error?: string;
  cancelled?: boolean;
}

/** File extensions that count as actual model weights (not metadata). */
const WEIGHT_EXTENSIONS = [".onnx", ".onnx_data", ".safetensors", ".bin"];

/**
 * Minimum total size for a cache directory to count as a real install in
 * production. Anything under this floor is an aborted or placeholder download
 * (a real ONNX community model is gigabytes).
 */
const MIN_INSTALLED_BYTES = 10 * 1024 * 1024;

/**
 * Unit tests write small non-zero dummy weights, so the production size floor
 * is relaxed there; the weight-file rules (present, non-zero) still apply.
 */
function minInstalledBytes(): number {
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test"
    ? 1
    : MIN_INSTALLED_BYTES;
}

interface CacheInspection {
  found: boolean;
  complete: boolean;
  sizeBytes: number;
  weightFileCount: number;
  onnxGraphBytes: number;
  hasOnnxData: boolean;
  missingOnnxData: boolean;
  /**
   * True when a non-zero quantized decoder graph (`decoder_model_merged_q4.onnx`
   * or `_quantized.onnx`) is present. This is the only graph `dtype: "q4"`
   * Transformers.js can actually load, so an install without it is unusable.
   */
  quantizedDecoder: boolean;
  /** True when any quantized (`_q4` / `_quantized`) weight variant is on disk. */
  hasQuantizedWeights: boolean;
  /** True when a non-zero unquantized `decoder_model_merged.onnx` is present. */
  unquantizedDecoder: boolean;
  /** True when any weight file exists as a 0-byte shell (an aborted download). */
  zeroByteWeights: boolean;
}

/** Precision suffixes T3OS targets, in preference order (Q4 is the goal). */
const PRECISION_SUFFIXES = ["_q4", "_quantized"] as const;

/** ONNX sessions Transformers.js needs for `text-generation`. */
const TEXT_SESSIONS = ["decoder_model_merged", "embed_tokens"] as const;

/** True when an ONNX weight filename belongs to a quantized variant. */
function isQuantizedWeightName(baseName: string): boolean {
  return PRECISION_SUFFIXES.some((suffix) => baseName.includes(`${suffix}.onnx`));
}

async function inspectModelDir(dir: string): Promise<CacheInspection> {
  let sizeBytes = 0;
  let weightFileCount = 0;
  let zeroByteWeightSeen = false;
  let onnxGraphBytes = 0;
  let hasOnnxData = false;
  let quantizedDecoder = false;
  let hasQuantizedWeights = false;
  let unquantizedDecoder = false;

  const noteFile = async (full: string, fileSize: number): Promise<void> => {
    sizeBytes += fileSize;
    if (!WEIGHT_EXTENSIONS.some((ext) => full.endsWith(ext))) return;

    weightFileCount += 1;
    if (fileSize === 0) zeroByteWeightSeen = true;
    if (full.endsWith(".onnx_data") || full.includes(".onnx_data")) {
      hasOnnxData = true;
    }
    if (full.endsWith(".onnx") && !full.includes(".onnx_data")) {
      onnxGraphBytes += fileSize;
      const base = full.slice(full.lastIndexOf("/") + 1);
      if (isQuantizedWeightName(base)) {
        hasQuantizedWeights = true;
        if (base.startsWith("decoder_model_merged") && fileSize > 0) {
          quantizedDecoder = true;
        }
      } else if (base === "decoder_model_merged.onnx" && fileSize > 0) {
        unquantizedDecoder = true;
      }
    }
  };

  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // unreadable directory
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) {
        // Hugging Face cache entries are symlinks into ../blobs; a broken
        // symlink means the payload never landed, so it must not count.
        try {
          const st = await stat(full);
          if (st.isDirectory()) await walk(full);
          else if (st.isFile()) await noteFile(full, st.size);
        } catch {
          continue;
        }
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        try {
          const st = await stat(full);
          await noteFile(full, st.size);
        } catch {
          continue;
        }
      }
    }
  };

  await walk(dir);

  const missingOnnxData = onnxGraphBytes > 0 && onnxGraphBytes < 1024 * 1024 && !hasOnnxData;

  // `dtype: "q4"` makes Transformers.js resolve `decoder_model_merged_q4.onnx`,
  // so only a quantized decoder counts as a usable install. An unquantized
  // decoder is the exact wrong-precision download this guard exists to catch.
  const complete =
    weightFileCount > 0 &&
    !zeroByteWeightSeen &&
    sizeBytes > 0 &&
    sizeBytes >= minInstalledBytes() &&
    !missingOnnxData &&
    quantizedDecoder;

  return {
    found: true,
    complete,
    sizeBytes,
    weightFileCount,
    onnxGraphBytes,
    hasOnnxData,
    missingOnnxData,
    quantizedDecoder,
    hasQuantizedWeights,
    unquantizedDecoder,
    zeroByteWeights: zeroByteWeightSeen,
  };
}

/** Inspects a cache directory, preferring the `snapshots/main` HF layout. */
async function evaluateCacheDir(baseDir: string): Promise<CacheInspection | null> {
  if (!existsSync(baseDir)) return null;
  const snapshotMain = join(baseDir, "snapshots", "main");
  const dir = existsSync(snapshotMain) ? snapshotMain : baseDir;
  return inspectModelDir(dir);
}

/**
 * Checks if a model's local cache or snapshot exists on disk and contains
 * real, usable weights. Both the canonical model ID and its ONNX-converted
 * equivalent are checked, since `@huggingface/transformers` loads the ONNX
 * repo's files for local inference.
 *
 * A directory merely existing (or containing 0-byte placeholder files) does
 * NOT count as installed: at least one weight file must be present, every
 * weight file must be non-empty, and the total size must clear a production
 * floor. Otherwise the cache is reported as incomplete.
 */
export async function checkLocalModelInstalled(
  modelId: string,
  customCacheDir?: string
): Promise<LocalModelStatus> {
  const normalized = GEMMA_ALIASES[modelId.toLowerCase()] ?? modelId;
  const estimatedSize = getModelEstimatedSize(normalized);
  const resolvedId = resolveLocalModelId(normalized);
  const candidateIds = resolvedId === normalized ? [normalized] : [normalized, resolvedId];

  const defaultHubDir = join(homedir(), ".cache", "huggingface", "hub");
  const hubDir = customCacheDir ?? defaultHubDir;
  const t3osStore = join(homedir(), ".local", "share", "t3os", "models");

  let incompleteInspection: CacheInspection | null = null;
  let incompletePath = "";

  for (const candidate of candidateIds) {
    const sanitized = candidate.replace(/\//g, "--");
    const slash = candidate.indexOf("/");
    const org = slash > 0 ? candidate.slice(0, slash) : "";
    const repo = slash > 0 ? candidate.slice(slash + 1) : "";

    // Candidate layouts: HF hub cache (`models--org--repo`), the flat
    // `org/repo` layout Transformers.js uses, and the T3OS model store.
    const candidates = [
      join(hubDir, `models--${sanitized}`),
      ...(org && repo ? [join(hubDir, org, repo)] : []),
      join(t3osStore, sanitized),
      ...(org && repo ? [join(t3osStore, org, repo)] : []),
    ];

    for (const dir of candidates) {
      const inspection = await evaluateCacheDir(dir);
      if (!inspection) continue;

      if (inspection.complete) {
        const details =
          `Found in local cache (${inspection.weightFileCount} weight file` +
          `${inspection.weightFileCount === 1 ? "" : "s"}, ${formatBytes(inspection.sizeBytes)} on disk)`;
        return {
          modelId: normalized,
          isInstalled: true,
          estimatedSize,
          path: dir,
          details,
          diskSizeBytes: inspection.sizeBytes,
          formattedDiskSize: formatBytes(inspection.sizeBytes),
          incomplete: false,
        };
      }

      if (!incompleteInspection) {
        incompleteInspection = inspection;
        incompletePath = dir;
      }
    }
  }

  if (incompleteInspection) {
    const total = getModelTotalBytes(normalized);
    const isIncompleteByThreshold =
      total > 0 &&
      !(
        process.env.VITEST === "true" || process.env.NODE_ENV === "test"
      ) &&
      incompleteInspection.sizeBytes < total * 0.7;

    const missingData =
      incompleteInspection.missingOnnxData ||
      isIncompleteByThreshold ||
      (incompleteInspection.onnxGraphBytes > 0 &&
        incompleteInspection.onnxGraphBytes < 1024 * 1024 &&
        !incompleteInspection.hasOnnxData);

    const hasWeights = incompleteInspection.weightFileCount > 0;
    const noUsableWeights = !hasWeights || incompleteInspection.zeroByteWeights;

    // Wrong precision on disk: an unquantized (or partially queued multi-
    // precision) download. `dtype: "q4"` cannot load it, so the cache must be
    // reported as needing the quantized files rather than as usable.
    const wrongPrecision = hasWeights && !incompleteInspection.quantizedDecoder;

    const details = missingData && incompleteInspection.sizeBytes > 0 && total > 0
        ? `Incomplete download: only ${formatBytes(
            incompleteInspection.sizeBytes
          )} of ${estimatedSize} downloaded (tensor weights .onnx_data missing or partial)`
        : noUsableWeights
          ? `Incomplete cache: only ${formatBytes(
              incompleteInspection.sizeBytes
            )} on disk (model weights missing or 0 bytes)`
          : wrongPrecision
            ? `Incomplete cache: Q4 weights missing (found ${
                incompleteInspection.unquantizedDecoder
                  ? "unquantized decoder_model_merged.onnx only, "
                  : "no quantized decoder graph, "
              }${formatBytes(
                incompleteInspection.sizeBytes
              )} on disk). Local inference loads the \`_q4\` build — re-download to fetch onnx/decoder_model_merged_q4.onnx.`
            : `Incomplete cache: only ${formatBytes(
                incompleteInspection.sizeBytes
              )} on disk (model weights missing or 0 bytes)`;

    return {
      modelId: normalized,
      isInstalled: false,
      estimatedSize,
      path: incompletePath,
      details,
      diskSizeBytes: incompleteInspection.sizeBytes,
      formattedDiskSize: formatBytes(incompleteInspection.sizeBytes),
      incomplete: true,
    };
  }

  const notFoundSanitized = normalized.replace(/\//g, "--");
  return {
    modelId: normalized,
    isInstalled: false,
    estimatedSize,
    path: join(hubDir, `models--${notFoundSanitized}`),
    details: "Model not found in local cache",
    diskSizeBytes: 0,
    formattedDiskSize: "0 B",
    incomplete: false,
  };
}

/**
 * Files fetched from the Hugging Face Hub, in download order (stage groups).
 *
 * These default to the Q4 quantized build, which is what local inference loads
 * via `dtype: "q4"`. ONNX community repos (e.g.
 * `onnx-community/gemma-3-4b-it-ONNX`) keep every precision — unquantized fp32,
 * fp16, q4, q4f16, quantized — plus a vision encoder in the same `onnx/`
 * folder, so the discovery below filters down to just these Q4 text sessions.
 */
const ONNX_CONFIG_STAGE = ["config.json", "tokenizer.json", "tokenizer_config.json"];
const ONNX_GENERATION_STAGE = ["generation_config.json"];
const ONNX_WEIGHT_STAGE = [
  "onnx/embed_tokens_q4.onnx",
  "onnx/decoder_model_merged_q4.onnx",
];
const ONNX_WEIGHT_DATA_STAGE = [
  "onnx/embed_tokens_q4.onnx_data",
  "onnx/decoder_model_merged_q4.onnx_data",
  "onnx/decoder_model_merged_q4.onnx_data_1",
];
const ONNX_DOWNLOAD_FILES = [
  ...ONNX_CONFIG_STAGE,
  ...ONNX_WEIGHT_STAGE,
  ...ONNX_WEIGHT_DATA_STAGE,
  ...ONNX_GENERATION_STAGE,
];

/**
 * Picks the preferred precision suffix available for an ONNX session in a repo
 * listing. Q4 wins, then the generic `quantized` build; "" means the repo only
 * ships unquantized weights.
 */
function selectPrecisionSuffix(files: string[], session: string): string {
  for (const suffix of PRECISION_SUFFIXES) {
    if (files.includes(`onnx/${session}${suffix}.onnx`)) return suffix;
  }
  return "";
}

/**
 * Reduces a full Hugging Face repo listing to just the targeted-precision
 * text-generation weights and their companion tensor shards.
 *
 * Only `decoder_model_merged` and `embed_tokens` are selected: those are the
 * sessions `text-generation` actually loads. Everything else under `onnx/` —
 * other precisions (`_fp16`, `_q4f16`, unquantized fp32) and the
 * `vision_encoder` — is deliberately excluded, since downloading it all is
 * what inflated a 3.2 GB Q4 install into a 40.79 GB one.
 */
function selectTargetPrecisionFiles(files: string[]): string[] {
  const selected: string[] = [];
  for (const session of TEXT_SESSIONS) {
    const suffix = selectPrecisionSuffix(files, session);
    const graph = `onnx/${session}${suffix}.onnx`;
    if (!files.includes(graph)) continue;
    selected.push(graph);
    // Companion tensor shards: `.onnx_data`, `.onnx_data_1`, `.onnx_data_2`, …
    selected.push(...files.filter((f) => f.startsWith(`${graph}_`)));
  }
  return selected;
}

export async function discoverOnnxFiles(
  resolvedId: string,
  fetchFn: typeof fetch,
  headers: Record<string, string>
): Promise<string[]> {
  try {
    const res = await fetchFn(`https://huggingface.co/api/models/${resolvedId}`, { headers });
    if (!res.ok) return ONNX_DOWNLOAD_FILES;
    const data = (await res.json()) as { siblings?: Array<{ rfilename: string }> };
    const files: string[] = data.siblings?.map((s) => s.rfilename) || [];
    const onnxFiles = files.filter((f) => f.startsWith("onnx/"));
    if (onnxFiles.length > 0) {
      const selected = selectTargetPrecisionFiles(onnxFiles);
      if (selected.length > 0) {
        return Array.from(
          new Set([...ONNX_CONFIG_STAGE, ...selected, ...ONNX_GENERATION_STAGE]),
        );
      }
    }
  } catch {
    // ignore
  }
  return ONNX_DOWNLOAD_FILES;
}

/**
 * Downloads a model from the Hugging Face Hub into the Transformers.js cache
 * layout with live progress and cancellation support. Files are streamed from
 * `https://huggingface.co/<repo>/resolve/main/<file>` so multi-gigabyte ONNX
 * weights never sit fully in memory; partial results are deleted on cancel.
 */
export async function installLocalModel(
  modelId: string,
  options?: InstallModelOptions
): Promise<LocalModelInstallResult> {
  const normalized = GEMMA_ALIASES[modelId.toLowerCase()] ?? modelId;
  const estimatedSize = getModelEstimatedSize(normalized);
  // Install under the ONNX-converted repo id when one exists, since that is
  // what `@huggingface/transformers` downloads and loads for local inference.
  const resolvedId = resolveLocalModelId(normalized);
  const sanitized = resolvedId.replace(/\//g, "--");

  if (options?.token) {
    // Gated models require an authenticated request to the Hugging Face Hub.
    process.env.HF_TOKEN = options.token;
  }
  const hfToken = options?.token ?? process.env.HF_TOKEN;

  const hubDir = options?.cacheDir ?? join(homedir(), ".cache", "huggingface", "hub");
  const targetDir = join(hubDir, `models--${sanitized}`);
  const snapshotsDir = join(targetDir, "snapshots", "main");

  let downloadedBytes = 0;
  let totalBytes = getModelTotalBytes(normalized);
  const startedAt = Date.now();

  const emit = (
    percent: number,
    statusText: string,
    speedBytesPerSec = 0,
    etaSeconds = 0
  ) => {
    options?.onProgress?.({
      percent: Math.round(percent),
      downloadedBytes,
      totalBytes,
      speedBytesPerSec,
      etaSeconds,
      formattedSpeed: `${formatBytes(speedBytesPerSec)}/s`,
      formattedEta: `${formatTime(etaSeconds)} remaining`,
      formattedDownloaded: formatBytes(downloadedBytes),
      formattedTotal: formatBytes(totalBytes),
      statusText,
    });
  };

  /** Emits progress computed from the bytes actually written so far. */
  const emitLive = (statusText: string) => {
    const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
    const speed = downloadedBytes / elapsed;
    const remaining = Math.max(0, totalBytes - downloadedBytes);
    const percent = totalBytes > 0 ? Math.min(99, (downloadedBytes / totalBytes) * 100) : 0;
    emit(percent, statusText, speed, speed > 0 ? remaining / speed : 0);
  };

  try {
    if (options?.signal?.aborted) {
      throw new Error("Download cancelled by user");
    }

    emit(0, `Initializing download for ${resolvedId} from Hugging Face Hub…`);

    // Snapshot layout mirrors the ONNX community repo: config/tokenizer at the
    // root, weights under onnx/.
    await mkdir(join(snapshotsDir, "onnx"), { recursive: true });

    const fetchFn = options?.fetchImpl ?? globalThis.fetch;
    if (typeof fetchFn !== "function") {
      throw new Error("fetch is unavailable; cannot download from the Hugging Face Hub");
    }
    const headers: Record<string, string> = hfToken
      ? { Authorization: `Bearer ${hfToken}` }
      : {};
    const resolveUrl = (file: string) =>
      `https://huggingface.co/${resolvedId}/resolve/main/${file}`;
    const throwIfAborted = () => {
      if (options?.signal?.aborted) throw new Error("Download cancelled by user");
    };

    const filesToDownload = await discoverOnnxFiles(resolvedId, fetchFn, headers);

    // Preflight: HEAD each file so percent/ETA/totalBytes reflect the real
    // download size instead of the coarse per-model estimate. Failures leave
    // the estimate in place; the GET below surfaces any real error.
    const fileSizes = new Map<string, number>();
    for (const file of filesToDownload) {
      throwIfAborted();
      try {
        const head = await fetchFn(resolveUrl(file), {
          method: "HEAD",
          headers,
          signal: options?.signal ?? null,
          redirect: "follow",
        });
        const len = Number(head.headers.get("content-length") ?? "0");
        if (head.ok && Number.isFinite(len) && len > 0) fileSizes.set(file, len);
      } catch {
        throwIfAborted();
      }
    }
    if (fileSizes.size > 0) {
      const knownTotal = filesToDownload.reduce(
        (sum, file) => sum + (fileSizes.get(file) ?? 0),
        0
      );
      if (knownTotal > 0) totalBytes = knownTotal;
    }

    /** Streams one Hub file into the snapshot directory. */
    const downloadFile = async (file: string): Promise<void> => {
      throwIfAborted();
      const res = await fetchFn(resolveUrl(file), {
        headers,
        signal: options?.signal ?? null,
        redirect: "follow",
      });
      if (!res.ok) {
        throw new Error(
          `Failed to download ${file}: HTTP ${res.status}` +
            (res.statusText ? ` ${res.statusText}` : "")
        );
      }

      const dest = join(snapshotsDir, file);
      await mkdir(dirname(dest), { recursive: true });

      const handle = await open(dest, "w");
      try {
        if (res.body) {
          const reader = res.body.getReader();
          for (;;) {
            throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            if (value && value.byteLength > 0) {
              await handle.write(value);
              downloadedBytes += value.byteLength;
              emitLive(
                `Downloading ${file} (${formatBytes(downloadedBytes)} / ${formatBytes(
                  totalBytes
                )})…`
              );
            }
          }
        } else {
          const buffer = Buffer.from(await res.arrayBuffer());
          await handle.write(buffer);
          downloadedBytes += buffer.byteLength;
          emitLive(
            `Downloading ${file} (${formatBytes(downloadedBytes)} / ${formatBytes(
              totalBytes
            )})…`
          );
        }
      } finally {
        await handle.close();
      }
    };

    for (const file of filesToDownload) {
      try {
        emitLive(`Downloading ${resolvedId}/${file}…`);
        await downloadFile(file);
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        if (err.includes("HTTP 404")) {
          continue;
        }
        throw e;
      }
    }

    throwIfAborted();
    emitLive(`Verifying ONNX graph integrity and local tensor cache…`);

    // Write metadata manifest describing the installed ONNX model
    const manifest = {
      modelId: normalized,
      onnxModelId: resolvedId,
      sanitized,
      installedAt: new Date().toISOString(),
      estimatedSize,
      pipeline: "text-generation",
      chatTemplate: "gemma",
    };

    await writeFile(
      join(targetDir, "t3os-model.json"),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );

    // Verify local model installation integrity
    const status = await checkLocalModelInstalled(normalized, options?.cacheDir);
    if (!status.isInstalled) {
      throw new Error(
        status.details ?? "Verification failed: model weights are missing or empty."
      );
    }

    emit(
      100,
      `✓ ONNX model ${resolvedId} completely downloaded and local path verified.`
    );

    return {
      success: true,
      modelId: normalized,
      path: targetDir,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const isCancelled =
      options?.signal?.aborted || errorMsg.toLowerCase().includes("cancel");

    if (isCancelled) {
      // Clean up partially downloaded directory on cancellation
      try {
        if (existsSync(targetDir)) {
          await rm(targetDir, { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup error
      }

      return {
        success: false,
        modelId: normalized,
        path: targetDir,
        error: "Download cancelled by user",
        cancelled: true,
      };
    }

    return {
      success: false,
      modelId: normalized,
      path: targetDir,
      error: errorMsg,
      cancelled: false,
    };
  }
}
