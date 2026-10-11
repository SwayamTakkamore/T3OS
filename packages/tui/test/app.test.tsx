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
});
