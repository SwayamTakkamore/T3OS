export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [command = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  if (command.startsWith("--")) {
    const body = command.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      flags[body.slice(0, eq)] = body.slice(eq + 1);
    } else {
      flags[body] = true;
    }
  } else if (command.startsWith("-") && command.length > 1) {
    flags[command.slice(1)] = true;
  }

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      const body = token.slice(2);
      const eq = body.indexOf("=");
      if (eq >= 0) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith("-")) {
          flags[body] = next;
          i += 1;
        } else {
          flags[body] = true;
        }
      }
    } else if (token.startsWith("-") && token.length > 1) {
      flags[token.slice(1)] = true;
    } else {
      positionals.push(token);
    }
  }

  return { command, positionals, flags };
}
