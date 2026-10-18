import { join, sep } from "node:path";
import { homedir } from "node:os";
import { resolveLocalModelId, resolvePreset, type ModelPreset } from "../presets/index.js";
import type { Delta, Message, ToolSchema } from "../types.js";
import { checkLocalModelInstalled, ensureFlatCacheLink } from "./localModel.js";
import type { Provider, ProviderCapabilities, StreamOptions } from "./types.js";

export type GenerateFn = (
  prompt: string,
  opts: { maxTokens: number; temperature: number; stopTokens: string[] }
) => AsyncIterable<string>;

/**
 * Worked tool invocations for the few-shot action example, in preference
 * order. Only an example whose tool is actually available may be shown — an
 * example naming a missing tool teaches the model to call it.
 */
const ACTION_EXAMPLES: ReadonlyArray<{ name: string; request: string; args: unknown }> = [
  {
    name: "write_file",
    request: "create index.html with a hello world page",
    args: { path: "index.html", content: "<h1>Hello, world!</h1>" }
  },
  { name: "list_dir", request: "list the files in this folder", args: { path: "." } },
  { name: "read_file", request: "show me package.json", args: { path: "package.json" } },
  { name: "run_shell", request: "run the tests", args: { command: "npm test" } }
];

function actionExample(tools: ToolSchema[]): { name: string; request: string; args: unknown } {
  const known = ACTION_EXAMPLES.find((example) => tools.some((tool) => tool.name === example.name));
  if (known) return known;
  const [first] = tools;
  return { name: first?.name ?? "<tool_name>", request: first?.description ?? "", args: {} };
}

/**
 * Renders the instruction block that teaches a local (non-tool-calling-API)
 * model how to invoke tools: the available tools, the fenced JSON block
 * format `streamChat` scans the generation for, when to use a tool at all,
 * and a greeting/action pair of concrete examples of that choice.
 *
 * The no-tools-for-greetings rule must stay the final line: small models weigh
 * the most recent instruction heaviest, and without it they answer "hi" with a
 * tool call.
 */
function renderToolInstructions(tools: ToolSchema[]): string {
  const lines: string[] = ["You have access to the following tools:"];
  for (const tool of tools) {
    lines.push(`- ${tool.name}: ${tool.description}`);
    lines.push(`  parameters (JSON schema): ${JSON.stringify(tool.parameters)}`);
  }
  lines.push("");
  lines.push("To invoke a tool, output a fenced JSON code block exactly like this:");
  lines.push("```json");
  lines.push('{ "name": "<tool_name>", "arguments": { ... } }');
  lines.push("```");
  lines.push(
    "Use the tool's name from the list above and \"arguments\" matching its parameters. " +
      "Invoke at most one tool per turn, then stop generating."
  );
  lines.push(
    "Never tell the user to manually save or edit files when you can invoke a tool " +
      "directly — call the tool instead."
  );
  lines.push("");
  lines.push("Decide whether to use a tool by what the request needs:");
  lines.push(
    "- When answering requires inspecting files, creating or editing files, exploring " +
      "directories, searching code, or executing shell commands, invoke the appropriate " +
      "tool directly."
  );
  lines.push(
    '- For greetings (e.g. "h", "hi", "hello", "hey"), casual chat, general questions, or ' +
      "explanations that do not require workspace access, respond conversationally in " +
      "plain text. Do NOT invoke any tools."
  );
  lines.push("");
  const example = actionExample(tools);
  lines.push("Examples:");
  lines.push('- The user says "hi". Reply in plain text, with no tool call:');
  lines.push("  Hi! How can I help you today?");
  lines.push(`- The user says "${example.request}". Reply with only the tool call:`);
  lines.push("```json");
  lines.push(JSON.stringify({ name: example.name, arguments: example.args }));
  lines.push("```");
  lines.push("");
  lines.push("Do NOT invoke tools for casual greetings or general conversation.");
  return lines.join("\n");
}

