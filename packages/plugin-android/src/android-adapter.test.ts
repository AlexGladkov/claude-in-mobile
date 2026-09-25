import { describe, expect, it, vi } from "vitest";


import { AndroidAdapter } from "./android-adapter.js";
import { AdbClient } from "./adb/client.js";

describe("AndroidAdapter explicit device routing", () => {
  it("returns a client scoped to an explicit device without changing selection", () => {
    const adapter = new AndroidAdapter(new AdbClient("selected-device"));

    expect(adapter.getClient("target-device").getDeviceId()).toBe("target-device");
    expect(adapter.getSelectedDeviceId()).toBe("selected-device");
  });
  it("keeps WebView inspectors isolated and reusable per device", () => {
    const adapter = new AndroidAdapter(new AdbClient("selected-device"));

    const selected = adapter.getWebViewInspector("selected-device");
    const selectedAgain = adapter.getWebViewInspector("selected-device");
    const target = adapter.getWebViewInspector("target-device");

    expect(selectedAgain).toBe(selected);
    expect(target).not.toBe(selected);

    adapter.dispose();
  });

  it("retains only inspectors whose cleanup fails so dispose can retry", () => {
    const adapter = new AndroidAdapter(new AdbClient("selected-device"));
    const failedInspector = adapter.getWebViewInspector("target-device");
    const successfulInspector = adapter.getWebViewInspector("other-device");
    const failedCleanup = vi
      .spyOn(failedInspector, "cleanup")
      .mockImplementationOnce(() => {
        throw new Error("forward is still active");
      })
      .mockImplementationOnce(() => {});
    const successfulCleanup = vi.spyOn(successfulInspector, "cleanup");

    adapter.dispose();
    expect(failedCleanup).toHaveBeenCalledTimes(1);
    expect(successfulCleanup).toHaveBeenCalledTimes(1);

    adapter.dispose();
    expect(failedCleanup).toHaveBeenCalledTimes(2);
    expect(successfulCleanup).toHaveBeenCalledTimes(1);
  });
});
