import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ExecutionLoop,
  ToolRegistry,
  ContextManager,
  HarnessStateStore,
  LifecycleHooks,
  VerificationInterface,
  AgentHarness
} from "../src/etcslv/index.js";
import type { ToolDefinition, ToolExecutionResult, HookContext, HarnessState } from "../src/etcslv/types.js";
import { MockProvider } from "../src/provider/mock.js";
import type { Delta } from "../src/types.js";

describe("ETCSLV Framework", () => {
  describe("ExecutionLoop", () => {
    let loop: ExecutionLoop;
    
    beforeEach(() => {
      loop = new ExecutionLoop({ maxSteps: 10, maxRepeat: 2 });
    });
    
    it("starts in idle state", () => {
      expect(loop.getState()).toBe("idle");
    });
    
    it("transitions correctly", () => {
      loop.start();
      expect(loop.getState()).toBe("observing");
      loop.transition("thinking");
      expect(loop.getState()).toBe("thinking");
      loop.transition("tool_dispatch");
      expect(loop.getState()).toBe("tool_dispatch");
    });
    
    it("terminates properly", () => {
      loop.start();
      loop.terminate("complete");
      expect(loop.isTerminated()).toBe(true);
      expect(loop.getTerminationReason()).toBe("complete");
      expect(loop.getState()).toBe("terminated");
    });
    
    it("detects max steps", () => {
      loop.start();
      for (let i = 0; i < 12; i++) {
        loop.transition("thinking");
        loop.checkMaxSteps();
      }
      expect(loop.isTerminated()).toBe(true);
      expect(loop.getTerminationReason()).toBe("max_steps");
    });
    
    it("detects loops", () => {
      loop.start();
      loop.checkLoop("same_key");
      loop.checkLoop("same_key");
      loop.checkLoop("same_key");
      expect(loop.isTerminated()).toBe(true);
      expect(loop.getTerminationReason()).toBe("loop_detected");
    });
    
    it("can be cancelled", () => {
      loop.start();
      loop.transition("thinking");
      loop.cancel();
      expect(loop.isTerminated()).toBe(true);
      expect(loop.getTerminationReason()).toBe("cancelled");
    });
    
    it("resets properly", () => {
      loop.start();
      loop.transition("thinking");
      loop.terminate("error");
      loop.reset();
      expect(loop.getState()).toBe("idle");
      expect(loop.getSteps()).toHaveLength(0);
      expect(loop.getTerminationReason()).toBeUndefined();
    });
  });
  
  describe("ToolRegistry", () => {
    let registry: ToolRegistry;
    let mockTool: ToolDefinition;
    
    beforeEach(() => {
      registry = new ToolRegistry();
      mockTool = {
        schema: {
          name: "test_tool",
          description: "A test tool",
          parameters: { type: "object", properties: { text: { type: "string" } } }
        },
        class: "read",
        async run(args) {
          return { ok: true, content: `result: ${(args as any).text}` };
        }
      };
    });
    
    it("registers and retrieves tools", () => {
      registry.register(mockTool);
      expect(registry.has("test_tool")).toBe(true);
      expect(registry.get("test_tool")).toBe(mockTool);
    });
    
    it("unregisters tools", () => {
      registry.register(mockTool);
      registry.unregister("test_tool");
      expect(registry.has("test_tool")).toBe(false);
    });
    
    it("lists tools", () => {
      registry.register(mockTool);
      expect(registry.list()).toHaveLength(1);
    });
    
    it("discovers tools by query", () => {
      registry.register(mockTool);
      expect(registry.discover("test")).toHaveLength(1);
      expect(registry.discover("nonexistent")).toHaveLength(0);
    });
    
    it("validates tool arguments", () => {
      registry.register(mockTool);
      const result = registry.validate("test_tool", { text: "hello" });
      expect(result.valid).toBe(true);
    });
    
    it("validates unknown tools", () => {
      const result = registry.validate("unknown", {});
      expect(result.valid).toBe(false);
    });
    
    it("executes tools successfully", async () => {
      registry.register(mockTool);
      const result = await registry.execute("test_tool", { text: "hi" }, {});
      expect(result.ok).toBe(true);
      expect(result.content).toBe("result: hi");
    });
    
    it("handles tool execution errors", async () => {
      const errorTool: ToolDefinition = {
        schema: { name: "error_tool", description: "errors", parameters: {} },
        class: "execute",
        async run() {
          throw new Error("tool failed");
        }
      };
      registry.register(errorTool);
      const result = await registry.execute("error_tool", {}, {});
      expect(result.ok).toBe(false);
      expect(result.error).toBe("tool failed");
    });
  });
  
  describe("ContextManager", () => {
    let cm: ContextManager;
    
    beforeEach(() => {
      cm = new ContextManager();
    });
    
    it("manages messages", () => {
      cm.addMessage({ role: "user", content: "hello" });
      cm.addMessage({ role: "assistant", content: "hi" });
      const window = cm.getWindow();
      expect(window.messages).toHaveLength(2);
    });
    
    it("sets system prompt", () => {
      cm.setSystemPrompt("You are helpful");
      const window = cm.getWindow();
      expect(window.systemPromptIncluded).toBe(true);
      expect(window.messages[0]?.role).toBe("system");
    });
    
    it("clears messages", () => {
      cm.addMessage({ role: "user", content: "hi" });
      cm.clear();
      const window = cm.getWindow();
      expect(window.messages).toHaveLength(0);
    });
    
    it("estimates tokens", () => {
      const tokens = cm.estimateTokens("hello world");
      expect(tokens).toBeGreaterThan(0);
    });
    
    it("compacts messages", () => {
      for (let i = 0; i < 30; i++) {
        cm.addMessage({ role: "user", content: `msg${i}` });
      }
      cm.compact("truncate");
      const window = cm.getWindow();
      expect(window.messages.length).toBeLessThan(30);
    });
    
    it("sets token budget", () => {
      cm.setTokenBudget({ maxTokens: 1000 });
      expect(cm.getTokenBudget().maxTokens).toBe(1000);
    });
  });
  
  describe("HarnessStateStore", () => {
    let store: HarnessStateStore;
    
    beforeEach(() => {
      store = new HarnessStateStore();
    });
    
    it("gets initial state", () => {
      const state = store.getState();
      expect(state.version).toBe(1);
      expect(state.executionState).toBe("idle");
    });
    
    it("sets variables", () => {
      store.setVariable("key", "value");
      expect(store.getVariable("key")).toBe("value");
    });
    
    it("deletes variables", () => {
      store.setVariable("key", "value");
      store.deleteVariable("key");
      expect(store.getVariable("key")).toBeUndefined();
    });
    
    it("appends trajectory", () => {
      store.appendTrajectory({ type: "thought", data: { msg: "hi" } });
      expect(store.getTrajectory()).toHaveLength(1);
    });
    
    it("saves and loads checkpoints", () => {
      store.setVariable("x", 1);
      const cp = store.saveCheckpoint("test");
      store.setVariable("x", 2);
      store.loadCheckpoint(cp.id);
      expect(store.getVariable("x")).toBe(1);
    });
    
    it("lists checkpoints", () => {
      store.saveCheckpoint("a");
      store.saveCheckpoint("b");
      expect(store.listCheckpoints()).toHaveLength(2);
    });
    
    it("deletes checkpoints", () => {
      const cp = store.saveCheckpoint("a");
      store.deleteCheckpoint(cp.id);
      expect(store.listCheckpoints()).toHaveLength(0);
    });
    
    it("clears state", () => {
      store.setVariable("x", 1);
      store.appendTrajectory({ type: "thought", data: {} });
      store.clear();
      expect(store.getTrajectory()).toHaveLength(0);
      expect(store.getVariable("x")).toBeUndefined();
    });
  });
  
  describe("LifecycleHooks", () => {
    let hooks: LifecycleHooks;
    let called: boolean;
    
    beforeEach(() => {
      hooks = new LifecycleHooks();
      called = false;
    });
    
    it("registers and triggers hooks", async () => {
      hooks.register("onTurnStart", () => { called = true; });
      await hooks.trigger("onTurnStart", {} as HookContext);
      expect(called).toBe(true);
    });
    
    it("unregisters hooks", async () => {
      const handler = () => { called = true; };
      hooks.register("onTurnStart", handler);
      hooks.unregister("onTurnStart", handler);
      await hooks.trigger("onTurnStart", {} as HookContext);
      expect(called).toBe(false);
    });
    
    it("triggers preToolCall and can modify args", async () => {
      hooks.register("preToolCall", (_ctx, _name, args) => {
        return { proceed: true, modifiedArgs: { ...args as any, modified: true } };
      });
      const result = await (hooks as any).triggerPreToolCall({} as HookContext, "tool", { a: 1 });
      expect(result.modifiedArgs).toEqual({ a: 1, modified: true });
    });
    
    it("can block preToolCall", async () => {
      hooks.register("preToolCall", () => {
        return { proceed: false, reason: "blocked" };
      });
      const result = await (hooks as any).triggerPreToolCall({} as HookContext, "tool", {});
      expect(result.proceed).toBe(false);
      expect(result.reason).toBe("blocked");
    });
    
    it("clears hooks", async () => {
      hooks.register("onTurnStart", () => { called = true; });
      hooks.clear();
      await hooks.trigger("onTurnStart", {} as HookContext);
      expect(called).toBe(false);
    });
  });
  
  describe("VerificationInterface", () => {
    let vi: VerificationInterface;
    
    beforeEach(() => {
      vi = new VerificationInterface();
    });
    
    it("adds and verifies step verifiers", async () => {
      vi.addStepVerifier(() => ({ valid: true, score: 0.9 }));
      const result = await vi.verifyStep({} as HookContext);
      expect(result.valid).toBe(true);
      expect(result.score).toBe(0.9);
    });
    
    it("fails on invalid step verification", async () => {
      vi.addStepVerifier(() => ({ valid: false, feedback: "bad" }));
      const result = await vi.verifyStep({} as HookContext);
      expect(result.valid).toBe(false);
      expect(result.feedback).toBe("bad");
    });
    
    it("verifies tasks", async () => {
      vi.addTaskVerifier(() => ({ valid: true, score: 1.0 }));
      const result = await vi.verifyTask({} as HookContext, {} as HarnessState);
      expect(result.valid).toBe(true);
      expect(result.score).toBe(1.0);
    });
    
    it("removes verifiers", async () => {
      const v = () => ({ valid: false });
      vi.addStepVerifier(v);
      vi.removeStepVerifier(v);
      const result = await vi.verifyStep({} as HookContext);
      expect(result.valid).toBe(true);
    });
    
    it("clears verifiers", async () => {
      vi.addStepVerifier(() => ({ valid: false }));
      vi.clear();
      const result = await vi.verifyStep({} as HookContext);
      expect(result.valid).toBe(true);
    });
  });
  
  describe("AgentHarness integration", () => {
    let harness: AgentHarness;
    let executionLoop: ExecutionLoop;
    let toolRegistry: ToolRegistry;
    let contextManager: ContextManager;
    let stateStore: HarnessStateStore;
    let lifecycleHooks: LifecycleHooks;
    let verificationInterface: VerificationInterface;
    
    beforeEach(() => {
      executionLoop = new ExecutionLoop();
      toolRegistry = new ToolRegistry();
      contextManager = new ContextManager();
      stateStore = new HarnessStateStore();
      lifecycleHooks = new LifecycleHooks();
      verificationInterface = new VerificationInterface();
      
      harness = new AgentHarness({
        executionLoop,
        toolRegistry,
        contextManager,
        stateStore,
        lifecycleHooks,
        verificationInterface
      });
    });
    
    it("creates harness with all components", () => {
      expect(harness).toBeDefined();
    });
    
    it("runs a turn", async () => {
      const result = await harness.runTurn({ input: "hello" });
      expect(result).toBeDefined();
      expect(result.terminationReason).toBe("complete");
      expect(result.completed).toBe(true);
      expect(result.steps).toBeGreaterThan(0);
    });
    
    it("streams a turn", async () => {
      const events: any[] = [];
      for await (const event of harness.streamTurn({ input: "hi" })) {
        events.push(event);
      }
      expect(events.length).toBeGreaterThan(0);
      expect(events[0]?.type).toBe("turn_complete");
    });
    
    it("gets state", () => {
      const state = harness.getState();
      expect(state).toBeDefined();
      expect(state.version).toBe(1);
    });
    
    it("resets harness", () => {
      harness.reset();
      const state = harness.getState();
      expect(state.executionState).toBe("idle");
      expect(state.trajectory).toHaveLength(0);
    });
    
    it("cancels harness", () => {
      harness.cancel();
      expect(executionLoop.isTerminated()).toBe(true);
    });
    
    it("works with mock provider and tools", async () => {
      const mockProvider = new MockProvider([
        [{ type: "text", text: "thinking..." }, { type: "done" } as Delta]
      ]);
      
      const testTool: ToolDefinition = {
        schema: { name: "echo", description: "echo", parameters: { type: "object" } },
        class: "read",
        async run() { return { ok: true, content: "echo" }; }
      };
      toolRegistry.register(testTool);
      
      const result = await harness.runTurn({ input: "test" });
      expect(result.completed).toBe(true);
    });
  });
});