/**
 * Renders a single message's body. Tool results become `[Tool Result for
 * <name>]: <output>` (rendered as a user turn by the caller), and an
 * assistant turn that previously invoked tools re-renders those invocations
 * in the same fenced JSON format the model is asked to produce.
 */
function renderMessageBody(message: Message): string {
  if (message.role === "tool") {
    const name = message.name ?? message.toolCallId ?? "tool";
    return `[Tool Result for ${name}]: ${message.content}`;
  }
  if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
    const blocks = message.toolCalls.map(
      (call) => "```json\n" + JSON.stringify({ name: call.name, arguments: call.args }) + "\n```"
    );
    const parts = message.content ? [message.content, ...blocks] : blocks;
    return parts.join("\n");
  }
  return message.content;
}

/** Maps a message role onto the role label the chat template expects. */
function turnRole(message: Message, template: "gemma" | "generic"): string {
  if (message.role === "tool") return "user";
  if (message.role === "assistant" && template === "gemma") return "model";
  return message.role;
}

/** A rendered chat turn: the template's role label and the turn's text. */
interface Turn {
  role: string;
  body: string;
}

/**
 * Collapses each run of same-role turns into a single turn. Histories
 * routinely contain such runs — several tool results in a row, a tool result
 * followed by the next user prompt, or assistant text followed by a separate
 * tool-call message — but Gemma is trained only on strictly alternating
 * user/model turns and loses track of whose turn it is otherwise.
 */
function mergeConsecutiveTurns(turns: Turn[]): Turn[] {
  const merged: Turn[] = [];
  for (const turn of turns) {
    const last = merged.at(-1);
    if (last && last.role === turn.role) {
      last.body = [last.body, turn.body].filter((body) => body.length > 0).join("\n\n");
    } else {
      merged.push({ ...turn });
    }
  }
  return merged;
}

export function renderPrompt(
  messages: Message[],
  preset: ModelPreset,
  tools?: ToolSchema[]
): string {
  const template = preset.chatTemplate;
  const toolInstructions =
    tools && tools.length > 0 ? renderToolInstructions(tools) : undefined;
  // A prompt must never open with a bare model turn: Gemma 3 degenerates into
  // a repetition loop when it starts generating with zero user context, so an
  // empty history gets a placeholder user turn instead.
  const safe =
    messages.length > 0
      ? messages
      : [{ role: "user" as const, content: "" }];

  const turns = mergeConsecutiveTurns(
    safe.map((message) => ({ role: turnRole(message, template), body: renderMessageBody(message) }))
  );
  // Tool instructions ride inside the first user turn rather than a turn of
  // their own, which would otherwise sit back-to-back with that user turn.
  if (toolInstructions !== undefined) {
    const firstUser = turns.find((turn) => turn.role === "user");
    if (firstUser) {
      firstUser.body =
        firstUser.body.length > 0
          ? `${toolInstructions}\n\n---\n\n${firstUser.body}`
          : toolInstructions;
    } else {
      turns.unshift({ role: "user", body: toolInstructions });
    }
  }

  if (template === "gemma") {
    return (
      turns.map((turn) => `<start_of_turn>${turn.role}\n${turn.body}<end_of_turn>\n`).join("") +
      "<start_of_turn>model\n"
    );
  }
  return turns.map((turn) => `${turn.role}: ${turn.body}`).join("\n") + "\nassistant:";
}

/**
 * Words that mark a message as asking for workspace work: action verbs and
 * shell commands, plus nouns naming workspace things a reply would have to
 * inspect. Matched against simple inflections too ("creating", "files").
 */
