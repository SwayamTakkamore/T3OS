import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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

  it("returns accurate estimated ONNX model download sizes", () => {
    expect(getModelEstimatedSize("google/gemma-4-31B-it")).toContain("18.0 GB");
    expect(getModelEstimatedSize("google/gemma-3-4b-it")).toContain("2.4 GB");
    expect(getModelEstimatedSize("google/gemma-2-2b-it")).toContain("1.5 GB");
    expect(getModelEstimatedSize("gemma-4")).toContain("18.0 GB");
    expect(getModelEstimatedSize("gemma-3-12b")).toContain("7.0 GB");
    expect(getModelEstimatedSize("unknown-model")).toContain("3.0 GB");
    // Estimates describe the ONNX community model actually downloaded.
    expect(getModelEstimatedSize("google/gemma-3-4b-it")).toContain("ONNX");
  });

  it("reports model as not installed when cache directory is empty or absent", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "t3os-test-hf-"));
    try {
      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(false);
      expect(status.estimatedSize).toContain("2.4 GB");
      expect(status.modelId).toBe("google/gemma-3-4b-it");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("detects a cached ONNX-converted repo for a mapped model id", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "t3os-test-hf-"));
    try {
      const snapshotDir = join(tempDir, "models--onnx-community--gemma-3-4b-it-ONNX", "snapshots", "main");
      await mkdir(join(snapshotDir, "onnx"), { recursive: true });
      await writeFile(join(snapshotDir, "config.json"), "{}", "utf8");

      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(true);
      expect(status.path).toContain("models--onnx-community--gemma-3-4b-it-ONNX");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("still detects a previously cached snapshot under the original model id", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "t3os-test-hf-"));
    try {
      const snapshotDir = join(tempDir, "models--google--gemma-3-4b-it", "snapshots", "main");
      await mkdir(snapshotDir, { recursive: true });
      await writeFile(join(snapshotDir, "config.json"), "{}", "utf8");

      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(true);
      expect(status.path).toContain("models--google--gemma-3-4b-it");
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

      // Progress messages must reference the actual ONNX community model
      const onnxId = "onnx-community/gemma-3-4b-it-ONNX";
      const statusTexts = progressUpdates.map((p) => p.statusText);
      expect(statusTexts[0]).toContain(`Initializing download for ${onnxId}`);
      expect(statusTexts.some((t) => t.includes("config.json") && t.includes("tokenizer.json"))).toBe(true);
      expect(statusTexts.some((t) => t.includes("onnx/embed_tokens.onnx"))).toBe(true);
      expect(statusTexts.some((t) => t.includes("onnx/decoder_model_merged.onnx"))).toBe(true);
      expect(statusTexts.some((t) => t.includes("Verifying ONNX graph integrity"))).toBe(true);
      // No fake safetensors references anywhere in the progress stream
      expect(statusTexts.some((t) => t.toLowerCase().includes("safetensors"))).toBe(false);

      const last = progressUpdates[progressUpdates.length - 1]!;
      expect(last.percent).toBe(100);
      expect(last.statusText).toContain("completely downloaded");
      expect(last.statusText).toContain(onnxId);

      // Verify status check confirms installed under the ONNX-converted repo id
      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(true);
      expect(status.path).toContain("models--onnx-community--gemma-3-4b-it-ONNX");

      // The snapshot mirrors the layout Transformers.js expects for ONNX repos
      const snapshotEntries = await readdir(join(status.path, "snapshots", "main"));
      expect(snapshotEntries).toContain("onnx");
      expect(snapshotEntries).toContain("config.json");
      expect(snapshotEntries).toContain("tokenizer.json");
      expect(snapshotEntries).toContain("generation_config.json");

      const onnxEntries = await readdir(join(status.path, "snapshots", "main", "onnx"));
      expect(onnxEntries).toContain("embed_tokens.onnx");
      expect(onnxEntries).toContain("decoder_model_merged.onnx");

      // The t3os manifest records the ONNX repo and pipeline metadata
      const manifestRaw = await readFile(join(status.path, "t3os-model.json"), "utf8");
      const manifest = JSON.parse(manifestRaw);
      expect(manifest.onnxModelId).toBe(onnxId);
      expect(manifest.modelId).toBe("google/gemma-3-4b-it");
      expect(manifest.pipeline).toBe("text-generation");
      expect(manifest.chatTemplate).toBe("gemma");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the provided HF token for authenticated Hugging Face requests", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "t3os-test-hf-"));
    const previous = process.env.HF_TOKEN;
    delete process.env.HF_TOKEN;
    try {
      const result = await installLocalModel("google/gemma-3-4b-it", {
        cacheDir: tempDir,
        token: "hf_install_token_test",
      });

      expect(result.success).toBe(true);
      expect(process.env.HF_TOKEN).toBe("hf_install_token_test");
    } finally {
      if (previous === undefined) delete process.env.HF_TOKEN;
      else process.env.HF_TOKEN = previous;
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
