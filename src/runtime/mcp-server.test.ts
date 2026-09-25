import { describe, expect, it, vi } from "vitest";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";

import {
  createMcpServer,
  MCP_MAX_RESPONSE_CONTENT_ITEMS,
  MCP_MAX_RESPONSE_DATA_CHARS,
  MCP_MAX_RESPONSE_SERIALIZED_CHARS,
  MCP_MAX_RESPONSE_TEXT_CHARS,
} from "./mcp-server.js";

type CallResult = {
  content: Array<Record<string, unknown>>;
  isError?: boolean;
};

type CallHandler = (
  request: { method: "tools/call"; params: { name: string; arguments?: Record<string, unknown> } },
  extra: Record<string, unknown>,
) => Promise<CallResult>;

function getCallHandler(server: Server): CallHandler {
  const handlers = (server as unknown as {
    _requestHandlers: Map<string, CallHandler>;
  })._requestHandlers;
  const handler = handlers.get("tools/call");
  if (!handler) throw new Error("tools/call handler is not registered");
  return handler;
}

async function callWithResult(result: unknown): Promise<CallResult> {
  const { server } = createMcpServer({
    name: "test",
    version: "1.0.0",
    instructions: "",
    turboEnabled: true,
    handleTool: vi.fn(async () => result),
  });
  return getCallHandler(server)({ method: "tools/call", params: { name: "test", arguments: {} } }, {});
}


