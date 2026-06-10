import type { ToolDefinition } from "./registry.js";
import { defineTool, z } from "./define-tool.js";
import { validatePath } from "../utils/sanitize.js";
import { textResult } from "../utils/tool-result.js";

const platformAurora = z
  .enum(["android", "ios", "desktop", "aurora", "browser"])
  .optional()
  .describe("Target platform. If not specified, uses the active target.");

export const auroraTools: ToolDefinition[] = [
  defineTool({
    name: "file_push",
    description: "Upload file to Aurora OS device",
    schema: z.object({
      platform: platformAurora,
      localPath: z.string().describe("Local file path"),
      remotePath: z.string().describe("Remote destination path"),
    }),
    handler: async (args, ctx) => {
      validatePath(args.localPath, "localPath");
      validatePath(args.remotePath, "remotePath");
      const result = await ctx.deviceManager
        .getAuroraClient()
        .pushFile(args.localPath, args.remotePath);
      return textResult(result);
    },
  }),

  defineTool({
    name: "file_pull",
    description: "Download file from Aurora OS device",
    schema: z.object({
      platform: platformAurora,
      remotePath: z.string().describe("Path to the remote file"),
      localPath: z.string().optional().describe("Optional local path"),
    }),
    handler: async (args, ctx) => {
      validatePath(args.remotePath, "remotePath");
      const buffer = await ctx.deviceManager
        .getAuroraClient()
        .pullFile(args.remotePath, args.localPath);
      return textResult(`Downloaded ${args.remotePath} (${buffer.length} bytes)`);
    },
  }),
];
