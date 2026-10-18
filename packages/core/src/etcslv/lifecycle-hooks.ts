import type { ILifecycleHooks, LifecycleHookMap, HookContext, PreToolCallResult, ToolExecutionResult } from "./types.js";

type Handler<K extends keyof LifecycleHookMap> = NonNullable<LifecycleHookMap[K]>;

export class LifecycleHooks implements ILifecycleHooks {
  #hooks = new Map<keyof LifecycleHookMap, Set<Function>>();

  register<K extends keyof LifecycleHookMap>(name: K, handler: Handler<K>): void {
    if (!this.#hooks.has(name)) {
      this.#hooks.set(name, new Set());
    }
    this.#hooks.get(name)!.add(handler);
  }

  unregister<K extends keyof LifecycleHookMap>(name: K, handler: Handler<K>): void {
    const set = this.#hooks.get(name);
    if (set) {
      set.delete(handler);
    }
  }

  clear(): void {
    this.#hooks.clear();
  }

  async trigger<K extends keyof LifecycleHookMap>(
    name: K,
    ...args: Parameters<NonNullable<LifecycleHookMap[K]>>
  ): Promise<void> {
    const set = this.#hooks.get(name);
    if (!set) return;
    for (const handler of set) {
      await (handler as any)(...args);
    }
  }

  async triggerPreToolCall(
    ctx: HookContext,
    toolName: string,
    args: unknown
  ): Promise<PreToolCallResult> {
    const set = this.#hooks.get("preToolCall");
    if (!set) return { proceed: true };
    let currentArgs = args;
    for (const handler of set) {
      const handlerTyped = handler as LifecycleHookMap["preToolCall"];
      if (handlerTyped) {
        const result = await handlerTyped(ctx, toolName, currentArgs);
        if (result && !result.proceed) {
          return { proceed: false, reason: (result.reason ?? undefined) as any };
        }
        if (result && result.modifiedArgs !== undefined) {
          currentArgs = result.modifiedArgs;
        }
      }
    }
    return { proceed: true, modifiedArgs: currentArgs };
  }
}