describe("MCP response content safety", () => {
  it("forwards the MCP request abort signal to the tool handler", async () => {
    const handleTool = vi.fn(async () => ({ text: "ok" }));
    const { server } = createMcpServer({
      name: "test",
      version: "1.0.0",
      instructions: "",
      turboEnabled: true,
      handleTool,
    });
    const signal = new AbortController().signal;

    const result = await getCallHandler(server)(
      { method: "tools/call", params: { name: "test", arguments: {} } },
      { signal },
    );

    expect(result.content[0]?.text).toBe("ok");
    expect(handleTool).toHaveBeenCalledWith("test", {}, undefined, signal);
  });
  it("sanitizes every text block, applies one aggregate budget, and preserves isError", async () => {
    const result = await callWithResult({
      content: Array.from({ length: 12 }, (_, index) => ({
        type: "text",
        text: `password=super-secret-${index} ${"x".repeat(4096)}`,
      })),
      isError: true,
    });

    const text = result.content
      .filter((block) => block.type === "text")
      .map((block) => String(block.text ?? ""))
      .join("");

    expect(text.length).toBeLessThanOrEqual(MCP_MAX_RESPONSE_TEXT_CHARS);
    expect(text).not.toContain("super-secret");
    expect(result.isError).toBe(true);
  });

  it("bounds image data and content item count without dropping unrelated content", async () => {
    const result = await callWithResult({
      content: [
        {
          type: "image",
          data: "A".repeat(MCP_MAX_RESPONSE_DATA_CHARS + 1_000),
          mimeType: "image/png",
        },
        { type: "resource_link", uri: "https://example.test/resource", name: "resource" },
        ...Array.from({ length: MCP_MAX_RESPONSE_CONTENT_ITEMS + 5 }, () => ({
          type: "text",
          text: "ok",
        })),
      ],
    });

    expect(result.content.length).toBeLessThanOrEqual(MCP_MAX_RESPONSE_CONTENT_ITEMS);
    const image = result.content.find((block) => block.type === "image");
    expect(image).toBeDefined();
    expect(String(image?.data).length).toBe(MCP_MAX_RESPONSE_DATA_CHARS);
    expect(result.content.some((block) => block.type === "resource_link")).toBe(true);
  });
  it("bounds aggregate serialized image and resource content", async () => {
    const content = Array.from({ length: 10 }, (_, index) => [
      {
        type: "image",
        data: "A".repeat(MCP_MAX_RESPONSE_DATA_CHARS),
        mimeType: "image/png",
      },
      {
        type: "resource",
        resource: {
          uri: `https://example.test/resource/${index}`,
          text: `password=nested-secret-${index} ${"x".repeat(1_024)}`,
          blob: "B".repeat(MCP_MAX_RESPONSE_DATA_CHARS),
        },
      },
    ]).flat();

    const result = await callWithResult({ content });
    const serialized = JSON.stringify(result.content);

    expect(serialized.length).toBeLessThanOrEqual(MCP_MAX_RESPONSE_SERIALIZED_CHARS);
    expect(result.content.length).toBeLessThanOrEqual(MCP_MAX_RESPONSE_CONTENT_ITEMS);
    const nestedText = result.content
      .filter((block) => block.type === "resource")
      .map((block) => {
        const resource = block.resource;
        return resource && typeof resource === "object"
          ? String((resource as Record<string, unknown>).text ?? "")
          : "";
      })
      .join("");
    expect(nestedText.length).toBeLessThanOrEqual(MCP_MAX_RESPONSE_TEXT_CHARS);
    expect(nestedText).not.toContain("nested-secret");
  });


  it("drops unbounded metadata before response serialization", async () => {
    const giant = "M".repeat(2_000_000);
    const result = await callWithResult({
      content: [
        {
          type: "resource_link",
          uri: "https://example.test/embedded",
          name: "embedded",
          giant,
          annotations: { description: giant },
          _meta: { giant },
        },
        {
          type: "resource",
          resource: {
            uri: "https://example.test/embedded",
            text: "safe",
            blob: "Q".repeat(20),
          },
          giant,
        },
      ],
    });

    expect(JSON.stringify(result.content).length).toBeLessThan(10_000);
    for (const block of result.content) {
      expect(Object.hasOwn(block, "giant")).toBe(false);
      expect(Object.hasOwn(block, "annotations")).toBe(false);
      expect(Object.hasOwn(block, "_meta")).toBe(false);
    }
    const resource = result.content.find((block) => block.type === "resource")?.resource;
    expect(resource && typeof resource === "object"
      ? Object.hasOwn(resource, "extra")
      : false).toBe(false);
  });

  it("preserves small JSON-like results while bounding oversized unknown results", async () => {
    const smallResult = await callWithResult({
      ok: true,
      nested: { value: "small" },
    });
    expect(String(smallResult.content[0]?.text ?? ""))
      .toBe('{"ok":true,"nested":{"value":"small"}}');

    const giant = "x".repeat(2_000_000);
    const result = await callWithResult({
      nested: {
        payload: {
          giant,
          deeper: { giant },
        },
      },
    });

    const text = String(result.content[0]?.text ?? "");
    expect(text).toContain('"nested"');
    expect(text.length).toBeLessThanOrEqual(MCP_MAX_RESPONSE_TEXT_CHARS);
    expect(text).not.toContain(giant);
  });

  it("keeps ordinary text redaction behavior", async () => {
    const result = await callWithResult({ text: "Bearer top-secret-token" });
    const text = String(result.content[0]?.text ?? "");
    expect(text).toContain("Bearer [REDACTED]");
    expect(text).not.toContain("top-secret-token");
  });

  it("redacts sensitive object keys before JSON fallback serialization", async () => {
    const result = await callWithResult({
      password: "password-secret",
      otp: "otp-secret",
      pin: "pin-secret",
      one_time_code: "one-time-code-secret",
      verificationCode: "verification-code-secret",
      cvv: "cvv-secret",
      shipping: "public-shipping",
      nested: {
        apiKey: "api-key-secret",
        access_token: "access-token-secret",
        visible: "public",
      },
    });
    const text = String(result.content[0]?.text ?? "");

    expect(text).toContain('"visible":"public"');
    expect(text).toContain('"shipping":"public-shipping"');
    for (const secret of [
      "password-secret",
      "otp-secret",
      "pin-secret",
      "one-time-code-secret",
      "verification-code-secret",
      "cvv-secret",
      "api-key-secret",
      "access-token-secret",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("redacts JSON credentials in tool text and thrown errors", async () => {
    const textResult = await callWithResult({
      text: JSON.stringify({ password: "text-secret" }),
    });
    expect(String(textResult.content[0]?.text ?? "")).not.toContain("text-secret");

    const { server } = createMcpServer({
      name: "test",
      version: "1.0.0",
      instructions: "",
      turboEnabled: true,
      handleTool: vi.fn(async () => {
        throw new Error(JSON.stringify({ authorization: "error-secret" }));
      }),
    });
    const errorResult = await getCallHandler(server)(
      { method: "tools/call", params: { name: "test", arguments: {} } },
      {},
    );
    expect(String(errorResult.content[0]?.text ?? "")).not.toContain("error-secret");
    expect(String(errorResult.content[0]?.text ?? "")).toContain("[REDACTED]");
  });
  it("redacts bare credential families from text and thrown errors", async () => {
    const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const anthropicToken = "sk-ant-api03-xxxxxxxxxxxxxxxxxxxxxx";
    const textResult = await callWithResult({
      text: `plugin output ${githubToken} ${anthropicToken}`,
    });
    expect(String(textResult.content[0]?.text ?? "")).not.toContain(githubToken);
    expect(String(textResult.content[0]?.text ?? "")).not.toContain(anthropicToken);

    const { server } = createMcpServer({
      name: "test",
      version: "1.0.0",
      instructions: "",
      turboEnabled: true,
      handleTool: vi.fn(async () => {
        throw new Error(`upstream failed with ${githubToken}`);
      }),
    });
    const errorResult = await getCallHandler(server)(
      { method: "tools/call", params: { name: "test", arguments: {} } },
      {},
    );
    expect(String(errorResult.content[0]?.text ?? "")).not.toContain(githubToken);
  });

  it("sanitizes resource-link metadata and credential-bearing URI components", async () => {
    const awsAccessKey = "AKIAIOSFODNN7EXAMPLE";
    const awsSecret = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const githubToken = "ghp_1234567890abcdefghijklmnopqrstuvwxyz";
    const jwt = "eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJzZWNyZXQifQ.c2lnbmF0dXJl";

    const result = await callWithResult({
      content: [
        {
          type: "resource_link",
          uri: `https://user:${encodeURIComponent(awsSecret)}@example.test/resource?token=${
            encodeURIComponent(awsAccessKey)
          }&view=full#${jwt}`,
          name: `documentation ${githubToken}`,
          description: `release notes contain ${awsSecret}`,
          mimeType: `text/plain; secret=${awsSecret}`,
          metadata: `untrusted ${githubToken}`,
        },
        {
          type: "resource",
          resource: {
            uri: "mcp://example.test/resource?view=full#section",
            text: "ordinary text",
            mimeType: "text/plain; charset=utf-8",
            _meta: { description: `untrusted ${githubToken}` },
          },
        },
      ],
    });

    const serialized = JSON.stringify(result.content);
    for (const credential of [awsAccessKey, awsSecret, githubToken, jwt]) {
      expect(serialized).not.toContain(credential);
    }

    const link = result.content.find((block) => block.type === "resource_link");
    expect(link).toBeDefined();
    expect(link?.uri).toBe("https://example.test/resource?view=full");
    expect(String(link?.name)).toContain("[REDACTED");
    expect(String(link?.description)).toContain("[REDACTED");
    expect(String(link?.mimeType)).toContain("[REDACTED");

    const resource = result.content.find((block) => block.type === "resource")?.resource;
    expect(resource && typeof resource === "object"
      ? (resource as Record<string, unknown>).uri
      : undefined).toBe("mcp://example.test/resource?view=full#section");
  });
});
