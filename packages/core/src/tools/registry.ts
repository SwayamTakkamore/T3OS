import type { Tool } from "./types.js";
import { globTool, grepTool, listDirTool, readFileTool } from "./read.js";
import { runShellTool } from "./shell.js";
import { editFileTool, writeFileTool } from "./write.js";

export function builtInTools(): Tool[] {
  return [readFileTool, listDirTool, globTool, grepTool, writeFileTool, editFileTool, runShellTool];
}
