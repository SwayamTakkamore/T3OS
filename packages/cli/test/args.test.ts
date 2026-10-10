import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
  it("returns help for empty argv", () => {
    expect(parseArgs([])).toEqual({ command: "help", positionals: [], flags: {} });
  });

  it("separates command and positionals", () => {
    const parsed = parseArgs(["run", "summarize", "this"]);
    expect(parsed.command).toBe("run");
    expect(parsed.positionals).toEqual(["summarize", "this"]);
  });

  it("reads a --key value pair", () => {
    expect(parseArgs(["run", "--model", "google/gemma-2-2b-it"]).flags).toEqual({
      model: "google/gemma-2-2b-it",
    });
  });

  it("reads --key=value", () => {
    expect(parseArgs(["config", "set", "maxTurns=7"]).positionals).toEqual(["set", "maxTurns=7"]);
    expect(parseArgs(["run", "--model=google/gemma-2-9b-it"]).flags).toEqual({
      model: "google/gemma-2-9b-it",
    });
  });

  it("treats a trailing --flag as boolean true", () => {
    expect(parseArgs(["config", "show", "--json"]).flags).toEqual({ json: true });
  });

  it("treats a short flag as boolean true", () => {
    expect(parseArgs(["-h"]).flags).toEqual({ h: true });
    expect(parseArgs(["-h"]).command).toBe("-h");
  });
});
