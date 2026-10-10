import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import type { McpTransport } from "./client.js";

export interface StdioTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export class StdioTransport implements McpTransport {
  readonly #options: StdioTransportOptions;
  #child: ChildProcessWithoutNullStreams | undefined;
  #buffer = "";
  #closed = false;

  constructor(options: StdioTransportOptions) {
    this.#options = options;
  }

  start(handlers: { onLine: (line: string) => void; onClose: (error?: Error) => void }): void {
    const child = spawn(this.#options.command, this.#options.args ?? [], {
      cwd: this.#options.cwd,
      env: { ...process.env, ...this.#options.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      let index = this.#buffer.indexOf("\n");
      while (index !== -1) {
        const line = this.#buffer.slice(0, index);
        this.#buffer = this.#buffer.slice(index + 1);
        if (line.trim() !== "") handlers.onLine(line);
        index = this.#buffer.indexOf("\n");
      }
    });

    child.on("error", (error) => handlers.onClose(error as Error));
    child.on("close", () => handlers.onClose());
  }

  send(line: string): void {
    this.#child?.stdin.write(line);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const child = this.#child;
    if (!child) return;
    child.stdin.end();
    child.kill();
  }
}
