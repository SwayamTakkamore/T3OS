# Smoke test

A manual pass that proves the real, non-mocked path works end to end.

## 1. Build and unit tests

```bash
pnpm install
pnpm build
pnpm test
```

Expected: every package builds; the whole suite is green, including
`packages/core/test/integration/golden.test.ts` and `packages/server/test/e2e.test.ts`.

## 2. Credentials

```bash
node packages/cli/dist/bin.js auth set <hf-token>
node packages/cli/dist/bin.js auth status
```

Expected: `auth status` prints `HF_TOKEN: configured` and never echoes the token.

## 3. Hosted model, one-shot run

```bash
node packages/cli/dist/bin.js run "read package.json and summarize the workspace"
```

Expected: streaming assistant text; `[tool] ...` lines for read/list/glob/grep;
`[turn_end: complete]`.

## 4. Permission modes

```bash
node packages/cli/dist/bin.js run --permission read-only "write a file called x.txt"
```

Expected: the write tool is denied; the model reports it cannot write;
`[turn_end: complete]`.

## 5. Terminal UI

```bash
node packages/tui/dist/bin.js
```

Expected: an interactive prompt; assistant text streams in; tool calls show as
yellow `⚙ name [ok]` lines; Ctrl+C exits.

## 6. Server + desktop shell

Terminal A:

```bash
node packages/server/dist/bin.js
# t3os server listening on http://127.0.0.1:8787
```

Terminal B:

```bash
curl -s http://127.0.0.1:8787/health
# {"ok":true}
T3OS_API_URL=http://127.0.0.1:8787 pnpm --filter @t3os/desktop tauri dev
```

Expected: the desktop window opens, a prompt runs a turn, and the transcript
streams the same events as the TUI.

## 7. Local model (optional)

```bash
node packages/cli/dist/bin.js run --provider local --model google/gemma-2-2b-it "hello"
```

Expected: the first run downloads weights, then streams text. Tool-calling is
unavailable locally (`capabilities().toolCalling === false`).
