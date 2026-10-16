import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { emptyTranscript } from "../src/transcript.js";
import type { DownloadProgress } from "@t3os/core";

const tick = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

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
        statusText: "Downloading model shard 2 of 3…",
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
    expect(frame).toContain("Estimated download size: ~2.8 GB");
    expect(frame).toContain("[y] Install & Switch to Local");

    // 7. Confirm installation by pressing 'y'
    stdin.write("y");
    await tick(100);

    expect(onInstallModel).toHaveBeenCalled();
    expect(onChangeProvider).toHaveBeenCalledWith("local");
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
      statusText: "Downloading model shards…",
    });
    await tick(100);

    // Verify progress bar, speed, ETA and cancel option are shown
    let frame = lastFrame();
    expect(frame).toContain("Downloading Local Model");
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
      statusText: "Downloading shard 1…",
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
    expect(frame).toContain("Downloading Local Model");
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
});
