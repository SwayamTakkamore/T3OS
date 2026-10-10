import { describe, expect, it } from "vitest";
import { builtInTools } from "../src/tools/registry.js";

describe("builtInTools", () => {
  it("returns the seven built-in tools with unique names", () => {
    const tools = builtInTools();
    expect(tools).toHaveLength(7);

    const names = tools.map((tool) => tool.schema.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.length).toBeGreaterThan(0);
    }
  });

  it("exposes at least one execute tool", () => {
    const classes = builtInTools().map((tool) => tool.class);
    expect(classes).toContain("execute");
  });
});
