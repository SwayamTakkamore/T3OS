import { HF_TOKEN_URL, type AgentEvent } from "@t3os/core";
import type { DesktopClient } from "./api.js";

export interface MountDeps {
  client: DesktopClient;
  root: HTMLElement;
  createSession?: () => Promise<string>;
}

export function mountDesktop(deps: MountDeps): () => void {
  const { client, root } = deps;
  const createSession = deps.createSession ?? (() => client.createSession().then((s) => s.id));

  root.innerHTML = `
    <div id="t3os">
      <header>
        <span>t3os</span>
        <button type="button" id="get-token">Get HF Token</button>
      </header>
      <div class="transcript" id="transcript"></div>
      <footer>
        <input id="prompt" placeholder="Ask T3OS to do something..." />
      </footer>
    </div>
  `;

  const transcript = root.querySelector<HTMLDivElement>("#transcript");
  const input = root.querySelector<HTMLInputElement>("#prompt");
  let sessionId: string | null = null;

  const append = (kind: string, text: string): void => {
    if (!transcript) return;
    const entry = document.createElement("div");
    entry.className = "entry";
    entry.dataset.kind = kind;
    entry.textContent = text;
    transcript.appendChild(entry);
  };

  const handleEvent = (event: AgentEvent): void => {
    if (event.type === "user_message") append("user", `> ${event.text}`);
    else if (event.type === "text") append("assistant", event.text);
    else if (event.type === "tool_call") append("tool", `${event.name} [${event.class}]`);
    else if (event.type === "tool_result") append("tool", `${event.name} [${event.ok ? "ok" : "fail"}]`);
    else if (event.type === "error") append("error", event.message);
  };

  const submit = async (): Promise<void> => {
    if (!input) return;
    const prompt = input.value.trim();
    if (prompt.length === 0) return;
    input.value = "";
    if (!sessionId) sessionId = await createSession();
    for await (const event of client.startTurn(sessionId, prompt)) handleEvent(event);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Enter") void submit();
  };
  input?.addEventListener("keydown", onKeyDown);

  const tokenButton = root.querySelector<HTMLButtonElement>("#get-token");
  const onTokenClick = (): void => {
    window.open(HF_TOKEN_URL, "_blank", "noopener");
  };
  tokenButton?.addEventListener("click", onTokenClick);

  return () => {
    input?.removeEventListener("keydown", onKeyDown);
    tokenButton?.removeEventListener("click", onTokenClick);
    root.innerHTML = "";
  };
}
