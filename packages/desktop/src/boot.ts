import { DesktopClient } from "./api.js";
import { mountDesktop } from "./main.js";

const client = new DesktopClient({
  baseUrl: (globalThis as { T3OS_API_URL?: string }).T3OS_API_URL ?? "http://127.0.0.1:8787",
});

const root = document.getElementById("root");
if (root) mountDesktop({ client, root });
