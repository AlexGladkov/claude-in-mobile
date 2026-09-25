import { describe, expect, it } from "vitest";

import { waitForRetry } from "./retry-delay.js";

describe("waitForRetry", () => {
  it("cancels the backoff immediately when the request aborts", async () => {
    const controller = new AbortController();
    const wait = waitForRetry(60_000, controller.signal);

    controller.abort();

    await expect(wait).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  });
});
