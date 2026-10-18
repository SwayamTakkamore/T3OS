import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkLocalModelInstalled,
  formatBytes,
  formatTime,
  getModelEstimatedSize,
  installLocalModel,
  renderProgressBar,
  type DownloadProgress,
} from "../src/provider/localModel.js";

/** 1 MiB of non-zero dummy weight content (a real weight file is never empty). */
const DUMMY_WEIGHT = Buffer.alloc(1024 * 1024, 1);

/**
 * Sizes served by the deterministic mock Hugging Face fetch below. Weight
 * files are multi-megabyte so progress percentages move meaningfully.
 */
const MOCK_HF_FILES: Record<string, number> = {
  "config.json": 1024,
  "tokenizer.json": 2048,
  "tokenizer_config.json": 1024,
  "generation_config.json": 512,
  "onnx/embed_tokens.onnx": 8 * 1024 * 1024,
  "onnx/decoder_model_merged.onnx": 8 * 1024 * 1024,
};

/**
 * Deterministic stand-in for `fetch` that streams mock Hugging Face Hub
 * responses: HEAD requests report sizes, GET requests stream 1 MiB chunks so
 * cancellation can interrupt mid-file. No network access ever happens.
 */
function createMockHfFetch(): typeof fetch {
  const mock = async (
    input: RequestInfo | URL,
    init?: RequestInit
  ): Promise<Response> => {
    const url = String(input);
    const marker = "/resolve/main/";
    const idx = url.indexOf(marker);
    const file = idx >= 0 ? decodeURIComponent(url.slice(idx + marker.length)) : "";
    const size = MOCK_HF_FILES[file];

    if (size === undefined) {
      return new Response("Not Found", { status: 404, statusText: "Not Found" });
    }

    if ((init?.method ?? "GET").toUpperCase() === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "content-length": String(size) },
      });
    }

    const chunkSize = 1024 * 1024;
    let sent = 0;
    const signal = init?.signal ?? undefined;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (signal?.aborted) {
          controller.error(new Error("The operation was aborted"));
          return;
        }
        if (sent >= size) {
          controller.close();
          return;
        }
        const next = Math.min(chunkSize, size - sent);
        controller.enqueue(new Uint8Array(next).fill(0xab));
        sent += next;
      },
    });

    return new Response(stream, {
      status: 200,
      headers: { "content-length": String(size) },
    });
  };
  return mock as unknown as typeof fetch;
}

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
      expect(status.diskSizeBytes).toBe(0);
      expect(status.formattedDiskSize).toBe("0 B");
      expect(status.details).toBe("Model not found in local cache");
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
      // Non-zero weight files: this is what makes a cache directory usable.
      await writeFile(join(snapshotDir, "onnx", "embed_tokens.onnx"), DUMMY_WEIGHT);
      await writeFile(join(snapshotDir, "onnx", "decoder_model_merged.onnx"), DUMMY_WEIGHT);

      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(true);
      expect(status.path).toContain("models--onnx-community--gemma-3-4b-it-ONNX");
      expect(status.diskSizeBytes).toBeGreaterThanOrEqual(2 * DUMMY_WEIGHT.byteLength);
      expect(status.formattedDiskSize).toContain("MB");
      expect(status.incomplete).toBe(false);
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
      await writeFile(join(snapshotDir, "decoder_model_merged.onnx"), DUMMY_WEIGHT);

      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(true);
      expect(status.path).toContain("models--google--gemma-3-4b-it");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports 0-byte weight files as an incomplete cache, not installed", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "t3os-test-hf-"));
    try {
      // Exactly the bug: folder exists, config present, weights are 0 bytes.
      const snapshotDir = join(tempDir, "models--onnx-community--gemma-3-4b-it-ONNX", "snapshots", "main");
      await mkdir(join(snapshotDir, "onnx"), { recursive: true });
      await writeFile(join(snapshotDir, "config.json"), "{}", "utf8");
      await writeFile(join(snapshotDir, "onnx", "embed_tokens.onnx"), "");
      await writeFile(join(snapshotDir, "onnx", "decoder_model_merged.onnx"), "");

      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(false);
      expect(status.incomplete).toBe(true);
      expect(status.details).toContain("Incomplete cache:");
      expect(status.details).toContain("model weights missing or 0 bytes");
      expect(status.path).toContain("models--onnx-community--gemma-3-4b-it-ONNX");
      expect(status.diskSizeBytes).toBeGreaterThanOrEqual(0);
      expect(status.formattedDiskSize).toBe(formatBytes(status.diskSizeBytes));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports a config-only directory (no weight files at all) as incomplete", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "t3os-test-hf-"));
    try {
      const snapshotDir = join(tempDir, "models--onnx-community--gemma-3-4b-it-ONNX", "snapshots", "main");
      await mkdir(join(snapshotDir, "onnx"), { recursive: true });
      await writeFile(join(snapshotDir, "config.json"), "{}", "utf8");
      await writeFile(join(snapshotDir, "tokenizer.json"), "{}", "utf8");
      await writeFile(join(snapshotDir, "generation_config.json"), "{}", "utf8");

      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(false);
      expect(status.incomplete).toBe(true);
      expect(status.details).toContain("Incomplete cache:");
      expect(status.details).toContain("model weights missing or 0 bytes");
      expect(status.diskSizeBytes).toBeGreaterThan(0);
      expect(status.diskSizeBytes).toBeLessThan(10 * 1024 * 1024);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("applies the production size floor outside of test environments", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "t3os-test-hf-"));
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    try {
      // Non-zero weights, but far below the 10 MB production floor: this is a
      // truncated download, not an installed model.
      const snapshotDir = join(tempDir, "models--onnx-community--gemma-3-4b-it-ONNX", "snapshots", "main");
      await mkdir(join(snapshotDir, "onnx"), { recursive: true });
      await writeFile(join(snapshotDir, "onnx", "embed_tokens.onnx"), Buffer.alloc(64 * 1024, 1));
      await writeFile(join(snapshotDir, "onnx", "decoder_model_merged.onnx"), Buffer.alloc(64 * 1024, 1));

      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(false);
      expect(status.incomplete).toBe(true);
      expect(status.details).toContain("Incomplete cache:");
    } finally {
      vi.unstubAllEnvs();
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
        fetchImpl: createMockHfFetch(),
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

      // The weights must be real, non-empty downloads — never 0-byte shells.
      const embedStat = await stat(join(status.path, "snapshots", "main", "onnx", "embed_tokens.onnx"));
      const decoderStat = await stat(join(status.path, "snapshots", "main", "onnx", "decoder_model_merged.onnx"));
      expect(embedStat.size).toBeGreaterThan(0);
      expect(decoderStat.size).toBeGreaterThan(0);
      expect(status.diskSizeBytes).toBeGreaterThan(0);
      expect(status.formattedDiskSize).toBe(formatBytes(status.diskSizeBytes));

      // Progress totals came from the actual Hub content lengths.
      expect(last.totalBytes).toBe(
        Object.values(MOCK_HF_FILES).reduce((sum, size) => sum + size, 0)
      );
      expect(last.downloadedBytes).toBe(last.totalBytes);

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
    const seenAuthHeaders: Array<string | undefined> = [];
    const mockFetch = createMockHfFetch();
    const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      seenAuthHeaders.push(headers.get("authorization"));
      return mockFetch(input, init);
    }) as unknown as typeof fetch;
    try {
      const result = await installLocalModel("google/gemma-3-4b-it", {
        cacheDir: tempDir,
        token: "hf_install_token_test",
        fetchImpl: recordingFetch,
      });

      expect(result.success).toBe(true);
      expect(process.env.HF_TOKEN).toBe("hf_install_token_test");
      // Every Hub request (HEAD preflight + GET downloads) carries the bearer token.
      expect(seenAuthHeaders.length).toBeGreaterThan(0);
      for (const auth of seenAuthHeaders) {
        expect(auth).toBe("Bearer hf_install_token_test");
      }
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
        fetchImpl: createMockHfFetch(),
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

      // Partially downloaded files are removed on cancellation
      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