const ACTION_WORDS = new Set([
  "create", "make", "build", "write", "edit", "modify", "update", "change", "fix", "patch",
  "delete", "remove", "rename", "move", "copy", "add", "append", "insert", "replace",
  "refactor", "implement", "scaffold", "generate", "save", "run", "execute", "install",
  "uninstall", "compile", "test", "lint", "format", "debug", "deploy", "list", "read", "open",
  "show", "print", "check", "find", "search", "inspect", "view", "explore", "scan", "analyze",
  "analyse", "review", "summarize", "summarise", "diff", "commit", "push", "pull", "clone",
  "download", "fetch", "init", "setup",
  "ls", "cat", "rm", "mv", "cp", "mkdir", "touch", "cd", "pwd", "grep", "glob", "exec", "git",
  "npm", "pnpm", "yarn", "npx", "pip", "cargo",
  "file", "folder", "directory", "dir", "repo", "repository", "project", "codebase",
  "workspace", "code", "script", "readme", "makefile", "dockerfile", "terminal", "shell",
  "command"
]);

/** Base forms a token may be an inflection of: "creating" → "create", "copied" → "copy". */
function wordStems(token: string): string[] {
  const stems = [token];
  for (const suffix of ["ing", "ied", "ies", "ed", "es", "s", "d"]) {
    if (token.length <= suffix.length + 1 || !token.endsWith(suffix)) continue;
    const stem = token.slice(0, -suffix.length);
    stems.push(stem, `${stem}e`);
    if (suffix.startsWith("i")) stems.push(`${stem}y`);
    if (stem.length > 2 && stem.at(-1) === stem.at(-2)) stems.push(stem.slice(0, -1));
  }
  return stems;
}

const FILE_EXTENSION_PATTERN =
  /(?:^|[^\w])[\w-]*\.(?:html?|css|s[ac]ss|less|[cm]?jsx?|tsx?|json|mdx?|txt|py|rs|go|java|kt|swift|c|h|cpp|hpp|cs|rb|php|sh|bash|zsh|ya?ml|toml|ini|cfg|conf|env|lock|xml|svg|png|jpe?g|gif|sql|csv|log|vue|svelte|lua|dart|gitignore)\b/i;

/** Path separators, file names, or inline code — references to the workspace. */
function hasPathSyntax(text: string): boolean {
  return /[\w.~-]*[/\\][\w.-]/.test(text) || FILE_EXTENSION_PATTERN.test(text) || /`[^`]+`/.test(text);
}

/** Greetings, thanks, farewells, and reactions, tolerating elongation ("hiii", "heyyy"). */
const CONVERSATIONAL_TOKEN_PATTERN =
  /^(?:h+|h+i+|he+y+a*|hel+o+|hiy+a+|yo+|sup|howdy|hola|greetings|gm|gn|morning|evening|afternoon|th[ae]nks*|thank|thankyou|thx|ty|tysm|cheers|bye+|goodbye|cya|lol|lmao|ha(?:ha)+|he(?:he)+|cool|nice|wow|awesome|great|amazing|sweet)$/;

const CONVERSATIONAL_PHRASES = [
  "how are you", "how are u", "how r you", "how r u", "how's it going", "hows it going",
  "how is it going", "how do you do", "what's up", "whats up", "wassup", "who are you",
  "what are you", "what's your name", "whats your name", "nice to meet you", "good job",
  "well done", "see you", "good night"
];

/**
 * Decides whether a turn should be offered tools at all. Small local models
 * are strongly attracted to tool schemas in the prompt: a 4B model answers
 * "hi" with an `edit_file` call despite instructions not to. So a latest user
 * message that is recognisably conversational and shows no sign of wanting
 * workspace work gets no tools. Anything unrecognised keeps them, and so does
 * a turn in the middle of a tool loop.
 */
export function shouldProvideTools(messages: Message[], tools: ToolSchema[]): boolean {
  if (tools.length === 0) return false;
  const last = messages.at(-1);
  if (last?.role === "tool") return true;
  if (last?.role === "assistant" && (last.toolCalls?.length ?? 0) > 0) return true;

  let latestUser: Message | undefined;
  for (let i = messages.length - 1; i >= 0 && !latestUser; i--) {
    if (messages[i]?.role === "user") latestUser = messages[i];
  }
  if (!latestUser) return true;
  const text = latestUser.content.toLowerCase().replace(/[\u2018\u2019]/g, "'");
  if (hasPathSyntax(text)) return true;

  const tokens = text
    .split(/[^a-z0-9']+/)
    .map((token) => token.replace(/^'+|'+$/g, ""))
    .filter((token) => token.length > 0);
  if (tokens.some((token) => wordStems(token).some((stem) => ACTION_WORDS.has(stem)))) return true;

  const phrase = ` ${tokens.join(" ")} `;
  const conversational =
    tokens.some((token) => CONVERSATIONAL_TOKEN_PATTERN.test(token)) ||
    CONVERSATIONAL_PHRASES.some((candidate) => phrase.includes(` ${candidate} `));
  return !conversational;
}

/** The fence marker the model is instructed to wrap tool invocations in. */
const TOOL_FENCE = "```json";

