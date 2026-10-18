import type { IVerificationInterface, StepVerifier, TaskVerifier, VerificationResult, HookContext, ToolExecutionResult, HarnessState } from "./types.js";

export class VerificationInterface implements IVerificationInterface {
  #stepVerifiers: StepVerifier[] = [];
  #taskVerifiers: TaskVerifier[] = [];

  addStepVerifier(verifier: StepVerifier): void {
    this.#stepVerifiers.push(verifier);
  }

  removeStepVerifier(verifier: StepVerifier): void {
    const idx = this.#stepVerifiers.indexOf(verifier);
    if (idx !== -1) {
      this.#stepVerifiers.splice(idx, 1);
    }
  }

  addTaskVerifier(verifier: TaskVerifier): void {
    this.#taskVerifiers.push(verifier);
  }

  removeTaskVerifier(verifier: TaskVerifier): void {
    const idx = this.#taskVerifiers.indexOf(verifier);
    if (idx !== -1) {
      this.#taskVerifiers.splice(idx, 1);
    }
  }

  clear(): void {
    this.#stepVerifiers = [];
    this.#taskVerifiers = [];
  }

  async verifyStep(ctx: HookContext, result?: ToolExecutionResult): Promise<VerificationResult> {
    let overall: VerificationResult = { valid: true };
    for (const v of this.#stepVerifiers) {
      const r = await v(ctx, result);
      if (!r.valid) {
        return r;
      }
      if (r.score !== undefined && overall.score === undefined) {
        overall.score = r.score;
      }
    }
    return overall;
  }

  async verifyTask(ctx: HookContext, finalState: HarnessState): Promise<VerificationResult> {
    let overall: VerificationResult = { valid: true };
    for (const v of this.#taskVerifiers) {
      const r = await v(ctx, finalState);
      if (!r.valid) {
        return r;
      }
      if (r.score !== undefined) {
        overall.score = (overall.score ?? 0) + r.score;
      }
    }
    return overall;
  }
}
