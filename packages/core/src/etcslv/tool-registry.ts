import type { IToolRegistry, ToolDefinition, ToolExecutionResult } from "./types.js";
import { T3osError } from "../errors.js";
import type { ToolSchema } from "../types.js";

export class ToolRegistry implements IToolRegistry {
  #tools = new Map<string, ToolDefinition>();

  register(tool: ToolDefinition): void {
    this.#tools.set(tool.schema.name, tool);
  }

  unregister(name: string): void {
    this.#tools.delete(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.#tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.#tools.values());
  }

  has(name: string): boolean {
    return this.#tools.has(name);
  }

  discover(query?: string): ToolDefinition[] {
    const tools = this.list();
    if (!query) return tools;
    const q = query.toLowerCase();
    return tools.filter(t =>
      t.schema.name.toLowerCase().includes(q) ||
      t.schema.description.toLowerCase().includes(q)
    );
  }

  validate(name: string, args: unknown): { valid: boolean; errors?: string[] } {
    const tool = this.get(name);
    if (!tool) {
      return { valid: false, errors: [`unknown tool: ${name}`] };
    }
    // Basic validation - if args is not an object when expected
    if (tool.schema.parameters && typeof tool.schema.parameters === "object") {
      const params = tool.schema.parameters as Record<string, unknown>;
      if (params.type === "object" && args !== null && typeof args !== "object") {
        return { valid: false, errors: ["args must be an object"] };
      }
    }
    return { valid: true };
  }

  async execute(name: string, args: unknown, ctx: unknown): Promise<ToolExecutionResult> {
    const tool = this.get(name);
    if (!tool) {
      return {
        ok: false,
        content: `unknown tool: ${name}`,
        error: `unknown tool: ${name}`
      };
    }

    const validation = this.validate(name, args);
    if (!validation.valid) {
      return {
        ok: false,
        content: validation.errors?.join(", ") ?? "validation failed",
        error: validation.errors?.join(", ") ?? "validation failed"
      };
    }

    try {
      const result = await tool.run(args, ctx);
      return result;
    } catch (error) {
      return {
        ok: false,
        content: error instanceof Error ? error.message : String(error),
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  static fromT3osTools(tools: Array<any>): ToolRegistry {
    const registry = new ToolRegistry();
    for (const tool of tools) {
      registry.register({
        schema: tool.schema,
        class: tool.class,
        run: tool.run.bind(tool)
      });
    }
    return registry;
  }
}
