#!/usr/bin/env node
import { homedir } from "node:os";
import { runCli } from "./index.js";

const code = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  homeDir: homedir(),
  env: process.env,
  out: (line) => console.log(line),
  err: (line) => console.error(line),
});

process.exit(code);
