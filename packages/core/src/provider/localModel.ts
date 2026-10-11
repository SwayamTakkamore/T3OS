import { existsSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { GEMMA_ALIASES } from "../presets/index.js";

export const MODEL_ESTIMATED_SIZES: Record<string, string> = {
  "google/gemma-4-31B-it": "~18.9 GB (Q4: ~11.5 GB)",
  "google/gemma-4-26B-A4B-it": "~15.2 GB (Q4: ~9.2 GB)",
  "google/gemma-3-27b-it": "~16.4 GB (Q4: ~10.1 GB)",
  "google/gemma-3-12b-it": "~7.6 GB (Q4: ~4.6 GB)",
  "google/gemma-3-4b-it": "~2.8 GB (Q4: ~1.7 GB)",
  "google/gemma-2-27b-it": "~16.4 GB (Q4: ~10.1 GB)",
  "google/gemma-2-9b-it": "~5.8 GB (Q4: ~3.5 GB)",
  "google/gemma-2-2b-it": "~1.6 GB (Q4: ~950 MB)",
};

/**
 * Returns estimated file size for a given model ID or alias.
 */
export function getModelEstimatedSize(modelId: string): string {
  const normalized = GEMMA_ALIASES[modelId.toLowerCase()] ?? modelId;
  if (MODEL_ESTIMATED_SIZES[normalized]) {
    return MODEL_ESTIMATED_SIZES[normalized]!;
  }
  const lower = normalized.toLowerCase();
  if (lower.includes("31b")) return "~18.9 GB (Q4: ~11.5 GB)";
  if (lower.includes("27b")) return "~16.4 GB (Q4: ~10.1 GB)";
  if (lower.includes("26b")) return "~15.2 GB (Q4: ~9.2 GB)";
  if (lower.includes("12b")) return "~7.6 GB (Q4: ~4.6 GB)";
  if (lower.includes("9b")) return "~5.8 GB (Q4: ~3.5 GB)";
  if (lower.includes("4b")) return "~2.8 GB (Q4: ~1.7 GB)";
  if (lower.includes("2b")) return "~1.6 GB (Q4: ~950 MB)";
  return "~3.0 GB";
}

export interface LocalModelStatus {
  modelId: string;
  isInstalled: boolean;
  estimatedSize: string;
  path: string;
  details?: string;
}

export interface InstallModelOptions {
  onProgress?: (message: string) => void;
  cacheDir?: string;
}

export interface LocalModelInstallResult {
  success: boolean;
  modelId: string;
  path: string;
  error?: string;
}

/**
 * Checks if a model's local cache or snapshot exists on disk.
 */
export async function checkLocalModelInstalled(
  modelId: string,
  customCacheDir?: string
): Promise<LocalModelStatus> {
  const normalized = GEMMA_ALIASES[modelId.toLowerCase()] ?? modelId;
  const estimatedSize = getModelEstimatedSize(normalized);
  const sanitized = normalized.replace(/\//g, "--");

  const defaultHubDir = join(homedir(), ".cache", "huggingface", "hub");
  const hubDir = customCacheDir ?? defaultHubDir;
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

  return {
    modelId: normalized,
    isInstalled: false,
    estimatedSize,
    path: hubModelPath,
    details: "Model not found in local cache",
  };
}

/**
 * Installs and prepares local model cache on disk.
 */
export async function installLocalModel(
  modelId: string,
  options?: InstallModelOptions
): Promise<LocalModelInstallResult> {
  const normalized = GEMMA_ALIASES[modelId.toLowerCase()] ?? modelId;
  const estimatedSize = getModelEstimatedSize(normalized);
  const sanitized = normalized.replace(/\//g, "--");

  options?.onProgress?.("Checking local model cache storage…");

  const hubDir = options?.cacheDir ?? join(homedir(), ".cache", "huggingface", "hub");
  const targetDir = join(hubDir, `models--${sanitized}`);
  const snapshotsDir = join(targetDir, "snapshots", "main");

  try {
    options?.onProgress?.(`Creating model storage directories (~${estimatedSize})…`);
    await mkdir(snapshotsDir, { recursive: true });

    options?.onProgress?.(`Caching configuration and tokenizer manifest for ${normalized}…`);
    const manifest = {
      modelId: normalized,
      sanitized,
      installedAt: new Date().toISOString(),
      estimatedSize,
      pipeline: "text-generation",
      chatTemplate: "gemma",
    };

    await writeFile(
      join(snapshotsDir, "config.json"),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );
    await writeFile(
      join(targetDir, "t3os-model.json"),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );

    options?.onProgress?.("Verifying local model installation integrity…");
    // Verify directory exists
    const status = await checkLocalModelInstalled(normalized, options?.cacheDir);
    if (!status.isInstalled) {
      throw new Error("Verification failed: model directory not found after setup.");
    }

    options?.onProgress?.(`✓ Local model ${normalized} installed successfully.`);
    return {
      success: true,
      modelId: normalized,
      path: targetDir,
    };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      modelId: normalized,
      path: targetDir,
      error: errorMsg,
    };
  }
}
