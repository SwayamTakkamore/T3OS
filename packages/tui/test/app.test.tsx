import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App } from "../src/App.js";
import { emptyTranscript } from "../src/transcript.js";

describe("App", () => {
  it("renders the model and transcript entries", () => {
    const state = emptyTranscript();
    state.entries.push({ kind: "assistant", text: "hello from gemma" });
    const { lastFrame } = render(
      <App
        state={state}
        model="google/gemma-2-9b-it"
        onSubmit={() => {}}
        onPermission={() => {}}
      />,
    );
    const frame = lastFrame();
    expect(frame).toContain("google/gemma-2-9b-it");
    expect(frame).toContain("hello from gemma");
  });
});
