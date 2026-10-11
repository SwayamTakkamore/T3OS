import { describe, expect, it } from "vitest";
import {
  HF_TOKEN_URL,
  browserCommand,
  openBrowser,
  type BrowserCommand,
} from "@t3os/core";

describe("browserCommand", () => {
  it("uses open on macOS", () => {
    expect(browserCommand(HF_TOKEN_URL, "darwin")).toEqual({
      command: "open",
      args: [HF_TOKEN_URL],
    });
  });

  it("uses cmd start on Windows", () => {
    expect(browserCommand(HF_TOKEN_URL, "win32")).toEqual({
      command: "cmd",
      args: ["/c", "start", "", HF_TOKEN_URL],
    });
  });

  it("uses xdg-open on other platforms", () => {
    expect(browserCommand(HF_TOKEN_URL, "linux")).toEqual({
      command: "xdg-open",
      args: [HF_TOKEN_URL],
    });
  });
});

describe("openBrowser", () => {
  it("launches the platform command and returns true", () => {
    const calls: BrowserCommand[] = [];
    const opened = openBrowser(HF_TOKEN_URL, {
      platform: "linux",
      launch: (command, args) => {
        calls.push({ command, args: [...args] });
      },
    });
    expect(opened).toBe(true);
    expect(calls).toEqual([{ command: "xdg-open", args: [HF_TOKEN_URL] }]);
  });

  it("returns false when the launcher throws", () => {
    const opened = openBrowser(HF_TOKEN_URL, {
      platform: "linux",
      launch: () => {
        throw new Error("no display");
      },
    });
    expect(opened).toBe(false);
  });

  it("points at the HuggingFace token page", () => {
    expect(HF_TOKEN_URL).toBe("https://huggingface.co/settings/tokens");
  });
});
