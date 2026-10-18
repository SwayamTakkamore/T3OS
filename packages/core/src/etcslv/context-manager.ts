import type { IContextManager, ContextWindow, CompactionStrategy, TokenBudget } from "./types.js";

export class ContextManager implements IContextManager {
  #messages: Array<{ role: string; content: string }> = [];
  #systemPrompt: string | undefined;
  #tokenBudget: TokenBudget = { maxTokens: 8192 };

  getWindow(): ContextWindow {
    const messages = [...this.#messages];
    if (this.#systemPrompt) {
      messages.unshift({ role: "system", content: this.#systemPrompt });
    }
    const totalTokens = messages.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
    return {
      messages,
      totalTokens,
      systemPromptIncluded: !!this.#systemPrompt
    };
  }

  setSystemPrompt(prompt: string): void {
    this.#systemPrompt = prompt;
  }

  addMessage(message: { role: string; content: string }): void {
    this.#messages.push(message);
    this.#checkBudget();
  }

  addMessages(messages: Array<{ role: string; content: string }>): void {
    for (const m of messages) {
      this.#messages.push(m);
    }
    this.#checkBudget();
  }

  clear(): void {
    this.#messages = [];
  }

  compact(strategy: CompactionStrategy = "sliding_window"): void {
    if (this.#messages.length === 0) return;
    switch (strategy) {
      case "truncate":
        this.#messages = this.#messages.slice(-10);
        break;
      case "sliding_window":
        this.#messages = this.#messages.slice(-20);
        break;
      case "summarize":
        // Simple summarization - keep last few messages
        this.#messages = this.#messages.slice(-5);
        break;
      case "none":
        break;
    }
  }

  estimateTokens(text: string): number {
    // Rough estimate: ~1 token per 4 chars for English
    return Math.ceil(text.length / 4);
  }

  getTokenBudget(): TokenBudget {
    return { ...this.#tokenBudget };
  }

  setTokenBudget(budget: TokenBudget): void {
    this.#tokenBudget = { ...budget };
  }

  #checkBudget(): void {
    const window = this.getWindow();
    if (this.#tokenBudget.maxTokens > 0 && window.totalTokens > this.#tokenBudget.maxTokens) {
      this.compact("sliding_window");
    }
  }
}
