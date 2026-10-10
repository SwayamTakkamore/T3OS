import { describe, expect, it } from "vitest";
import { unifiedDiff } from "../src/tools/diff.js";

describe("unifiedDiff", () => {
  it("returns an empty string for identical inputs", () => {
    expect(unifiedDiff("a\n", "a\n", "f.txt")).toBe("");
  });

  it("marks changed lines with -/+/space prefixes and a header", () => {
    const diff = unifiedDiff("a\nb\nc\n", "a\nB\nc\n", "f.txt");
    expect(diff).toContain("--- a/f.txt");
    expect(diff).toContain("+++ b/f.txt");
    expect(diff).toContain("-b");
    expect(diff).toContain("+B");
    expect(diff).toContain(" a");
  });
});
