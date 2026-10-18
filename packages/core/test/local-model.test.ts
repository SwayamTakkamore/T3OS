import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  checkLocalModelInstalled,
  discoverOnnxFiles,
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
 * files are multi-megabyte so progress percentages move meaningfully. Names
 * match the Q4 quantized build T3OS downloads.
 */
const MOCK_HF_FILES: Record<string, number> = {
  "config.json": 1024,
  "tokenizer.json": 2048,
  "tokenizer_config.json": 1024,
  "generation_config.json": 512,
  "onnx/embed_tokens_q4.onnx": 8 * 1024 * 1024,
  "onnx/decoder_model_merged_q4.onnx": 8 * 1024 * 1024,
  "onnx/embed_tokens_q4.onnx_data": 4 * 1024 * 1024,
  "onnx/decoder_model_merged_q4.onnx_data": 64 * 1024 * 1024,
  "onnx/decoder_model_merged_q4.onnx_data_1": 64 * 1024 * 1024,
};

/**
 * Every precision variant `onnx-community/gemma-3-4b-it-ONNX` keeps in its
 * `onnx/` folder, exactly as the Hugging Face Hub API lists them. Downloading
 * all of this is what turned a ~3.2 GB Q4 install into a 40.79 GB one.
 */
const GEMMA_3_4B_REPO_FILES: string[] = [
  "config.json",
  "generation_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/decoder_model_merged.onnx",
  ...Array.from({ length: 8 }, (_, i) =>
    i === 0 ? "onnx/decoder_model_merged.onnx_data" : `onnx/decoder_model_merged.onnx_data_${i}`
  ),
  "onnx/decoder_model_merged_fp16.onnx",
  ...Array.from({ length: 4 }, (_, i) =>
    i === 0
      ? "onnx/decoder_model_merged_fp16.onnx_data"
      : `onnx/decoder_model_merged_fp16.onnx_data_${i}`
  ),
  "onnx/decoder_model_merged_q4.onnx",
  "onnx/decoder_model_merged_q4.onnx_data",
  "onnx/decoder_model_merged_q4.onnx_data_1",
  "onnx/decoder_model_merged_q4f16.onnx",
  "onnx/decoder_model_merged_q4f16.onnx_data",
  "onnx/decoder_model_merged_q4f16.onnx_data_1",
  "onnx/decoder_model_merged_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx_data",
  "onnx/decoder_model_merged_quantized.onnx_data_1",
  "onnx/decoder_model_merged_quantized.onnx_data_2",
  "onnx/embed_tokens.onnx",
  "onnx/embed_tokens.onnx_data",
  "onnx/embed_tokens_fp16.onnx",
  "onnx/embed_tokens_q4.onnx",
  "onnx/embed_tokens_q4.onnx_data",
  "onnx/embed_tokens_q4f16.onnx",
  "onnx/embed_tokens_quantized.onnx",
  "onnx/vision_encoder.onnx",
  "onnx/vision_encoder.onnx_data",
  "onnx/vision_encoder_fp16.onnx",
  "onnx/vision_encoder_q4.onnx",
];

