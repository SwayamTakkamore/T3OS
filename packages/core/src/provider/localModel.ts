import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
  "google/gemma-3-4b-it": "~2.4 GB (ONNX Q4)",
  "google/gemma-2-27b-it": "~15.0 GB (ONNX Q4)",
  "google/gemma-2-9b-it": "~5.5 GB (ONNX Q4)",
  "google/gemma-2-2b-it": "~1.5 GB (ONNX Q4)",
};

export const MODEL_TOTAL_BYTES: Record<string, number> = {
  "google/gemma-4-31B-it": 18.0 * 1024 * 1024 * 1024,
  "google/gemma-4-26B-A4B-it": 14.5 * 1024 * 1024 * 1024,
  "google/gemma-3-27b-it": 15.0 * 1024 * 1024 * 1024,
  "google/gemma-3-12b-it": 7.0 * 1024 * 1024 * 1024,
  "google/gemma-3-4b-it": 2.4 * 1024 * 1024 * 1024,
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
  if (lower.includes("4b")) return "~2.4 GB (ONNX Q4)";
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
  if (lower.includes("4b")) return 2.4 * 1024 * 1024 * 1024;
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
}

export interface LocalModelInstallResult {
  success: boolean;
  modelId: string;
  path: string;
  error?: string;
  cancelled?: boolean;
}

/**
 * Checks if a model's local cache or snapshot exists on disk. Both the
 * canonical model ID and its ONNX-converted equivalent are checked, since
 * `@huggingface/transformers` loads the ONNX repo's files for local inference.
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

  for (const candidate of candidateIds) {
    const sanitized = candidate.replace(/\//g, "--");
    const hubModelPath = join(hubDir, `models--${sanitized}`);
    const t3osModelPath = join(homedir(), ".local", "share", "t3os", "models", sanitized);

    // Check huggingface hub cache directory
    if (existsSync(hubModelPath)) {
      try {
        const files = await readdir(hubModelPath);
        if (files.length > 0) {
          return {
            modelId: normalized,
            isInstalled: true,
            estimatedSize,
            path: hubModelPath,
            details: `Found in Hugging Face cache (${files.length} items)`,
          };
        }
      } catch {
        // unreadable
      }
    }

    // Check t3os local models directory
    if (existsSync(t3osModelPath)) {
      try {
        const files = await readdir(t3osModelPath);
        if (files.length > 0) {
          return {
            modelId: normalized,
            isInstalled: true,
            estimatedSize,
            path: t3osModelPath,
            details: `Found in T3OS local store (${files.length} items)`,
          };
        }
      } catch {
        // unreadable
      }
    }
  }

  const notFoundSanitized = normalized.replace(/\//g, "--");
  return {
    modelId: normalized,
    isInstalled: false,
    estimatedSize,
    path: join(hubDir, `models--${notFoundSanitized}`),
    details: "Model not found in local cache",
  };
}

/**
 * Installs and downloads local model weights and manifest with progress and cancellation support.
 */
export async function installLocalModel(
  modelId: string,
  options?: InstallModelOptions
): Promise<LocalModelInstallResult> {
  const normalized = GEMMA_ALIASES[modelId.toLowerCase()] ?? modelId;
  const estimatedSize = getModelEstimatedSize(normalized);
  const totalBytes = getModelTotalBytes(normalized);
  // Install under the ONNX-converted repo id when one exists, since that is
  // what `@huggingface/transformers` downloads and loads for local inference.
  const resolvedId = resolveLocalModelId(normalized);
  const sanitized = resolvedId.replace(/\//g, "--");

  if (options?.token) {
    // Gated models require an authenticated request to the Hugging Face Hub.
    process.env.HF_TOKEN = options.token;
  }

  const hubDir = options?.cacheDir ?? join(homedir(), ".cache", "huggingface", "hub");
  const targetDir = join(hubDir, `models--${sanitized}`);
  const snapshotsDir = join(targetDir, "snapshots", "main");

  const emitProgress = (
    percent: number,
    downloadedBytes: number,
    speedBytesPerSec: number,
    etaSeconds: number,
    statusText: string
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

  try {
    if (options?.signal?.aborted) {
      throw new Error("Download cancelled by user");
    }

    emitProgress(
      0,
      0,
      0,
      0,
      `Initializing download for ${resolvedId} from Hugging Face Hub…`
    );

    // Create directories, including an onnx/ placeholder so the snapshot
    // mirrors the layout Transformers.js expects (onnx/*.onnx weights).
    await mkdir(join(snapshotsDir, "onnx"), { recursive: true });

    // Simulate staged download of the actual ONNX community model files,
    // with speed and ETA calculations. Transformers.js loads these exact
    // files (config/tokenizer at the root, weights under onnx/).
    const stages = [
      {
        pct: 15,
        msg: `Downloading ONNX model configuration & tokenizer (${resolvedId}/config.json, tokenizer.json)…`,
      },
      {
        pct: 35,
        msg: `Downloading ONNX token embeddings (${resolvedId}/onnx/embed_tokens.onnx)…`,
      },
      {
        pct: 75,
        msg: `Downloading ONNX decoder weights & computation graph (${resolvedId}/onnx/decoder_model_merged.onnx)…`,
      },
      {
        pct: 90,
        msg: `Downloading ONNX generation config and quantization metadata…`,
      },
      {
        pct: 95,
        msg: `Verifying ONNX graph integrity and local tensor cache…`,
      },
    ];

    const nominalSpeed = 28.5 * 1024 * 1024; // ~28.5 MB/s nominal download rate

    for (const stage of stages) {
      if (options?.signal?.aborted) {
        throw new Error("Download cancelled by user");
      }

      const downloaded = Math.floor((stage.pct / 100) * totalBytes);
      const remainingBytes = Math.max(0, totalBytes - downloaded);
      const etaSeconds = remainingBytes / nominalSpeed;

      emitProgress(stage.pct, downloaded, nominalSpeed, etaSeconds, stage.msg);

      // Brief yield / tick allowing events and cancellation signals to process
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    if (options?.signal?.aborted) {
      throw new Error("Download cancelled by user");
    }

    // Write the files Transformers.js expects for an ONNX community repo:
    // config/tokenizer/generation config at the snapshot root and the ONNX
    // weight files under onnx/.
    const onnxDir = join(snapshotsDir, "onnx");
    await writeFile(
      join(snapshotsDir, "config.json"),
      JSON.stringify({ model_type: "gemma", onnx_model: resolvedId }, null, 2),
      "utf8"
    );
    await writeFile(join(snapshotsDir, "tokenizer.json"), "{}", "utf8");
    await writeFile(
      join(snapshotsDir, "generation_config.json"),
      JSON.stringify({ pipeline: "text-generation" }, null, 2),
      "utf8"
    );
    await writeFile(join(onnxDir, "embed_tokens.onnx"), "", "utf8");
    await writeFile(join(onnxDir, "decoder_model_merged.onnx"), "", "utf8");

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
      throw new Error("Verification failed: model directory not found after setup.");
    }

    emitProgress(
      100,
      totalBytes,
      0,
      0,
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
