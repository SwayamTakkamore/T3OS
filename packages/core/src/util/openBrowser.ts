import { spawn } from "node:child_process";

export const HF_TOKEN_URL = "https://huggingface.co/settings/tokens";

export interface BrowserCommand {
  command: string;
  args: string[];
}

export type BrowserLauncher = (command: string, args: readonly string[]) => void;

export interface OpenBrowserOptions {
  platform?: NodeJS.Platform;
  launch?: BrowserLauncher;
}

export function browserCommand(url: string, platform: NodeJS.Platform): BrowserCommand {
  if (platform === "darwin") {
    return { command: "open", args: [url] };
  }
  if (platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", url] };
  }
  return { command: "xdg-open", args: [url] };
}

const defaultLaunch: BrowserLauncher = (command, args) => {
  const child = spawn(command, [...args], { detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
};

export function openBrowser(url: string, options: OpenBrowserOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  const launch = options.launch ?? defaultLaunch;
  const { command, args } = browserCommand(url, platform);
  try {
    launch(command, args);
    return true;
  } catch {
    return false;
  }
}
