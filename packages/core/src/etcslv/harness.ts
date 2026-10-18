import type {
  IAgentHarness,
  AgentHarnessConfig,
  HarnessTurnOptions,
  HarnessTurnResult,
  TerminationReason,
  HarnessState,
  HookContext,
  ExecutionState
} from "./types.js";
import { randomUUID } from "node:crypto";

export class AgentHarness implements IAgentHarness {
  #config: AgentHarnessConfig;

  constructor(config: AgentHarnessConfig) {
    this.#config = config;
  }

  async runTurn(opts: HarnessTurnOptions = {}): Promise<HarnessTurnResult> {
    const { executionLoop, stateStore, contextManager, lifecycleHooks, verificationInterface, toolRegistry } = this.#config;
    
    executionLoop.reset();
    executionLoop.start();
    
    const ctx: HookContext = {
      executionState: executionLoop.getState(),
      currentStep: 0,
      messageHistory: contextManager.getWindow().messages
    };
    
    await lifecycleHooks.trigger("onTurnStart", ctx);
    
    if (opts.input) {
      contextManager.addMessage({ role: "user", content: opts.input });
      stateStore.appendTrajectory({ step: stateStore.getTrajectory().length + 1, type: "thought", data: { input: opts.input } });
    }
    
    (executionLoop as any).transition("thinking");
    ctx.executionState = executionLoop.getState();
    await lifecycleHooks.trigger("onStepEnd", ctx);
    
    (executionLoop as any).transition("verifying");
    const verifyResult = await verificationInterface.verifyStep(ctx);
    if (!verifyResult.valid) {
      (executionLoop as any).terminate("verification_failed");
      await lifecycleHooks.trigger("onTurnEnd", ctx);
      return this.#buildResult(executionLoop.getTerminationReason() || "verification_failed");
    }
    
    (executionLoop as any).transition("committing");
    ctx.executionState = executionLoop.getState();
    await lifecycleHooks.trigger("onTurnEnd", ctx);
    
    executionLoop.stop();
    
    return this.#buildResult(executionLoop.getTerminationReason() || "complete");
  }

  async *streamTurn(opts: HarnessTurnOptions = {}): AsyncIterable<{ type: string; data: unknown }> {
    const result = await this.runTurn(opts);
    yield { type: "turn_complete", data: result };
  }

  getState(): HarnessState {
    return this.#config.stateStore.getState();
  }

  reset(): void {
    this.#config.executionLoop.reset();
    this.#config.stateStore.clear();
    this.#config.contextManager.clear();
    this.#config.lifecycleHooks.clear();
    this.#config.verificationInterface.clear();
  }

  cancel(): void {
    this.#config.executionLoop.cancel();
  }

  #buildResult(reason: TerminationReason): HarnessTurnResult {
    return {
      completed: reason === "complete",
      terminationReason: reason,
      finalState: this.#config.stateStore.getState(),
      output: undefined as any,
      steps: this.#config.executionLoop.getSteps().length,
      trajectory: this.#config.stateStore.getTrajectory()
    };
  }
}