let toolCallSeq = 0;

function nextToolCallId(): string {
  toolCallSeq += 1;
  return `local-${Date.now().toString(36)}-${toolCallSeq}`;
}

/**
 * Recognises a tool invocation inside a fenced JSON block. Returns undefined
 * when the payload is not valid JSON, lacks `name`/`arguments`, or names a
 * tool that is not in the provided schema list — such blocks are plain text.
 */
function parseToolCall(
  jsonText: string,
  tools: ToolSchema[]
): { name: string; args: unknown } | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText.trim());
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const name = record.name;
  if (typeof name !== "string" || !tools.some((tool) => tool.name === name)) return undefined;
  if (!("arguments" in record)) return undefined;
  let args = record.arguments;
  // Some models double-encode arguments as a JSON string; unwrap it.
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      // keep the raw string
    }
  }
  return { name, args };
}

/**
 * Length of the longest suffix of `buffer` that is a proper prefix of the
 * fence marker — text that could still grow into a fence in the next chunk
 * and therefore must not be flushed as text yet.
 */
function partialFencePrefixLength(buffer: string): number {
  const max = Math.min(buffer.length, TOOL_FENCE.length - 1);
  for (let len = max; len > 0; len--) {
    if (buffer.endsWith(TOOL_FENCE.slice(0, len))) return len;
  }
  return 0;
}

/**
 * Incrementally scans generated text for a fenced JSON tool invocation.
 * Text before a matching block is flushed as `text` deltas; a matching block
 * becomes `tool_call_start`/`tool_call_delta`/`tool_call_end`. Blocks that do
 * not name an available tool pass through verbatim as text.
 */
class ToolCallScanner {
  readonly #tools: ToolSchema[];
  #buffer = "";
  #inFence = false;
  #resolved = false;

  constructor(tools: ToolSchema[]) {
    this.#tools = tools;
  }

