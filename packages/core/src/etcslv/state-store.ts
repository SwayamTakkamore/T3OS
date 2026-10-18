import type { IHarnessStateStore, HarnessState, Checkpoint, TrajectoryEntry } from "./types.js";
import { randomUUID } from "node:crypto";

export class HarnessStateStore implements IHarnessStateStore {
  #state: HarnessState = {
    version: 1,
    executionState: "idle",
    messages: [],
    variables: {},
    trajectory: [],
    currentStep: 0
  };
  #checkpoints: Checkpoint[] = [];

  getState(): HarnessState {
    return JSON.parse(JSON.stringify(this.#state));
  }

  setState(state: Partial<HarnessState>): void {
    this.#state = { ...this.#state, ...state };
  }

  saveCheckpoint(name?: string): Checkpoint {
    const checkpoint: Checkpoint = {
      id: randomUUID(),
      timestamp: Date.now(),
      state: this.getState()
    };
    if (name) {
      (checkpoint as any).name = name;
    }
    this.#checkpoints.push(checkpoint);
    return checkpoint;
  }

  loadCheckpoint(id: string): void {
    const cp = this.#checkpoints.find(c => c.id === id);
    if (cp) {
      this.#state = JSON.parse(JSON.stringify(cp.state));
    }
  }

  listCheckpoints(): Checkpoint[] {
    return [...this.#checkpoints];
  }

  deleteCheckpoint(id: string): void {
    this.#checkpoints = this.#checkpoints.filter(c => c.id !== id);
  }

  clearCheckpoints(): void {
    this.#checkpoints = [];
  }

  appendTrajectory(entry: Omit<TrajectoryEntry, "id" | "timestamp">): void {
    this.#state.trajectory.push({
      ...entry,
      id: randomUUID(),
      timestamp: Date.now()
    });
    this.#state.currentStep = this.#state.trajectory.length;
  }

  getTrajectory(): TrajectoryEntry[] {
    return [...this.#state.trajectory];
  }

  setVariable(key: string, value: unknown): void {
    this.#state.variables[key] = value;
  }

  getVariable(key: string): unknown {
    return this.#state.variables[key];
  }

  deleteVariable(key: string): void {
    delete this.#state.variables[key];
  }

  clear(): void {
    this.#state = {
      version: 1,
      executionState: "idle",
      messages: [],
      variables: {},
      trajectory: [],
      currentStep: 0
    };
  }

  mergeState(patch: Partial<HarnessState>): void {
    this.#state = {
      ...this.#state,
      ...patch,
      variables: { ...this.#state.variables, ...(patch.variables || {}) },
      messages: patch.messages !== undefined ? patch.messages : this.#state.messages,
      trajectory: patch.trajectory !== undefined ? patch.trajectory : this.#state.trajectory
    };
  }

  restoreState(state: HarnessState): void {
    this.#state = JSON.parse(JSON.stringify(state));
  }
}
