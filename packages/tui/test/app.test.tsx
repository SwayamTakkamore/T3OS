import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { App } from "../src/App.js";
import { emptyTranscript } from "../src/transcript.js";
import type { DownloadProgress } from "@t3os/core";

// Mutable hook so individual tests can override the filesystem probe verdict
// without affecting other tests (which fall through to the real implementation).
let mockLocalModelStatus: Awaited<
  ReturnType<typeof import("@t3os/core").checkLocalModelInstalled>
> | null = null;

vi.mock("@t3os/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3os/core")>();
  return {
    ...actual,
    checkLocalModelInstalled: ((...args: Parameters<typeof actual.checkLocalModelInstalled>) =>
      mockLocalModelStatus
        ? Promise.resolve(mockLocalModelStatus)
        : actual.checkLocalModelInstalled(...args)) as typeof actual.checkLocalModelInstalled,
  };
});

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

const CTRL_P = "\x10";
const DOWN = "\u001B[B";
const ENTER = "\r";
const ESC = "\u001B";

describe("App", () => {
  it("renders the model and transcript entries", () => {
    const state = emptyTranscript();
    state.entries.push({ kind: "assistant", text: "hello from gemma" });
    const { lastFrame } = render(
      <App
        state={state}
        model="google/gemma-4-31B-it"
        effort="high"
        onSubmit={() => {}}
        onPermission={() => {}}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("google/gemma-4-31B-it");
    expect(frame).toContain("hello from gemma");
    expect(frame).toContain("[Ctrl+P] Settings");
  });

  it("opens settings menu with Ctrl+P and navigates submenus", async () => {
    const state = emptyTranscript();
    const onChangeModel = vi.fn();
    const { stdin, lastFrame } = render(
      <App
        state={state}
        model="google/gemma-4-31B-it"
        effort="high"
        onSubmit={() => {}}
        onPermission={() => {}}
        onChangeModel={onChangeModel}
      />,
    );

    // Wait for mount useEffect to attach stdin rawMode listener
    await tick(100);

    // Press Ctrl+P (\x10) to open Settings Palette
    stdin.write("\x10");
    await tick(100);
    let frame = lastFrame();
    expect(frame).toContain("Settings Palette");
    expect(frame).toContain("Model Selection");
    expect(frame).toContain("Effort & Reasoning");

    // Press Enter to drill into Model Selection submenu
    stdin.write("\r");
    await tick(100);
    frame = lastFrame();
    expect(frame).toContain("Settings Palette ▸ Model Selection");
    expect(frame).toContain("[Gemma 4] google/gemma-4-31B-it");
    expect(frame).toContain("[Gemma 3] google/gemma-3-12b-it");

    // Press Down arrow to select the next model (Gemma 4 26B) and Enter to apply
    stdin.write("\u001B[B"); // Down arrow
    await tick(100);
    stdin.write("\r"); // Enter
    await tick(100);

    expect(onChangeModel).toHaveBeenCalledWith("google/gemma-4-26B-A4B-it");
  });

  it("handles confirmation, install check with estimated size, and switch when selecting local model", async () => {
    const state = emptyTranscript();
    const onChangeProvider = vi.fn();
    const onCheckModelInstalled = vi.fn().mockResolvedValue(false);
    const onInstallModel = vi.fn().mockImplementation((_model, onProgress) => {
      onProgress({
        percent: 60,
        downloadedBytes: 1.68 * 1024 * 1024 * 1024,
        totalBytes: 2.8 * 1024 * 1024 * 1024,
        speedBytesPerSec: 28.5 * 1024 * 1024,
        etaSeconds: 42,
        formattedSpeed: "28.5 MB/s",
        formattedEta: "42s remaining",
        formattedDownloaded: "1.68 GB",
        formattedTotal: "2.80 GB",
        statusText: "Downloading ONNX token embeddings (onnx-community/gemma-3-4b-it-ONNX/onnx/embed_tokens.onnx)…",
      });
      return Promise.resolve(true);
    });

    const { stdin, lastFrame } = render(
      <App
        state={state}
        model="google/gemma-3-4b-it"
        effort="high"
        providerType="hf"
        onSubmit={() => {}}
        onPermission={() => {}}
        onChangeProvider={onChangeProvider}
        onCheckModelInstalled={onCheckModelInstalled}
        onInstallModel={onInstallModel}
      />,
    );

    await tick(100);

    // 1. Open Settings Menu
    stdin.write("\x10");
    await tick(100);

    // 2. Navigate down to "AI Provider" (index 3) and press Enter
    stdin.write("\u001B[B"); // 1: Effort
    await tick(50);
    stdin.write("\u001B[B"); // 2: Permission
    await tick(50);
    stdin.write("\u001B[B"); // 3: AI Provider
    await tick(50);
    stdin.write("\r"); // Open AI Provider submenu
    await tick(100);

    let frame = lastFrame();
    expect(frame).toContain("AI Provider");
    expect(frame).toContain("Hugging Face (Local)");

    // 3. Move down to "Hugging Face (Local)" and select
    stdin.write("\u001B[B");
    await tick(50);
    stdin.write("\r");
    await tick(100);

    // 4. Verify Step 1: Confirmation Prompt appears!
    frame = lastFrame();
    expect(frame).toContain("Switch to Local Model");
    expect(frame).toContain("google/gemma-3-4b-it");
    expect(frame).toContain("[y] Confirm Switch");

    // 5. Confirm switch by pressing 'y'
    stdin.write("y");
    await tick(100);

    expect(onCheckModelInstalled).toHaveBeenCalledWith("google/gemma-3-4b-it");

    // 6. Verify Step 2: Since not installed, asks if want to install with estimated file size!
    frame = lastFrame();
    expect(frame).toContain("Local Model Not Installed");
    expect(frame).toContain("Estimated download size: ~3.2 GB");
    expect(frame).toContain("[y] Install & Switch to Local");

    // 7. Confirm installation by pressing 'y'
    stdin.write("y");
    await tick(100);

    expect(onInstallModel).toHaveBeenCalled();
    expect(onChangeProvider).toHaveBeenCalledWith("local");

    // 8. Success status message references the actual ONNX community model
    await tick(100);
    frame = lastFrame();
    expect(frame).toContain("Local ONNX model onnx-community/gemma-3-4b-it-ONNX");
    expect(frame).toContain("downloaded and path set");
    expect(frame).toContain("local mode.");
  });

  it("shows download progress bar, speed, ETA, and allows cancelling with confirmation", async () => {
    const state = emptyTranscript();
    let triggerProgress: ((prog: DownloadProgress) => void) | null = null;
    let receivedSignal: AbortSignal | undefined;

    const onCheckModelInstalled = vi.fn().mockResolvedValue(false);
    const onInstallModel = vi.fn().mockImplementation((_target, onProg, signal) => {
      triggerProgress = onProg;
      receivedSignal = signal;
      return new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
          resolve(false);
        });
      });
    });

    const { stdin, lastFrame } = render(
      <App
        state={state}
        model="google/gemma-3-4b-it"
        effort="high"
        providerType="hf"
        onSubmit={() => {}}
        onPermission={() => {}}
        onCheckModelInstalled={onCheckModelInstalled}
        onInstallModel={onInstallModel}
      />,
    );

    await tick(100);

    // Open settings and pick Local
    stdin.write("\x10");
    await tick(100);
    stdin.write("\u001B[B"); // 1
    await tick(50);
    stdin.write("\u001B[B"); // 2
    await tick(50);
    stdin.write("\u001B[B"); // 3 (AI Provider)
    await tick(50);
    stdin.write("\r");
    await tick(100);
    stdin.write("\u001B[B"); // Local
    await tick(50);
    stdin.write("\r");
    await tick(100);

    // Confirm switch to local
    stdin.write("y");
    await tick(100);

    // Confirm install
    stdin.write("y");
    await tick(100);

    // Emit progress update
    triggerProgress?.({
      percent: 54,
      downloadedBytes: 1.51 * 1024 * 1024 * 1024,
      totalBytes: 2.8 * 1024 * 1024 * 1024,
      speedBytesPerSec: 28.4 * 1024 * 1024,
      etaSeconds: 45,
      formattedSpeed: "28.4 MB/s",
      formattedEta: "45s remaining",
      formattedDownloaded: "1.51 GB",
      formattedTotal: "2.80 GB",
      statusText: "Downloading ONNX token embeddings (onnx-community/gemma-3-4b-it-ONNX/onnx/embed_tokens.onnx)…",
    });
    await tick(100);

    // Verify progress bar, speed, ETA and cancel option are shown
    let frame = lastFrame();
    expect(frame).toContain("Downloading ONNX model onnx-community/gemma-3-4b-it-ONNX (google/gemma-3-4b-it)");
    expect(frame).toContain("Downloading ONNX token embeddings");
    expect(frame).toContain("54%");
    expect(frame).toContain("28.4 MB/s");
    expect(frame).toContain("45s remaining");
    expect(frame).toContain("[c] Cancel download");

    // Press 'c' to request cancellation
    stdin.write("c");
    await tick(100);

    // Verify Cancel confirmation dialog appears!
    frame = lastFrame();
    expect(frame).toContain("Cancel Model Download?");
    expect(frame).toContain("54% complete");
    expect(frame).toContain("[y] Yes, cancel download");
    expect(frame).toContain("[n] Continue downloading");

    // Press 'y' to confirm cancel
    stdin.write("y");
    await tick(100);

    expect(receivedSignal?.aborted).toBe(true);
    frame = lastFrame();
    expect(frame).toContain("Download cancelled");
  });

  it("resumes download progress if cancellation is declined with 'n'", async () => {
    const state = emptyTranscript();
    let triggerProgress: ((prog: DownloadProgress) => void) | null = null;

    const onCheckModelInstalled = vi.fn().mockResolvedValue(false);
    const onInstallModel = vi.fn().mockImplementation((_target, onProg, signal) => {
      triggerProgress = onProg;
      return new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
          resolve(false);
        });
      });
    });

    const { stdin, lastFrame } = render(
      <App
        state={state}
        model="google/gemma-3-4b-it"
        effort="high"
        providerType="hf"
        onSubmit={() => {}}
        onPermission={() => {}}
        onCheckModelInstalled={onCheckModelInstalled}
        onInstallModel={onInstallModel}
      />,
    );

    await tick(100);

    // Open settings and pick Local
    stdin.write("\x10");
    await tick(100);
    stdin.write("\u001B[B"); // 1
    await tick(50);
    stdin.write("\u001B[B"); // 2
    await tick(50);
    stdin.write("\u001B[B"); // 3
    await tick(50);
    stdin.write("\r");
    await tick(100);
    stdin.write("\u001B[B"); // Local
    await tick(50);
    stdin.write("\r");
    await tick(100);

    // Confirm switch and install
    stdin.write("y");
    await tick(100);
    stdin.write("y");
    await tick(100);

    triggerProgress?.({
      percent: 40,
      downloadedBytes: 1.12 * 1024 * 1024 * 1024,
      totalBytes: 2.8 * 1024 * 1024 * 1024,
      speedBytesPerSec: 25.0 * 1024 * 1024,
      etaSeconds: 67,
      formattedSpeed: "25.0 MB/s",
      formattedEta: "1m 7s remaining",
      formattedDownloaded: "1.12 GB",
      formattedTotal: "2.80 GB",
      statusText: "Downloading ONNX decoder weights & computation graph (onnx-community/gemma-3-4b-it-ONNX/onnx/decoder_model_merged.onnx)…",
    });
    await tick(100);

    // Press 'c' to open cancel prompt
    stdin.write("c");
    await tick(100);
    let frame = lastFrame();
    expect(frame).toContain("Cancel Model Download?");

    // Decline cancel with 'n'
    stdin.write("n");
    await tick(100);

    // Should be back to downloading view!
    frame = lastFrame();
    expect(frame).toContain("Downloading ONNX model onnx-community/gemma-3-4b-it-ONNX");
    expect(frame).toContain("40%");
  });

  it("switches to local atomically through onChangeSettings when the model is installed", async () => {
    const state = emptyTranscript();
    const onChangeSettings = vi.fn().mockResolvedValue(undefined);
    const onChangeModel = vi.fn();
    const onChangeProvider = vi.fn();
    const onCheckModelInstalled = vi.fn().mockResolvedValue(true);

    const { stdin, lastFrame } = render(
      <App
        state={state}
        model="google/gemma-3-4b-it"
        effort="high"
        providerType="hf"
        onSubmit={() => {}}
        onPermission={() => {}}
        onChangeSettings={onChangeSettings}
        onChangeModel={onChangeModel}
        onChangeProvider={onChangeProvider}
        onCheckModelInstalled={onCheckModelInstalled}
      />,
    );

    await tick(100);

    // Settings > AI Provider > Hugging Face (Local)
    stdin.write("\x10");
    await tick(100);
    stdin.write("\u001B[B"); // 1
    await tick(50);
    stdin.write("\u001B[B"); // 2
    await tick(50);
    stdin.write("\u001B[B"); // 3 (AI Provider)
    await tick(50);
    stdin.write("\r");
    await tick(100);
    stdin.write("\u001B[B"); // Local
    await tick(50);
    stdin.write("\r");
    await tick(100);

    // Confirm the switch (the model is already installed).
    stdin.write("y");
    await tick(150);

    expect(onCheckModelInstalled).toHaveBeenCalledWith("google/gemma-3-4b-it");
    expect(onChangeSettings).toHaveBeenCalledTimes(1);
    expect(onChangeSettings).toHaveBeenCalledWith({ provider: "local" });
    // No redundant model update and no legacy granular callbacks.
    expect(onChangeModel).not.toHaveBeenCalled();
    expect(onChangeProvider).not.toHaveBeenCalled();

    const frame = lastFrame();
    expect(frame).toContain("[LOCAL]");
    expect(frame).toContain("Switched to local mode");
  });

  it("surfaces an atomic provider switch failure and reverts the header to Cloud", async () => {
    const state = emptyTranscript();
    const onChangeSettings = vi
      .fn()
      .mockRejectedValue(new Error("local engine unavailable"));
    const onCheckModelInstalled = vi.fn().mockResolvedValue(true);

    const { stdin, lastFrame } = render(
      <App
        state={state}
        model="google/gemma-3-4b-it"
        effort="high"
        providerType="hf"
        onSubmit={() => {}}
        onPermission={() => {}}
        onChangeSettings={onChangeSettings}
        onCheckModelInstalled={onCheckModelInstalled}
      />,
    );

    await tick(100);

    // Settings > AI Provider > Hugging Face (Local)
    stdin.write("\x10");
    await tick(100);
    stdin.write("\u001B[B"); // 1
    await tick(50);
    stdin.write("\u001B[B"); // 2
    await tick(50);
    stdin.write("\u001B[B"); // 3 (AI Provider)
    await tick(50);
    stdin.write("\r");
    await tick(100);
    stdin.write("\u001B[B"); // Local
    await tick(50);
    stdin.write("\r");
    await tick(100);

    // Confirm the switch; the provider factory rejects.
    stdin.write("y");
    await tick(150);

    const frame = lastFrame();
    // The header must not claim [LOCAL] while the cloud provider is active.
    expect(frame).toContain("[CLOUD]");
    expect(frame).not.toContain("[LOCAL]");
    expect(frame).toContain("✖");
    expect(frame).toContain("local engine unavailable");
  });

  it("cancels switch to local model when declined", async () => {
    const state = emptyTranscript();
    const onChangeProvider = vi.fn();

    const { stdin, lastFrame } = render(
      <App
        state={state}
        model="google/gemma-3-4b-it"
        effort="high"
        providerType="hf"
        onSubmit={() => {}}
        onPermission={() => {}}
        onChangeProvider={onChangeProvider}
      />,
    );

    await tick(100);

    // Open settings and select Local Provider
    stdin.write("\x10");
    await tick(100);
    stdin.write("\u001B[B"); // 1
    await tick(50);
    stdin.write("\u001B[B"); // 2
    await tick(50);
    stdin.write("\u001B[B"); // 3 (AI Provider)
    await tick(50);
    stdin.write("\r");
    await tick(100);
    stdin.write("\u001B[B"); // Local
    await tick(50);
    stdin.write("\r");
    await tick(100);

    let frame = lastFrame();
    expect(frame).toContain("Switch to Local Model");

    // Press 'n' to cancel
    stdin.write("n");
    await tick(100);

    expect(onChangeProvider).not.toHaveBeenCalled();
    frame = lastFrame();
    expect(frame).toContain("Switch to local model cancelled");
  });

  it("groups the main settings menu into sections with a live Check Model status", async () => {
    const state = emptyTranscript();
    const onCheckModelInstalled = vi.fn().mockResolvedValue(false);

    const { stdin, lastFrame } = render(
      <App
        state={state}
        model="google/gemma-3-4b-it"
        effort="high"
        providerType="hf"
        onSubmit={() => {}}
        onPermission={() => {}}
        onCheckModelInstalled={onCheckModelInstalled}
      />,
    );

    await tick(100);

    stdin.write("\x10");
    await tick(100);

    const frame = lastFrame();
    // Section headers group related settings.
    expect(frame).toContain("─── T3 Engine ───");
    expect(frame).toContain("─── OpenCode Integration ───");
    expect(frame).toContain("─── T3 Connect ───");
    expect(frame).toContain("─── System ───");
    // Items inside the sections.
    expect(frame).toContain("Check Model");
    expect(frame).toContain("OpenCode Orchestrator");
    expect(frame).toContain("Sessions");
    expect(frame).toContain("Clear Transcript");
    // The Check Model row surfaces the cached install verdict.
    expect(frame).toContain("Not installed");
  });

  it("navigates to Check Model and shows status, ONNX repo, size, and cache path", async () => {
    const state = emptyTranscript();
    const onCheckModelInstalled = vi.fn().mockResolvedValue(false);

    const { stdin, lastFrame } = render(
      <App
        state={state}
        model="google/gemma-3-4b-it"
        effort="high"
        providerType="hf"
        onSubmit={() => {}}
        onPermission={() => {}}
        onCheckModelInstalled={onCheckModelInstalled}
      />,
    );

    await tick(100);

    stdin.write("\x10");
    await tick(100);
    // Down to "Check Model" (index 4 in the T3 Engine section).
    for (let i = 0; i < 4; i++) {
      stdin.write(DOWN);
      await tick(30);
    }
    stdin.write(ENTER);
    await tick(100);

    let frame = lastFrame();
    expect(frame).toContain("Settings Palette ▸ Check Model");
    expect(frame).toContain("Target Model ID");
    expect(frame).toContain("google/gemma-3-4b-it");
    expect(frame).toContain("ONNX Model Repository");
    expect(frame).toContain("onnx-community/gemma-3-4b-it-ONNX");
    expect(frame).toContain("~3.2 GB");
    expect(frame).toContain("Size on Disk");
    expect(frame).toContain("✖ Not installed");
    expect(frame).toContain("Local cache path:");
    // The cache path is rendered on its own line as an absolute path.
    expect(frame).toMatch(/Local cache path:[^\n]*\n[^\n]*\//);
    expect(frame).toContain("Download & Install Model");
    expect(frame).toContain("Check Different Model");

    // "Check Different Model" lists every preset for inspection.
    for (let i = 0; i < 2; i++) {
      stdin.write(DOWN);
      await tick(30);
    }
    stdin.write(ENTER);
    await tick(100);
    frame = lastFrame();
    expect(frame).toContain("Settings Palette ▸ Check Different Model");
    expect(frame).toContain("[Gemma 4] google/gemma-4-31B-it");
    expect(frame).toContain("[Gemma 3] google/gemma-3-12b-it");

    // Inspect gemma-3-12b-it without switching the active model.
    for (let i = 0; i < 3; i++) {
      stdin.write(DOWN);
      await tick(30);
    }
    stdin.write(ENTER);
    await tick(100);
    frame = lastFrame();
    expect(frame).toContain("Settings Palette ▸ Check Model");
    expect(frame).toContain("google/gemma-3-12b-it");
    expect(frame).toContain("~7.0 GB");
  });

  it("opens the OpenCode Orchestrator informational submenu", async () => {
    const state = emptyTranscript();
    const { stdin, lastFrame } = render(
      <App
        state={state}
        model="google/gemma-4-31B-it"
        effort="high"
        onSubmit={() => {}}
        onPermission={() => {}}
      />,
    );

    await tick(100);

    stdin.write(CTRL_P);
    await tick(100);
    // Down to "OpenCode Orchestrator" (index 5).
    for (let i = 0; i < 5; i++) {
      stdin.write(DOWN);
      await tick(30);
    }
    stdin.write(ENTER);
    await tick(100);

    const frame = lastFrame();
    expect(frame).toContain("Settings Palette ▸ OpenCode Orchestrator");
    expect(frame).toContain("opencode/big-pickle");
    expect(frame).toContain("OpenCode (Local & Remote)");
    expect(frame).toContain("High / Extra High");
    expect(frame).toContain("Enabled (Task Orchestrator)");
    expect(frame).toContain("← Back to Main Menu");
  });

  it("downloads from Check Model, shows live progress, and cancels with re-ask", async () => {
    const state = emptyTranscript();
    let triggerProgress: ((prog: DownloadProgress) => void) | null = null;
    let receivedSignal: AbortSignal | undefined;

    const onCheckModelInstalled = vi.fn().mockResolvedValue(false);
    const onInstallModel = vi.fn().mockImplementation((_target, onProg, signal) => {
      triggerProgress = onProg;
      receivedSignal = signal;
      return new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
          resolve(false);
        });
      });
    });

    const { stdin, lastFrame } = render(
      <App
        state={state}
        model="google/gemma-3-4b-it"
        effort="high"
        providerType="hf"
        onSubmit={() => {}}
        onPermission={() => {}}
        onCheckModelInstalled={onCheckModelInstalled}
        onInstallModel={onInstallModel}
      />,
    );

    await tick(100);

    // Settings Palette ▸ Check Model ▸ Download & Install Model
    stdin.write(CTRL_P);
    await tick(100);
    for (let i = 0; i < 4; i++) {
      stdin.write(DOWN);
      await tick(30);
    }
    stdin.write(ENTER);
    await tick(100);

    let frame = lastFrame();
    expect(frame).toContain("Download & Install Model");
    stdin.write(ENTER);
    await tick(100);

    // The palette stays open on Check Model with the download running.
    frame = lastFrame();
    expect(frame).toContain("Cancel Download");
    expect(onInstallModel).toHaveBeenCalled();

    triggerProgress?.({
      percent: 45,
      downloadedBytes: 1.12 * 1024 * 1024 * 1024,
      totalBytes: 2.46 * 1024 * 1024 * 1024,
      speedBytesPerSec: 28.4 * 1024 * 1024,
      etaSeconds: 42,
      formattedSpeed: "28.4 MB/s",
      formattedEta: "42s remaining",
      formattedDownloaded: "1.12 GB",
      formattedTotal: "2.46 GB",
      statusText: "Downloading ONNX token embeddings (onnx-community/gemma-3-4b-it-ONNX/onnx/embed_tokens.onnx)…",
    });
    await tick(100);

    frame = lastFrame();
    expect(frame).toContain("45%");
    expect(frame).toContain("28.4 MB/s");
    expect(frame).toContain("42s remaining");
    expect(frame).toContain("1.12 GB / 2.46 GB");
    expect(frame).toContain("Downloading ONNX token embeddings");
    expect(frame).toContain("Cancel Download");

    // Enter on "Cancel Download" asks for confirmation before aborting.
    stdin.write(ENTER);
    await tick(100);
    frame = lastFrame();
    expect(frame).toContain("Cancel Model Download?");
    expect(frame).toContain("45% complete");
    expect(frame).toContain("[y] Yes, cancel download");
    expect(frame).toContain("[n] Continue downloading");

    stdin.write("y");
    await tick(150);

    expect(receivedSignal?.aborted).toBe(true);
    frame = lastFrame();
    expect(frame).toContain("Download cancelled");
  });

  it("keeps the download running in the background when Esc is pressed during download", async () => {
    const state = emptyTranscript();
    let triggerProgress: ((prog: DownloadProgress) => void) | null = null;

    const onCheckModelInstalled = vi.fn().mockResolvedValue(false);
    const onInstallModel = vi.fn().mockImplementation((_target, onProg, signal) => {
      triggerProgress = onProg;
      return new Promise((resolve) => {
        signal?.addEventListener("abort", () => {
          resolve(false);
        });
      });
    });

    const { stdin, lastFrame } = render(
      <App
        state={state}
        model="google/gemma-3-4b-it"
        effort="high"
        providerType="hf"
        onSubmit={() => {}}
        onPermission={() => {}}
        onCheckModelInstalled={onCheckModelInstalled}
        onInstallModel={onInstallModel}
      />,
    );

    await tick(100);

    // Start a download through the provider switch flow (overlay view).
    stdin.write(CTRL_P);
    await tick(100);
    for (let i = 0; i < 3; i++) {
      stdin.write(DOWN);
      await tick(30);
    }
    stdin.write(ENTER);
    await tick(100);
    stdin.write(DOWN);
    await tick(30);
    stdin.write(ENTER);
    await tick(100);
    stdin.write("y");
    await tick(100);
    stdin.write("y");
    await tick(100);

    triggerProgress?.({
      percent: 30,
      downloadedBytes: 0.74 * 1024 * 1024 * 1024,
      totalBytes: 2.46 * 1024 * 1024 * 1024,
      speedBytesPerSec: 25.0 * 1024 * 1024,
      etaSeconds: 69,
      formattedSpeed: "25.0 MB/s",
      formattedEta: "1m 9s remaining",
      formattedDownloaded: "758 MB",
      formattedTotal: "2.46 GB",
      statusText: "Downloading ONNX decoder weights…",
    });
    await tick(100);
    expect(lastFrame()).toContain("30%");

    // Esc backgrounds the download: the transcript stays usable and a slim
    // banner keeps reporting live progress.
    stdin.write(ESC);
    await tick(100);
    let frame = lastFrame();
    expect(frame).toContain("Downloading google/gemma-3-4b-it — 30%");
    expect(frame).toContain("[Ctrl+P] Settings ▸ Check Model");

    // Reopen Settings and open Check Model: live progress is shown there too.
    stdin.write(CTRL_P);
    await tick(100);
    for (let i = 0; i < 4; i++) {
      stdin.write(DOWN);
      await tick(30);
    }
    stdin.write(ENTER);
    await tick(100);
    frame = lastFrame();
    expect(frame).toContain("30%");
    expect(frame).toContain("25.0 MB/s");
    expect(frame).toContain("Cancel Download");

    // Declining the cancel confirmation returns to the palette's progress view.
    stdin.write(ENTER);
    await tick(100);
    expect(lastFrame()).toContain("Cancel Model Download?");
    stdin.write("n");
    await tick(100);
    frame = lastFrame();
    expect(frame).toContain("Settings Palette ▸ Check Model");
    expect(frame).toContain("30%");
  });

  it("shows Incomplete in the menu and Check Model view when the cache is partial (19.7 MB of 2.4 GB)", async () => {
    mockLocalModelStatus = {
      modelId: "google/gemma-3-4b-it",
      isInstalled: false,
      estimatedSize: "~3.2 GB (ONNX Q4)",
      path: "/tmp/fake/models--onnx-community--gemma-3-4b-it-ONNX",
      details:
        "Incomplete download: only 19.7 MB of ~3.2 GB (ONNX Q4) downloaded (tensor weights .onnx_data missing or partial)",
      diskSizeBytes: 19.7 * 1024 * 1024,
      formattedDiskSize: "19.7 MB",
      incomplete: true,
    };

    try {
      const state = emptyTranscript();
      const { stdin, lastFrame } = render(
        <App
          state={state}
          model="google/gemma-3-4b-it"
          effort="high"
          providerType="hf"
          onSubmit={() => {}}
          onPermission={() => {}}
        />,
      );

      await tick(150);

      // Open the main settings palette and verify the Check Model row shows Incomplete.
      stdin.write(CTRL_P);
      await tick(150);

      let frame = lastFrame();
      expect(frame).toContain("Check Model");
      expect(frame).toContain("Incomplete (19.7 MB)");

      // Drill into Check Model view.
      for (let i = 0; i < 4; i++) {
        stdin.write(DOWN);
        await tick(30);
      }
      stdin.write(ENTER);
      await tick(150);

      frame = lastFrame();
      expect(frame).toContain("Settings Palette ▸ Check Model");
      expect(frame).toContain("⚠ Incomplete download (19.7 MB of ~3.2 GB (ONNX Q4))");
      expect(frame).toContain("Download & Complete Installation");
      // The "Switch to Local Mode" option is not offered when the download is incomplete.
      expect(frame).not.toContain("Switch Provider to Local Mode");
    } finally {
      mockLocalModelStatus = null;
    }
  });

  it("attaches a dropped file path, renders a chip, and injects contents on submit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3os-drop-"));
    const droppedFile = path.join(dir, "note.txt");
    fs.writeFileSync(droppedFile, "hello from the dropped file");

    try {
      const state = emptyTranscript();
      const onSubmit = vi.fn();
      const { stdin, lastFrame } = render(
        <App
          state={state}
          model="google/gemma-4-31B-it"
          effort="high"
          onSubmit={onSubmit}
          onPermission={() => {}}
        />,
      );

      await tick(100);

      // Dropping the path attaches it instead of typing raw path text.
      stdin.write(droppedFile);
      await tick(50);

      let frame = lastFrame();
      expect(frame).toContain("📎 Attached:");
      expect(frame).toContain("[📄 note.txt");
      expect(frame).not.toContain(`❯ ${droppedFile}`);
      expect(frame).toContain("[Drop File/Dir] Attach");

      // The prompt itself still accepts normal typing alongside the chip.
      stdin.write("explain this");
      await tick(50);
      expect(lastFrame()).toContain("explain this");

      stdin.write(ENTER);
      await tick(50);

      expect(onSubmit).toHaveBeenCalledTimes(1);
      const prompt = onSubmit.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("explain this");
      expect(prompt).toContain("## Attached context");
      expect(prompt).toContain("hello from the dropped file");
      expect(prompt).toContain("note.txt");
      // Both the chip and the input line are cleared after submitting.
      expect(lastFrame()).not.toContain("[📄 note.txt");
      expect(lastFrame()).not.toContain("explain this");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("submits a dropped file without prompt text using a default instruction", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3os-drop-"));
    const droppedFile = path.join(dir, "lonely.txt");
    fs.writeFileSync(droppedFile, "attachment only");

    try {
      const state = emptyTranscript();
      const onSubmit = vi.fn();
      const { stdin } = render(
        <App
          state={state}
          model="google/gemma-4-31B-it"
          effort="high"
          onSubmit={onSubmit}
          onPermission={() => {}}
        />,
      );

      await tick(100);
      stdin.write(droppedFile);
      await tick(50);
      stdin.write(ENTER);
      await tick(50);

      expect(onSubmit).toHaveBeenCalledTimes(1);
      const prompt = onSubmit.mock.calls[0]?.[0] as string;
      expect(prompt).toContain("Please inspect and explain the attached file(s)/directory.");
      expect(prompt).toContain("attachment only");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detaches the most recent attachment with Backspace when the input line is empty", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3os-drop-"));
    const droppedFile = path.join(dir, "readme.md");
    fs.writeFileSync(droppedFile, "# readme");

    try {
      const state = emptyTranscript();
      const onSubmit = vi.fn();
      const { stdin, lastFrame } = render(
        <App
          state={state}
          model="google/gemma-4-31B-it"
          effort="high"
          onSubmit={onSubmit}
          onPermission={() => {}}
        />,
      );

      await tick(100);
      stdin.write(droppedFile);
      await tick(50);
      expect(lastFrame()).toContain("[📄 readme.md");

      stdin.write("\x7f"); // Backspace with an empty line detaches instead.
      await tick(50);
      expect(lastFrame()).not.toContain("[📄 readme.md");

      // Nothing attached and no text: Enter must not submit.
      stdin.write(ENTER);
      await tick(50);
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("attaches a dropped directory with an item count and clears it with Ctrl+U", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t3os-drop-"));
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    fs.writeFileSync(path.join(dir, "b.txt"), "b");
    const dirName = path.basename(dir);

    try {
      const state = emptyTranscript();
      const onSubmit = vi.fn();
      const { stdin, lastFrame } = render(
        <App
          state={state}
          model="google/gemma-4-31B-it"
          effort="high"
          onSubmit={onSubmit}
          onPermission={() => {}}
        />,
      );

      await tick(100);
      stdin.write(dir);
      await tick(50);

      let frame = lastFrame();
      expect(frame).toContain(`[📁 ${dirName} (2 items)]`);

      // Ctrl+U on an empty line detaches everything.
      stdin.write("\x15");
      await tick(50);

      frame = lastFrame();
      expect(frame).not.toContain("[📁 ");
      expect(frame).toContain("Detached all attachments");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
