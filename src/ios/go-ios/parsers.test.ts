import { describe, expect, it } from "vitest";

import { parseDeviceList, parseInfo, toIosDevice } from "./parsers.js";

// Real go-ios shapes: a structured-log line precedes the result line.
const LIST_OUTPUT = [
  `{"time":"2026-06-15T23:31:54+03:00","level":"WARN","msg":"go-ios agent is not running."}`,
  `{"deviceList":["00008130-0014191E2221001C"]}`,
].join("\n");

const INFO_OUTPUT = [
  `{"level":"INFO","msg":"no udid specified using first device","udid":"00008130-0014191E2221001C"}`,
  `{"DeviceClass":"iPhone","DeviceName":"Mobile Developer","ProductType":"iPhone16,1","ProductVersion":"26.5","UniqueDeviceID":"00008130-0014191E2221001C"}`,
].join("\n");

describe("parseDeviceList", () => {
  it("extracts udids past the leading log line", () => {
    expect(parseDeviceList(LIST_OUTPUT)).toEqual(["00008130-0014191E2221001C"]);
  });

  it("returns [] for empty device list", () => {
    expect(parseDeviceList(`{"deviceList":[]}`)).toEqual([]);
  });

  it("returns [] when no result line is present", () => {
    expect(parseDeviceList(`{"level":"WARN","msg":"noise"}`)).toEqual([]);
    expect(parseDeviceList("not json at all")).toEqual([]);
  });
});

describe("parseInfo", () => {
  it("reads identity fields from the result object", () => {
    expect(parseInfo(INFO_OUTPUT)).toEqual({
      name: "Mobile Developer",
      productVersion: "26.5",
      productType: "iPhone16,1",
      deviceClass: "iPhone",
    });
  });

  it("returns {} when no identity object is present", () => {
    expect(parseInfo(`{"level":"INFO","msg":"x"}`)).toEqual({});
  });
});

describe("toIosDevice", () => {
  it("marks physical devices isSimulator:false with connected state", () => {
    const d = toIosDevice("00008130-0014191E2221001C", {
      name: "Mobile Developer",
      productVersion: "26.5",
      productType: "iPhone16,1",
    });
    expect(d).toEqual({
      id: "00008130-0014191E2221001C",
      name: "Mobile Developer",
      state: "connected",
      runtime: "iOS 26.5",
      isSimulator: false,
    });
  });

  it("falls back through name → productType → deviceClass → default", () => {
    expect(toIosDevice("u", { productType: "iPhone16,1" }).name).toBe("iPhone16,1");
    expect(toIosDevice("u", { deviceClass: "iPhone" }).name).toBe("iPhone");
    expect(toIosDevice("u", {}).name).toBe("iOS device");
    expect(toIosDevice("u", {}).runtime).toBe("iOS");
  });
});