/** Serves the Hub model-listing endpoint for `discoverOnnxFiles`. */
function createRepoListingFetch(files: string[]): typeof fetch {
  const mock = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    if (url.includes("/api/models/")) {
      return Response.json({ siblings: files.map((rfilename) => ({ rfilename })) });
    }
    return new Response("Not Found", { status: 404, statusText: "Not Found" });
  };
  return mock as unknown as typeof fetch;
}

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
    expect(getModelEstimatedSize("google/gemma-3-4b-it")).toContain("3.2 GB");
    expect(getModelEstimatedSize("google/gemma-2-2b-it")).toContain("1.5 GB");
    expect(getModelEstimatedSize("gemma-4")).toContain("18.0 GB");
    expect(getModelEstimatedSize("gemma-3-12b")).toContain("7.0 GB");
    expect(getModelEstimatedSize("unknown-model")).toContain("3.0 GB");
    // Estimates describe the ONNX community model actually downloaded.
    expect(getModelEstimatedSize("google/gemma-3-4b-it")).toContain("ONNX");
    expect(getModelEstimatedSize("google/gemma-3-4b-it")).toContain("Q4");
  });

  it("reports model as not installed when cache directory is empty or absent", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "t3os-test-hf-"));
    try {
      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(false);
      expect(status.estimatedSize).toContain("3.2 GB");
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
      // T3OS loads the Q4 build, so that is the precision that must be present.
      await writeFile(join(snapshotDir, "onnx", "embed_tokens_q4.onnx"), DUMMY_WEIGHT);
      await writeFile(join(snapshotDir, "onnx", "decoder_model_merged_q4.onnx"), DUMMY_WEIGHT);
      await writeFile(join(snapshotDir, "onnx", "decoder_model_merged_q4.onnx_data"), DUMMY_WEIGHT);

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
      await writeFile(join(snapshotDir, "decoder_model_merged_q4.onnx"), DUMMY_WEIGHT);
      await writeFile(join(snapshotDir, "decoder_model_merged_q4.onnx_data"), DUMMY_WEIGHT);

      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(true);
      expect(status.path).toContain("models--google--gemma-3-4b-it");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("flags an unquantized-only cache as incomplete so the Q4 files get downloaded", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "t3os-test-hf-"));
    try {
      // Exactly the regression: the pre-fix downloader queued the fp32 files
      // first, leaving a cache with decoder_model_merged.onnx but no `_q4`
      // graph. `dtype: "q4"` cannot load that, so it must not read as installed.
      const snapshotDir = join(tempDir, "models--onnx-community--gemma-3-4b-it-ONNX", "snapshots", "main");
      await mkdir(join(snapshotDir, "onnx"), { recursive: true });
      await writeFile(join(snapshotDir, "config.json"), "{}", "utf8");
      await writeFile(join(snapshotDir, "onnx", "decoder_model_merged.onnx"), DUMMY_WEIGHT);
      await writeFile(join(snapshotDir, "onnx", "decoder_model_merged.onnx_data"), DUMMY_WEIGHT);
      await writeFile(join(snapshotDir, "onnx", "embed_tokens.onnx"), DUMMY_WEIGHT);

      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(false);
      expect(status.incomplete).toBe(true);
      expect(status.details).toContain("Q4 weights missing");
      expect(status.details).toContain("decoder_model_merged_q4.onnx");
      expect(status.path).toContain("models--onnx-community--gemma-3-4b-it-ONNX");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects a mixed cache that has quantized embeddings but no quantized decoder", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "t3os-test-hf-"));
    try {
      const snapshotDir = join(tempDir, "models--onnx-community--gemma-3-4b-it-ONNX", "snapshots", "main");
      await mkdir(join(snapshotDir, "onnx"), { recursive: true });
      await writeFile(join(snapshotDir, "config.json"), "{}", "utf8");
      await writeFile(join(snapshotDir, "onnx", "embed_tokens_q4.onnx"), DUMMY_WEIGHT);
      await writeFile(join(snapshotDir, "onnx", "decoder_model_merged.onnx"), DUMMY_WEIGHT);

      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(false);
      expect(status.incomplete).toBe(true);
      expect(status.details).toContain("Q4 weights missing");
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
      await writeFile(join(snapshotDir, "onnx", "embed_tokens_q4.onnx"), "");
      await writeFile(join(snapshotDir, "onnx", "decoder_model_merged_q4.onnx"), "");

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
      await writeFile(join(snapshotDir, "onnx", "embed_tokens_q4.onnx"), Buffer.alloc(64 * 1024, 1));
      await writeFile(join(snapshotDir, "onnx", "decoder_model_merged_q4.onnx"), Buffer.alloc(64 * 1024, 1));

      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(false);
      expect(status.incomplete).toBe(true);
      expect(status.details).toContain("Incomplete download:");
      expect(status.details).toContain(".onnx_data missing or partial");
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

      // Progress messages must reference the actual ONNX community model and
      // the quantized Q4 files, not the unquantized fp32 build.
      const onnxId = "onnx-community/gemma-3-4b-it-ONNX";
      const statusTexts = progressUpdates.map((p) => p.statusText);
      expect(statusTexts[0]).toContain(`Initializing download for ${onnxId}`);
      expect(statusTexts.some((t) => t.includes("config.json"))).toBe(true);
      expect(statusTexts.some((t) => t.includes("tokenizer.json"))).toBe(true);
      expect(statusTexts.some((t) => t.includes("onnx/embed_tokens_q4.onnx"))).toBe(true);
      expect(statusTexts.some((t) => t.includes("onnx/decoder_model_merged_q4.onnx"))).toBe(true);
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
      expect(onnxEntries).toContain("embed_tokens_q4.onnx");
      expect(onnxEntries).toContain("decoder_model_merged_q4.onnx");
      // No other precision variant was pulled down alongside the Q4 build.
      expect(onnxEntries).not.toContain("decoder_model_merged.onnx");
      expect(onnxEntries).not.toContain("embed_tokens.onnx");

      // The weights must be real, non-empty downloads — never 0-byte shells.
      const embedStat = await stat(join(status.path, "snapshots", "main", "onnx", "embed_tokens_q4.onnx"));
      const decoderStat = await stat(join(status.path, "snapshots", "main", "onnx", "decoder_model_merged_q4.onnx"));
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

  it("returns incomplete when only ~19.7 MB exists for a 3.2 GB model", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "t3os-test-hf-"));
    try {
      const snapshotDir = join(
        tempDir,
        "models--onnx-community--gemma-3-4b-it-ONNX",
        "snapshots",
        "main"
      );
      await mkdir(join(snapshotDir, "onnx"), { recursive: true });
      await writeFile(join(snapshotDir, "config.json"), "{}", "utf8");
      await writeFile(join(snapshotDir, "tokenizer.json"), Buffer.alloc(2048, 1));
      await writeFile(join(snapshotDir, "tokenizer_config.json"), "{}", "utf8");
      await writeFile(join(snapshotDir, "generation_config.json"), "{}", "utf8");
      await writeFile(join(snapshotDir, "onnx", "embed_tokens_q4.onnx"), Buffer.alloc(435, 0));
      await writeFile(join(snapshotDir, "onnx", "decoder_model_merged_q4.onnx"), Buffer.alloc(351 * 1024, 0));
      const tokenizer = Buffer.alloc(20.3 * 1024 * 1024, 1);
      await writeFile(join(snapshotDir, "tokenizer.json"), tokenizer);
      let total = 0;
      for (const f of [
        "config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "generation_config.json",
        "onnx/embed_tokens_q4.onnx",
        "onnx/decoder_model_merged_q4.onnx",
      ]) {
        const st = await stat(join(snapshotDir, f));
        total += st.size;
      }
      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(false);
      expect(status.incomplete).toBe(true);
      expect(status.details).toContain("only");
      expect(status.details).toContain("of");
      expect(status.details).toContain(".onnx_data missing or partial");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  describe("discoverOnnxFiles", () => {
    it("selects only the Q4 text-generation files from a multi-precision repo", async () => {
      const files = await discoverOnnxFiles(
        "onnx-community/gemma-3-4b-it-ONNX",
        createRepoListingFetch(GEMMA_3_4B_REPO_FILES),
        {}
      );

      expect(files).toEqual(
        expect.arrayContaining([
          "config.json",
          "generation_config.json",
          "tokenizer.json",
          "tokenizer_config.json",
          "onnx/decoder_model_merged_q4.onnx",
          "onnx/decoder_model_merged_q4.onnx_data",
          "onnx/decoder_model_merged_q4.onnx_data_1",
          "onnx/embed_tokens_q4.onnx",
          "onnx/embed_tokens_q4.onnx_data",
        ])
      );

      // Every `onnx/` entry must be a Q4 text-generation file. Pulling in the
      // other precisions plus the vision encoder is what made the downloader
      // queue 40.79 GB instead of ~3.2 GB.
      for (const file of files.filter((f) => f.startsWith("onnx/"))) {
        expect(file).toMatch(
          /^onnx\/(decoder_model_merged|embed_tokens)_q4\.onnx(_data(_\d+)?)?$/
        );
      }
      expect(files.some((f) => f.includes("_fp16"))).toBe(false);
      expect(files.some((f) => f.includes("_q4f16"))).toBe(false);
      expect(files.some((f) => f.includes("vision_encoder"))).toBe(false);
      expect(files.some((f) => f.includes("decoder_model_merged_quantized"))).toBe(false);
      expect(files.some((f) => f.startsWith("onnx/decoder_model_merged."))).toBe(false);
      expect(files.some((f) => f.startsWith("onnx/embed_tokens."))).toBe(false);
    });

    it("falls back to the generic quantized build when no _q4 variant exists", async () => {
      const files = await discoverOnnxFiles(
        "org/repo-quantized-only",
        createRepoListingFetch([
          "config.json",
          "onnx/decoder_model_merged_quantized.onnx",
          "onnx/decoder_model_merged_quantized.onnx_data",
          "onnx/embed_tokens_quantized.onnx",
          "onnx/vision_encoder_quantized.onnx",
        ]),
        {}
      );

      expect(files).toContain("onnx/decoder_model_merged_quantized.onnx");
      expect(files).toContain("onnx/embed_tokens_quantized.onnx");
      expect(files.some((f) => f.includes("vision_encoder"))).toBe(false);
    });

    it("falls back to the unquantized weights when a repo ships no quantized build", async () => {
      const files = await discoverOnnxFiles(
        "org/repo-unquantized-only",
        createRepoListingFetch([
          "config.json",
          "onnx/decoder_model_merged.onnx",
          "onnx/decoder_model_merged.onnx_data",
          "onnx/embed_tokens.onnx",
        ]),
        {}
      );

      expect(files).toContain("onnx/decoder_model_merged.onnx");
      expect(files).toContain("onnx/embed_tokens.onnx");
      expect(files).toContain("config.json");
    });

    it("returns the Q4 default file list when the Hub listing is unavailable", async () => {
      const files = await discoverOnnxFiles(
        "onnx-community/gemma-3-4b-it-ONNX",
        (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
        {}
      );

      expect(files).toContain("onnx/decoder_model_merged_q4.onnx");
      expect(files).toContain("onnx/embed_tokens_q4.onnx");
      expect(files.some((f) => f.startsWith("onnx/decoder_model_merged."))).toBe(false);
      expect(files.some((f) => f.includes("vision_encoder"))).toBe(false);
    });
  });
});
