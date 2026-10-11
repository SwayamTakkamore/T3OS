import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkLocalModelInstalled,
  getModelEstimatedSize,
  installLocalModel,
} from "../src/provider/localModel.js";

describe("localModel", () => {
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

  it("installs local model and verifies status as installed", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "t3os-test-hf-"));
    const progressLogs: string[] = [];
    try {
      const result = await installLocalModel("google/gemma-3-4b-it", {
        cacheDir: tempDir,
        onProgress: (msg) => progressLogs.push(msg),
      });

      expect(result.success).toBe(true);
      expect(result.modelId).toBe("google/gemma-3-4b-it");
      expect(progressLogs.length).toBeGreaterThan(0);

      // Now verify status check finds it installed
      const status = await checkLocalModelInstalled("google/gemma-3-4b-it", tempDir);
      expect(status.isInstalled).toBe(true);
      expect(status.path).toContain("models--google--gemma-3-4b-it");
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
