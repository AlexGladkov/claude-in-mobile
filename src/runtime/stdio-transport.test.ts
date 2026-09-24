import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import { CompatibleStdioServerTransport } from "./stdio-transport.js";

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "transport-test", version: "1.0.0" },
  },
} as const;

const initializeResponse = {
  jsonrpc: "2.0",
  id: 1,
  result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: {} },
} as const;

function readChunk(stream: PassThrough): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      cleanup();
      resolve(chunk);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      stream.off("data", onData);
      stream.off("error", onError);
    };
    stream.once("data", onData);
    stream.once("error", onError);
  });
}

function contentLengthFrame(message: JSONRPCMessage): string {
  const json = JSON.stringify(message);
  return `Content-Length: ${Buffer.byteLength(json, "utf8")}\r\n\r\n${json}`;
}

describe("CompatibleStdioServerTransport", () => {
  it("accepts OMP Content-Length frames and responds with the same framing", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new CompatibleStdioServerTransport(stdin, stdout);
    const received = new Promise<JSONRPCMessage>((resolve) => {
      transport.onmessage = resolve;
    });

    await transport.start();
    const frame = contentLengthFrame(initializeRequest);
    stdin.write(frame.slice(0, 12));
    stdin.write(frame.slice(12));

    await expect(received).resolves.toEqual(initializeRequest);
    const output = readChunk(stdout);
    await transport.send(initializeResponse);

    await expect(output).resolves.toEqual(
      Buffer.from(contentLengthFrame(initializeResponse)),
    );
    await transport.close();
  });

  it("accepts newline-delimited JSON and preserves the current SDK framing", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const transport = new CompatibleStdioServerTransport(stdin, stdout);
    const received = new Promise<JSONRPCMessage>((resolve) => {
      transport.onmessage = resolve;
    });

    await transport.start();
    stdin.write(`${JSON.stringify(initializeRequest)}\n`);

    await expect(received).resolves.toEqual(initializeRequest);
    const output = readChunk(stdout);
    await transport.send(initializeResponse);

    await expect(output).resolves.toEqual(
      Buffer.from(`${JSON.stringify(initializeResponse)}\n`),
    );
    await transport.close();
  });
});
