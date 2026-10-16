import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkLocalModelInstalled,
  formatBytes,
  formatTime,
  getModelEstimatedSize,
  installLocalModel,
  renderProgressBar,
  type DownloadProgress,
} from "../src/provider/localModel.js";

describe("localModel", () => {
  it("formats bytes, time and renders progress bar correctly", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1024 * 1024 * 50)).toBe("50.0 MB");
    expect(formatBytes(1024 * 1024 * 1024 * 2.5)).toBe("2.50 GB");

    expect(formatTime(45)).toBe("45s");
    expect(formatTime(125)).toBe("2m 5s");

    const bar50 = renderProgressBar(50, 10);
    expect(bar50).toBe("[█████░░░░░]");
    const bar100 = renderProgressBar(100, 10);
    expect(bar100).toBe("[██████████]");
  });

  it("returns accurate estimated model download sizes", () => {
    expect(getModelEstimatedSize("google/gemma-4-31B-it")).toContain("18.9 GB");
    expect(getModelEstimatedSize("google/gemma-3-4b-it")).toContain("2.8 GB");
    expect(getModelEstimatedSize("google/gemma-2-2b-it")).toContain("1.6 GB");
    expect(getModelEstimatedSize("gemma-4")).toContain("18.9 GB");
    expect(getModelEstimatedSize("gemma-3-12b")).toContain("7.6 GB");
    expect(getModelEstimatedSize("unknown-model")).toContain("3.0 GB");
  });

  it("reports model as not installed when cache directory is empty or absent", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "t3os-test-hf-"));
    try {
      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(false);
      expect(status.estimatedSize).toContain("2.8 GB");
      expect(status.modelId).toBe("google/gemma-3-4b-it");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("installs local model with progress events including speed, ETA and bar", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "t3os-test-hf-"));
    const progressUpdates: DownloadProgress[] = [];
    try {
      const result = await installLocalModel("google/gemma-3-4b-it", {
        cacheDir: tempDir,
        onProgress: (prog) => progressUpdates.push(prog),
      });

      expect(result.success).toBe(true);
      expect(result.modelId).toBe("google/gemma-3-4b-it");
      expect(progressUpdates.length).toBeGreaterThanOrEqual(5);

      const last = progressUpdates[progressUpdates.length - 1]!;
      expect(last.percent).toBe(100);
      expect(last.statusText).toContain("completely downloaded");

      // Verify status check confirms installed
      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(true);
      expect(status.path).toContain("models--google--gemma-3-4b-it");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("supports cancelling the download in progress", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "t3os-test-hf-"));
    const controller = new AbortController();

    try {
      const promise = installLocalModel("google/gemma-3-4b-it", {
        cacheDir: tempDir,
        signal: controller.signal,
        onProgress: (p) => {
          if (p.percent >= 15) {
            controller.abort();
          }
        },
      });

      const result = await promise;
      expect(result.success).toBe(false);
      expect(result.cancelled).toBe(true);
      expect(result.error).toContain("cancelled");

      // Should not be installed after cancellation
      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
