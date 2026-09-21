import { createServer } from "node:net";
import type { Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { WDAManager } from "./wda-manager.js";

interface PortHarness {
  reservePort(): Promise<number>;
}

/** Bind exactly as WebDriverAgent does: the IPv4 wildcard address. */
function bind(port: number): Promise<Server | undefined> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(undefined));
    server.once("listening", () => resolve(server));
    server.listen(port, "0.0.0.0");
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

const opened: Server[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map(close));
});

describe("WDAManager port reservation", () => {
  it("does not hand out a port another process already serves", async () => {
    // Establish the condition if it is not already there: something serving 8100
    // on the wildcard address, exactly as a WebDriverAgent left by another process.
    const squatter = await bind(8_100);
    if (squatter) opened.push(squatter);

    const manager = new WDAManager();
    const port = await (manager as unknown as PortHarness).reservePort();
    const held = await bind(port);
    if (held) opened.push(held);

    expect(held).toBeDefined();
    await manager.cleanup();
  });
});