  push(chunk: string): Delta[] {
    if (this.#resolved) return chunk ? [{ type: "text", text: chunk }] : [];
    this.#buffer += chunk;
    const out: Delta[] = [];
    for (;;) {
      if (!this.#inFence) {
        const start = this.#buffer.indexOf(TOOL_FENCE);
        if (start === -1) {
          // Hold back only text that could still become the start of a fence.
          const hold = partialFencePrefixLength(this.#buffer);
          const splitAt = this.#buffer.length - hold;
          const emitText = splitAt > 0 ? this.#buffer.slice(0, splitAt) : "";
          this.#buffer = hold > 0 ? this.#buffer.slice(splitAt) : "";
          if (emitText) out.push({ type: "text", text: emitText });
          return out;
        }
        const prefix = this.#buffer.slice(0, start);
        if (prefix) out.push({ type: "text", text: prefix });
        this.#buffer = this.#buffer.slice(start);
        this.#inFence = true;
        continue;
      }
      // Inside a fence: `buffer` starts with TOOL_FENCE.
      const body = this.#buffer.slice(TOOL_FENCE.length);
      const close = body.indexOf("```");
      if (close === -1) return out; // wait for more of the block
      const call = parseToolCall(body.slice(0, close), this.#tools);
      if (call) {
        const id = nextToolCallId();
        out.push({ type: "tool_call_start", id, name: call.name });
        out.push({
          type: "tool_call_delta",
          id,
          argsJsonDelta: JSON.stringify(call.args ?? {})
        });
        out.push({ type: "tool_call_end", id });
        this.#resolved = true;
        const trailing = body.slice(close + 3);
        this.#buffer = "";
        this.#inFence = false;
        if (trailing) out.push({ type: "text", text: trailing });
        return out;
      }
      // Not a tool call — emit the fenced block verbatim and keep scanning.
      out.push({ type: "text", text: TOOL_FENCE + body.slice(0, close + 3) });
      this.#buffer = body.slice(close + 3);
      this.#inFence = false;
    }
  }

  flush(): Delta[] {
    const out: Delta[] = [];
    if (this.#inFence) {
      // Unterminated fence at end of stream: accept it if it already parses
      // as a valid tool invocation (generation can be cut short by a stop
      // token), otherwise fall through and emit it as text.
      const call = parseToolCall(this.#buffer.slice(TOOL_FENCE.length), this.#tools);
      if (call) {
        const id = nextToolCallId();
        out.push({ type: "tool_call_start", id, name: call.name });
        out.push({
          type: "tool_call_delta",
          id,
          argsJsonDelta: JSON.stringify(call.args ?? {})
        });
        out.push({ type: "tool_call_end", id });
        this.#resolved = true;
      }
    }
    if (!this.#resolved && this.#buffer) out.push({ type: "text", text: this.#buffer });
    this.#buffer = "";
    this.#inFence = false;
    return out;
  }
}

interface StreamerLike {
  put(value: unknown): void;
  end(): void;
}

type TextGenerator = (
  prompt: string,
  opts: {
    max_new_tokens: number;
    temperature: number;
    do_sample: boolean;
    streamer: StreamerLike;
  }
) => Promise<unknown>;

export interface TransformersPipelineOptions {
  /** Directory `@huggingface/transformers` uses to cache (and read) model files. */
  cache_dir?: string;
  /**
   * Weight variant to load. T3OS downloads and verifies the Q4 quantized
   * build only; without this, Transformers.js defaults to fp32 and tries to
   * resolve `onnx/decoder_model_merged.onnx` — the unquantized 16 GB graph.
   */
  dtype?: string;
  /**
   * Skip the network entirely. Only set once the model files are verified
   * reachable in the local cache, so an installed model loads straight from
   * disk instead of re-downloading, while a missing model can still fetch.
   */
  local_files_only?: boolean;
}

export interface TransformersModule {
  pipeline(
    task: string,
    modelId: string,
    options?: TransformersPipelineOptions
  ): Promise<TextGenerator>;
  TextStreamer?: unknown;
}

export type TransformersLoader = () => Promise<TransformersModule>;

/** Errors that indicate a gated/private Hugging Face repo the caller lacks access to. */
const GATED_MODEL_PATTERN = /unauthorized|401|403|forbidden|gated|access denied/i;

/**
 * Errors that indicate the repo lacks ONNX weights. Transformers.js is an
 * ONNX runtime and resolves weights from the repo's `onnx/` subfolder, which
 * standard safetensors-only checkpoints do not provide.
 */
const MISSING_ONNX_PATTERN =
  /could not locate file.*\.onnx|entry not found.*\.onnx|404.*\.onnx|could not locate file:/i;

/**
 * Formats a model-loading failure. Gated repositories (e.g. Gemma) surface as
 * `Unauthorized`/401/403 responses; for those we add guidance for accepting the
 * license and configuring an access token. Missing ONNX weights (a raw
 * safetensors-only repo handed to Transformers.js) get guidance pointing at the
 * ONNX-converted repository instead.
 */
function formatModelLoadError(modelId: string, err: unknown): Error {
  const message = err instanceof Error ? err.message : String(err);
  const base = `Failed to load model ${modelId} for local inference: ${message}`;
  if (GATED_MODEL_PATTERN.test(message)) {
    return new Error(
      `${base}\n` +
        `${modelId} is a gated model on the Hugging Face Hub. Accept the license terms at ` +
        `https://huggingface.co/${modelId} and authenticate with an access token, then run ` +
        "`t3os auth login` (or `t3os auth set <token>`) to continue."
    );
  }
  if (MISSING_ONNX_PATTERN.test(message)) {
    const onnxRepo = resolveLocalModelId(modelId);
    const suggestion =
      onnxRepo !== modelId
        ? `Use the ONNX-converted repository "${onnxRepo}" instead, or verify that ` +
          `https://huggingface.co/${modelId} provides ONNX weights under its onnx/ folder.`
        : `Verify that https://huggingface.co/${modelId} provides ONNX weights under its ` +
          `onnx/ folder — Transformers.js cannot load safetensors-only checkpoints.`;
    return new Error(
      `${base}\n` +
        `Transformers.js runs models via ONNX and requires ONNX model files (e.g. ` +
        `onnx/embed_tokens_q4.onnx), which ${modelId} does not provide. ${suggestion}`
    );
  }
  return new Error(base);
}

interface CacheResolution {
  /** Directory handed to `@huggingface/transformers` as `cache_dir`, when known. */
  cacheDir?: string | undefined;
  /**
   * True when the model's files are verified reachable at the flat
   * `${cacheRoot}/${resolvedId}` path Transformers.js reads — the signal to
   * pass `local_files_only: true` so nothing is re-downloaded.
   */
  localFilesOnly: boolean;
}

/**
 * Resolves the cache directory handed to `@huggingface/transformers`. An
 * explicit `cacheDir` always wins; otherwise a model already present in the
 * local Hugging Face hub cache is used so loading works without a round trip.
 * Both the raw model ID and its ONNX-converted equivalent are checked, since
 * the pipeline loads the resolved ONNX repo's files.
 *
 * Before returning, the flat `${hubDir}/${resolvedId}` path that
 * `FileCache.resolve`s against `cache_dir` is linked to the installed
 * snapshot (`ensureFlatCacheLink`), and `localFilesOnly` is only reported
 * once that flat path holds a complete install — a legacy cache stored under
 * a different repo id still falls back to downloading rather than failing
 * offline.
 */
async function resolveCacheDir(
  modelId: string,
  explicitCacheDir?: string
): Promise<CacheResolution> {
  const resolvedId = resolveLocalModelId(modelId);
  const cacheRoot = explicitCacheDir ?? join(homedir(), ".cache", "huggingface", "hub");

  let installedPath: string | undefined;
  // The pipeline loads `resolvedId`, so prefer a cache it can actually read.
  for (const candidate of [resolvedId, modelId]) {
    const status = await checkLocalModelInstalled(candidate, explicitCacheDir);
    if (status.isInstalled) {
      installedPath = status.path;
      break;
    }
  }

  if (explicitCacheDir) {
    const localFilesOnly = installedPath
      ? await ensureFlatCacheLink(explicitCacheDir, resolvedId)
      : false;
    return { cacheDir: explicitCacheDir, localFilesOnly };
  }

  if (!installedPath) return { localFilesOnly: false };

  // `FileCache` reads `${cache_dir}/org/repo/file`, so the hub root (both the
  // `models--…` and the flat `org/repo` layouts live under it) is the right
  // `cache_dir`; caches elsewhere keep the previous default-cache behaviour.
  const cacheDir = installedPath.startsWith(cacheRoot + sep) ? cacheRoot : undefined;
  const localFilesOnly = await ensureFlatCacheLink(cacheRoot, resolvedId);
  return { cacheDir, localFilesOnly };
}

/**
 * Default loader. The specifier is a variable so that Node resolves
 * `@huggingface/transformers` at runtime using ESM module resolution relative
 * to this package (from `dist/provider/local.js` up to
 * `packages/core/node_modules`), rather than bundling it at build time.
 */
async function defaultTransformersLoader(): Promise<TransformersModule> {
  const specifier = "@huggingface/transformers";
  return (await import(specifier)) as unknown as TransformersModule;
}

/**
 * Weight variant T3OS targets for local inference. The model downloader only
 * fetches the Q4 files (`decoder_model_merged_q4.onnx`, `embed_tokens_q4.onnx`
 * plus their `.onnx_data` shards), so the pipeline must be told to resolve that
 * same variant — Transformers.js otherwise defaults to fp32.
 */
export const LOCAL_MODEL_DTYPE = "q4";

async function transformersGenerate(
  modelId: string,
  loadTransformers: TransformersLoader,
  options: { token?: string | undefined; cacheDir?: string | undefined } = {}
): Promise<GenerateFn> {
  if (options.token) {
    // `@huggingface/transformers` reads this env var when fetching gated models.
    process.env.HF_TOKEN = options.token;
  }
  let mod: TransformersModule;
  try {
    mod = await loadTransformers();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to load @huggingface/transformers for local inference: ${msg}. ` +
      `Ensure @huggingface/transformers is installed or configure an active local runtime.`
    );
  }
  const { cacheDir, localFilesOnly } = await resolveCacheDir(modelId, options.cacheDir);
  // Transformers.js resolves weights from the repo's `onnx/` subfolder, so
  // map to the ONNX-converted repository when the canonical repo lacks one.
  const resolvedId = resolveLocalModelId(modelId);
  let generator: TextGenerator;
  try {
    // `dtype` must match the files the downloader fetched: T3OS installs the
    // Q4 quantized build, and the default (fp32) would look for the unquantized
    // `decoder_model_merged.onnx` instead. `local_files_only` (only set once
    // the local cache is verified complete) stops Transformers.js from
    // re-downloading files that are already on disk.
    generator = await mod.pipeline("text-generation", resolvedId, {
      ...(cacheDir ? { cache_dir: cacheDir } : {}),
      ...(localFilesOnly ? { local_files_only: true } : {}),
      dtype: LOCAL_MODEL_DTYPE,
    });
  } catch (err) {
    throw formatModelLoadError(modelId, err);
  }
  return async function* generate(prompt, opts) {
    const queue: string[] = [];
    let generatorError: unknown = null;

    let streamer: StreamerLike;
    const useTextStreamer = Boolean(mod.TextStreamer && (generator as any).tokenizer);
    if (useTextStreamer) {
      const TextStreamerClass = mod.TextStreamer as any;
      const tokenizer = (generator as any).tokenizer;
      let origEnd: (() => void) | undefined;
      const textStreamer: any = new TextStreamerClass(tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (chunk: string) => {
          if (typeof chunk === "string" && chunk.length > 0) {
            queue.push(chunk);
          }
        }
      });
      origEnd = textStreamer.end.bind(textStreamer);
      streamer = {
        put(value: unknown) {
          // TextStreamer handles token decoding internally via callback
          textStreamer.put(value);
        },
        end() {
          if (origEnd) origEnd();
          queue.push("\u0000");
        }
      };
    } else {
      streamer = {
        put(value: unknown) {
          if (typeof value === "string" && value.length > 0) {
            queue.push(value);
          }
          // Ignore non-string values (including bigint arrays) from raw generators
        },
        end() {
          queue.push("\u0000");
        }
      };
    }

    const outcome = generator(prompt, {
      max_new_tokens: opts.maxTokens,
      temperature: opts.temperature,
      do_sample: opts.temperature > 0,
      streamer
    })
      .then((output: any) => {
        if (queue.length === 0 && output) {
          const text = Array.isArray(output) && output[0]?.generated_text
            ? output[0].generated_text
            : typeof output === "string"
              ? output
              : "";
          if (text) {
            const answer = text.startsWith(prompt) ? text.slice(prompt.length) : text;
            if (answer) queue.push(answer);
          }
        }
        if (!queue.includes("\u0000")) {
          queue.push("\u0000");
        }
      })
      .catch((err) => {
        generatorError = err;
        if (!queue.includes("\u0000")) {
          queue.push("\u0000");
        }
      });

    for (;;) {
      if (queue.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      const next = queue.shift()!;
      if (generatorError !== null && queue.length === 0 && next === "\u0000") {
        throw generatorError;
      }
      if (next === "\u0000") return;
      if (typeof next === "string") {
        // Stop tokens (e.g. `<end_of_turn>`) must terminate generation:
        // anything from the token onward is model scaffolding, and letting it
        // through — or continuing past it — feeds repetition loops back to the
        // renderer. Trim at the earliest stop token and end the stream.
        let toYield = next;
        let stopFound = false;
        if (Array.isArray(opts.stopTokens)) {
          for (const stop of opts.stopTokens) {
            const idx = toYield.indexOf(stop);
            if (idx !== -1) {
              toYield = toYield.slice(0, idx);
              stopFound = true;
            }
          }
        }
        if (toYield.length > 0) yield toYield;
        if (stopFound) return;
      }
      // Skip non-string values (defensive)
    }
  };
}

export interface LocalProviderOptions {
  modelId: string;
  generate?: GenerateFn;
  contextLength?: number;
  /** Overrides how `@huggingface/transformers` is loaded; mainly for testing. */
  loadTransformers?: TransformersLoader;
  /**
   * Hugging Face access token. Gated models (e.g. Gemma) require an
   * authenticated request even for local inference; when provided it is
   * mirrored onto `process.env.HF_TOKEN`, which `@huggingface/transformers`
   * reads when fetching files from the Hugging Face Hub.
   */
  token?: string | undefined;
  /** Cache directory for `@huggingface/transformers` model files. */
  cacheDir?: string | undefined;
}

export class LocalProvider implements Provider {
  readonly id = "local";
  readonly #modelId: string;
  readonly #preset: ModelPreset;
  readonly #contextLength: number;
  readonly #loadTransformers: TransformersLoader;
  readonly #token: string | undefined;
  readonly #cacheDir: string | undefined;
  #generate: GenerateFn | undefined;

  constructor(options: LocalProviderOptions) {
    this.#modelId = options.modelId;
    this.#preset = resolvePreset(options.modelId);
    this.#contextLength = options.contextLength ?? this.#preset.contextLength;
    this.#generate = options.generate;
    this.#loadTransformers = options.loadTransformers ?? defaultTransformersLoader;
    this.#token = options.token;
    this.#cacheDir = options.cacheDir;
    if (this.#token) {
      process.env.HF_TOKEN = this.#token;
    }
  }

  capabilities(): ProviderCapabilities {
    // Local models have no native tool-calling API, but the prompt template
    // teaches them to emit fenced JSON tool invocations which streamChat
    // parses into tool call deltas — so tool calling is supported end to end.
    return { toolCalling: true, streaming: true, contextLength: this.#contextLength };
  }

  async #load(): Promise<GenerateFn> {
    const existing = this.#generate;
    if (existing) return existing;
    const built = await transformersGenerate(this.#modelId, this.#loadTransformers, {
      token: this.#token,
      cacheDir: this.#cacheDir,
    });
    this.#generate = built;
    return built;
  }

  async *streamChat(
    messages: Message[],
    tools: ToolSchema[],
    opts?: StreamOptions
  ): AsyncIterable<Delta> {
    const generate = await this.#load();
    const effectiveTools = shouldProvideTools(messages, tools) ? tools : [];
    const prompt = renderPrompt(messages, this.#preset, effectiveTools);
    const iterator = generate(prompt, {
      maxTokens: opts?.maxTokens ?? this.#preset.maxTokens,
      temperature: opts?.temperature ?? this.#preset.temperature,
      stopTokens: this.#preset.stopTokens
    });
    // Without tools nothing can match a tool invocation, so text streams
    // straight through untouched.
    const scanner = effectiveTools.length > 0 ? new ToolCallScanner(effectiveTools) : undefined;
    for await (const text of iterator) {
      if (opts?.signal?.aborted) throw new Error("aborted");
      if (text.length === 0) continue;
      if (!scanner) {
        yield { type: "text", text };
        continue;
      }
      yield* scanner.push(text);
    }
    if (scanner) yield* scanner.flush();
    yield { type: "done" };
  }
}
