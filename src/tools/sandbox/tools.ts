import type { ToolDefinition } from "../registry.js";
import { sandboxPrefsReadTool } from "./prefs-read.js";
import { sandboxPrefsWriteTool } from "./prefs-write.js";
import { sandboxSqliteQueryTool } from "./sqlite-query.js";
import { sandboxFileListTool } from "./file-list.js";
import { sandboxFileReadTool } from "./file-read.js";

export const sandboxTools: ToolDefinition[] = [
  sandboxPrefsReadTool,
  sandboxPrefsWriteTool,
  sandboxSqliteQueryTool,
  sandboxFileListTool,
  sandboxFileReadTool,
];
