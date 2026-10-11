import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { emptyTranscript } from "../src/transcript.js";

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
    const onInstallModel = vi.fn().mockResolvedValue(true);

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
