import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Keyring {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
}

export const systemKeyring: Keyring = {
  async get(name) {
    try {
      const { stdout } = await run("secret-tool", ["lookup", "service", "t3os", "key", name]);
      const value = stdout.trim();
      return value.length > 0 ? value : undefined;
    } catch {
      return undefined;
    }
  },
  async set(name, value) {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "secret-tool",
        ["store", "--label", `T3OS ${name}`, "service", "t3os", "key", name]
      ) as ChildProcessWithoutNullStreams;
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`secret-tool store exited with code ${code}`));
      });
      child.stdin.write(value);
      child.stdin.end();
    });
  }
};

export class SecretRef {
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
}

export interface SecretResolverOptions {
  env: NodeJS.ProcessEnv;
  keyring?: Keyring;
}

export class SecretResolver {
  readonly #env: NodeJS.ProcessEnv;
  readonly #keyring: Keyring;

  constructor(opts: SecretResolverOptions) {
    this.#env = opts.env;
    this.#keyring = opts.keyring ?? systemKeyring;
  }

  async resolve(ref: SecretRef): Promise<string | undefined> {
    const fromKeyring = await this.#keyring.get(ref.name);
    if (fromKeyring) return fromKeyring;
    const fromEnv = this.#env[ref.name];
    return fromEnv && fromEnv.length > 0 ? fromEnv : undefined;
  }
}