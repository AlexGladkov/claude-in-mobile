import type { ToolDefinition } from "./registry.js";
import type { ToolContext } from "./context.js";

export const auroraTools: ToolDefinition[] = [
  {
    tool: {
      name: "push_file",
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
      const result = await ctx.deviceManager.getAuroraClient().pushFile(
        args.localPath as string,
        args.remotePath as string
      );
      return { text: result };
    },
  },
  {
    tool: {
      name: "pull_file",
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
      const buffer = await ctx.deviceManager.getAuroraClient().pullFile(
        args.remotePath as string,
        args.localPath as string | undefined
      );
      return { text: `Downloaded ${args.remotePath} (${buffer.length} bytes)` };
    },
  },
];
