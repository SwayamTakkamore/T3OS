import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface Keyring {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
}

function getCredentialsPath(): string {
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "t3os", "credentials.json");
}

async function readCredentialsFile(): Promise<Record<string, string>> {
  try {
    const raw = await readFile(getCredentialsPath(), "utf8");
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

async function writeCredentialsFile(name: string, value: string): Promise<void> {
  const credPath = getCredentialsPath();
  await mkdir(dirname(credPath), { recursive: true, mode: 0o700 });
  const current = await readCredentialsFile();
  current[name] = value;
  await writeFile(credPath, `${JSON.stringify(current, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export const systemKeyring: Keyring = {
  async get(name) {
    try {
      const { stdout } = await run("secret-tool", ["lookup", "service", "t3os", "key", name]);
      const value = stdout.trim();
      if (value.length > 0) return value;
    } catch {
      // Fall through to fallback file
    }

    const creds = await readCredentialsFile();
    return creds[name];
  },
  async set(name, value) {
    try {
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
      return;
    } catch {
      // When secret-tool is missing (ENOENT) or fails, fallback to ~/.config/t3os/credentials.json
      await writeCredentialsFile(name, value);
    }
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
  keyring?: Keyring | undefined;
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
