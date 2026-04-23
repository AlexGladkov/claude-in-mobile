import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";
import { validatePath } from "../utils/sanitize.js";

export const auroraTools: ToolDefinition[] = [
  {
    tool: {
      name: "file_push",
      description: "Upload file to Aurora OS device",
      inputSchema: {
        type: "object",
        properties: {
          platform: { type: "string", enum: ["android", "ios", "desktop", "aurora", "browser"], const: "aurora", description: "Target platform. If not specified, uses the active target." },
          localPath: { type: "string", description: "Local file path" },
          remotePath: { type: "string", description: "Remote destination path" },
        },
        required: ["localPath", "remotePath"],
      },
    },
    handler: async (args, ctx) => {
      validatePath(args.localPath as string, "localPath");
      validatePath(args.remotePath as string, "remotePath");
      const result = await ctx.deviceManager.getAuroraClient().pushFile(
        args.localPath as string,
        args.remotePath as string
      );
      return { text: result };
    },
  },
  {
    tool: {
      name: "file_pull",
      description: "Download file from Aurora OS device",
      inputSchema: {
        type: "object",
        properties: {
          platform: { const: "aurora" },
          remotePath: { type: "string", description: "Path to the remote file" },
          localPath: { type: "string", description: "Optional local path" },
        },
        required: ["remotePath"],
      },
    },
    handler: async (args, ctx) => {
      validatePath(args.remotePath as string, "remotePath");
      const buffer = await ctx.deviceManager.getAuroraClient().pullFile(
        args.remotePath as string,
        args.localPath as string | undefined
      );
      return { text: `Downloaded ${args.remotePath} (${buffer.length} bytes)` };
    },
  },
];
