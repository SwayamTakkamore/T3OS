# T3OS

An open-source, native desktop agent harness for open-weight models. Gemma-first,
backed by HuggingFace (hosted or local), with an Ink terminal UI and a Tauri
desktop shell over one shared core engine.

## Requirements

- Node.js >= 20
- pnpm >= 9
- (optional) Rust + Tauri v2 toolchain for the desktop app
- (optional) a `secret-tool`-compatible keyring for stored tokens

## Install

```bash
pnpm install
pnpm build
```


## Run

```bash
export HF_TOKEN=hf_...          # or: pnpm --filter @t3os/cli exec t3os auth set <token>
node packages/cli/dist/bin.js run "summarize README.md"
node packages/tui/dist/bin.js    # interactive terminal UI
node packages/server/dist/bin.js # HTTP + WebSocket server on :8787
```

Package binaries after `pnpm build`:

| Binary | Package | Purpose |
| --- | --- | --- |
| `t3os` | `@t3os/cli` | one-shot runs and config/auth |
| `t3os-tui` | `@t3os/tui` | interactive terminal UI |
| `t3os-serve` | `@t3os/server` | HTTP + WebSocket API |

The desktop shell (`@t3os/desktop`) is a thin client of `t3os-serve`:

```bash
T3OS_API_URL=http://127.0.0.1:8787 pnpm --filter @t3os/desktop tauri dev
```

## Test

```bash
pnpm test
```

## License

MIT
