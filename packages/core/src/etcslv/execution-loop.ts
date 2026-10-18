import type { ExecutionState, ExecutionStep, LoopOptions, TerminationReason, IExecutionLoop } from "./types.js";
import { randomUUID } from "node:crypto";

export class ExecutionLoop implements IExecutionLoop {
  #state: ExecutionState = "idle";
  #steps: ExecutionStep[] = [];
  #terminationReason: TerminationReason | undefined;
  #options: LoopOptions;
  #timer: any;
  #startTime?: number | undefined;
  #repeatCounts = new Map<string, number>();
  #lastKey?: string | undefined;

  constructor(options: LoopOptions = {}) {
    this.#options = {
      maxSteps: options.maxSteps ?? 100,
      maxRepeat: options.maxRepeat ?? 3,
      loopDetectionEnabled: options.loopDetectionEnabled ?? true,
      timeout: options.timeout as any
    };
  }

  start(): void {
    this.#startTime = Date.now();
    this.#state = "observing";
    this.#addStep("observing");
    if (this.#options.timeout) {
      this.#timer = setTimeout(() => {
        if (!this.isTerminated()) {
          this.terminate("cancelled");
        }
      }, this.#options.timeout);
    }
  }

  stop(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined as any;
    }
    if (!this.isTerminated()) {
      this.#state = "terminated";
      this.terminate("complete");
    }
  }

  reset(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    this.#state = "idle";
    this.#steps = [];
    this.#terminationReason = undefined;
    this.#repeatCounts.clear();
    this.#lastKey = undefined as any;
    this.#startTime = undefined as any;
  }

  cancel(): void {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (!this.isTerminated()) {
      this.terminate("cancelled");
    }
  }

  getState(): ExecutionState {
    return this.#state;
  }

  getSteps(): ExecutionStep[] {
    return [...this.#steps];
  }

  getCurrentStep(): ExecutionStep | undefined {
    return this.#steps[this.#steps.length - 1];
  }

  getTerminationReason(): TerminationReason | undefined {
    return this.#terminationReason;
  }

  isTerminated(): boolean {
    return this.#state === "terminated";
  }

  terminate(reason: TerminationReason): void {
    this.#state = "terminated";
    this.#terminationReason = reason;
    this.#addStep("terminated");
  }

  transition(newState: ExecutionState): void {
    if (this.isTerminated()) {
      return;
    }
    this.#state = newState;
    this.#addStep(newState);
  }

  checkMaxSteps(): boolean {
    if (!this.#options.maxSteps) return false;
    const stepCount = this.#steps.filter(s => s.state !== "idle" && s.state !== "terminated" && s.state !== "committing" && s.state !== "waiting_result" && s.state !== "verifying").length;
    const count = this.#steps.length;
    if (count >= this.#options.maxSteps) {
      this.terminate("max_steps");
      return true;
    }
    return false;
  }

  checkLoop(key: string): boolean {
    if (!this.#options.loopDetectionEnabled || !this.#options.maxRepeat) return false;
    const count = (this.#repeatCounts.get(key) ?? 0) + 1;
    this.#repeatCounts.set(key, count);
    if (count > this.#options.maxRepeat) {
      this.terminate("loop_detected");
      return true;
    }
    return false;
  }

  updateLastKey(key: string): void {
    this.#lastKey = key;
  }

  #addStep(state: ExecutionState): void {
    this.#steps.push({
      id: randomUUID(),
      state,
      timestamp: Date.now()
    });
  }
}
