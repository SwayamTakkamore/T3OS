import type { ToolSchema } from "../types.js";

export type ExecutionState =
  | "idle"
  | "observing"
  | "thinking"
  | "tool_dispatch"
  | "waiting_result"
  | "verifying"
  | "committing"
  | "terminated";

export type TerminationReason =
  | "complete"
  | "max_steps"
  | "loop_detected"
  | "verification_failed"
  | "error"
  | "cancelled";

export interface ExecutionStep {
  id: string;
  state: ExecutionState;
  timestamp: number;
  metadata?: unknown;
}

export interface LoopOptions {
  maxSteps?: number;
  maxRepeat?: number;
  loopDetectionEnabled?: boolean;
  timeout?: number;
}

export interface IExecutionLoop {
  start(): void;
  stop(): void;
  reset(): void;
  getState(): ExecutionState;
  getSteps(): ExecutionStep[];
  getCurrentStep(): ExecutionStep | undefined;
  getTerminationReason(): TerminationReason | undefined;
  isTerminated(): boolean;
  cancel(): void;
}

export interface ToolDefinition {
  schema: ToolSchema;
  class: "read" | "write" | "execute";
  permission?: "allow" | "ask" | "deny";
  run(args: unknown, ctx: unknown): Promise<ToolExecutionResult>;
}

export interface ToolExecutionResult {
  ok: boolean;
  content: string;
  data?: unknown;
  error?: string;
}

export interface IToolRegistry {
  register(tool: ToolDefinition): void;
  unregister(name: string): void;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  has(name: string): boolean;
  discover(query?: string): ToolDefinition[];
  validate(name: string, args: unknown): { valid: boolean; errors?: string[] };
  execute(name: string, args: unknown, ctx: unknown): Promise<ToolExecutionResult>;
}

export type CompactionStrategy = "truncate" | "summarize" | "sliding_window" | "none";

export interface TokenBudget {
  maxTokens: number;
  warningThreshold?: number;
}

export interface ContextWindow {
  messages: Array<{ role: string; content: string }>;
  totalTokens: number;
  systemPromptIncluded: boolean;
}

export interface IContextManager {
  getWindow(): ContextWindow;
  setSystemPrompt(prompt: string): void;
  addMessage(message: { role: string; content: string }): void;
  addMessages(messages: Array<{ role: string; content: string }>): void;
  clear(): void;
  compact(strategy?: CompactionStrategy): void;
  estimateTokens(text: string): number;
  getTokenBudget(): TokenBudget;
  setTokenBudget(budget: TokenBudget): void;
}

export interface Checkpoint {
  id: string;
  timestamp: number;
  state: HarnessState;
}

export interface TrajectoryEntry {
  id: string;
  step: number;
  timestamp: number;
  type: "thought" | "tool_call" | "tool_result" | "verification" | "state_change";
  data: unknown;
}

export interface HarnessState {
  version: number;
  executionState: ExecutionState;
  messages: Array<{ role: string; content: string; toolCallId?: string; name?: string; toolCalls?: any[] }>;
  variables: Record<string, unknown>;
  trajectory: TrajectoryEntry[];
  currentStep: number;
}

export interface IHarnessStateStore {
  getState(): HarnessState;
  setState(state: Partial<HarnessState>): void;
  saveCheckpoint(name?: string): Checkpoint;
  loadCheckpoint(id: string): void;
  listCheckpoints(): Checkpoint[];
  deleteCheckpoint(id: string): void;
  clearCheckpoints(): void;
  appendTrajectory(entry: Omit<TrajectoryEntry, "id" | "timestamp">): void;
  getTrajectory(): TrajectoryEntry[];
  setVariable(key: string, value: unknown): void;
  getVariable(key: string): unknown;
  deleteVariable(key: string): void;
  clear(): void;
  mergeState(patch: Partial<HarnessState>): void;
  restoreState(state: HarnessState): void;
}

export interface HookContext {
  executionState: ExecutionState;
  currentStep: number;
  messageHistory: Array<{ role: string; content: string }>;
  metadata?: unknown;
}

export interface PreToolCallResult {
  proceed: boolean;
  modifiedArgs?: unknown;
  reason?: string;
}

export interface LifecycleHookMap {
  onTurnStart?: (ctx: HookContext) => Promise<void> | void;
  preModelInvoke?: (ctx: HookContext) => Promise<void> | void;
  postModelInvoke?: (ctx: HookContext) => Promise<void> | void;
  preToolCall?: (ctx: HookContext, toolName: string, args: unknown) => Promise<PreToolCallResult> | PreToolCallResult;
  postToolCall?: (ctx: HookContext, toolName: string, args: unknown, result: ToolExecutionResult) => Promise<void> | void;
  onStepEnd?: (ctx: HookContext) => Promise<void> | void;
  onError?: (ctx: HookContext, error: unknown) => Promise<void> | void;
  onTurnEnd?: (ctx: HookContext) => Promise<void> | void;
}

export interface ILifecycleHooks {
  register(name: keyof LifecycleHookMap, handler: NonNullable<LifecycleHookMap[typeof name]>): void;
  unregister(name: keyof LifecycleHookMap, handler: NonNullable<LifecycleHookMap[typeof name]>): void;
  clear(): void;
  trigger<K extends keyof LifecycleHookMap>(name: K, ...args: Parameters<NonNullable<LifecycleHookMap[K]>>): Promise<void>;
}

export interface VerificationResult {
  valid: boolean;
  feedback?: string;
  score?: number;
  errors?: string[];
}

export type StepVerifier = (ctx: HookContext, result?: ToolExecutionResult) => Promise<VerificationResult> | VerificationResult;
export type TaskVerifier = (ctx: HookContext, finalState: HarnessState) => Promise<VerificationResult> | VerificationResult;

export interface IVerificationInterface {
  addStepVerifier(verifier: StepVerifier): void;
  removeStepVerifier(verifier: StepVerifier): void;
  addTaskVerifier(verifier: TaskVerifier): void;
  removeTaskVerifier(verifier: TaskVerifier): void;
  clear(): void;
  verifyStep(ctx: HookContext, result?: ToolExecutionResult): Promise<VerificationResult>;
  verifyTask(ctx: HookContext, finalState: HarnessState): Promise<VerificationResult>;
}

export interface AgentHarnessConfig {
  executionLoop: IExecutionLoop;
  toolRegistry: IToolRegistry;
  contextManager: IContextManager;
  stateStore: IHarnessStateStore;
  lifecycleHooks: ILifecycleHooks;
  verificationInterface: IVerificationInterface;
  loopOptions?: LoopOptions;
}

export interface HarnessTurnOptions {
  input?: string;
  tools?: string[];
  maxSteps?: number;
  stream?: boolean;
  abortSignal?: AbortSignal;
}

export interface HarnessTurnResult {
  completed: boolean;
  terminationReason: TerminationReason;
  finalState: HarnessState;
  output?: string;
  steps: number;
  trajectory: TrajectoryEntry[];
}

export interface IAgentHarness {
  runTurn(opts?: HarnessTurnOptions): Promise<HarnessTurnResult>;
  streamTurn(opts?: HarnessTurnOptions): AsyncIterable<{ type: string; data: unknown }>;
  getState(): HarnessState;
  reset(): void;
  cancel(): void;
}
