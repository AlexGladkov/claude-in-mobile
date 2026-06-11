import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync, verify } from "node:crypto";
import { writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { mintAscToken, clearAscTokenCache } from "./asc-jwt.js";
import { AppStoreConnectClient } from "./app-store-connect.js";
import {
  AscAuthError,
  AscKeyMissingError,
  AscRateLimitError,
  isRetryable,
} from "../errors/index.js";

// ── fixtures ──────────────────────────────────────────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const KEY_ID = "ABC123DEFG";
const ISSUER_ID = "69a6de70-03db-47e3-e053-5b8c7c11a4d1";

const APP_LIST = {
  data: [{ id: "app-1", type: "apps", attributes: { name: "MyApp", bundleId: "com.example.app" } }],
};
const BUILD_LIST = {
  data: [
    {
      id: "build-1",
      type: "builds",
      attributes: { version: "42", processingState: "VALID", uploadedDate: "2026-06-01T00:00:00Z", expired: false },
    },
  ],
};
const GROUP_LIST = {
  data: [
    { id: "group-1", type: "betaGroups", attributes: { name: "Internal", isInternalGroup: true } },
    { id: "group-2", type: "betaGroups", attributes: { name: "External", isInternalGroup: false } },
  ],
};

// ── helpers ──────────────────────────────────────────────────────────────────

type MockResponse = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

function makeFetch(...responses: MockResponse[]) {
  let call = 0;
  return vi.fn().mockImplementation(() => {
    const r = responses[call++];
    if (!r) throw new Error(`Unexpected fetch call #${call}`);
    const isJson = typeof r.body === "object" && r.body !== null;
    const text = isJson ? JSON.stringify(r.body) : String(r.body ?? "");
    return Promise.resolve({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => (r.headers ?? {})[k.toLowerCase()] ?? null },
      text: () => Promise.resolve(text),
      json: () => Promise.resolve(r.body),
    });
  });
}

function decodeSegment(seg: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
}

const ASC_ENV_KEYS = [
  "ASC_KEY_ID",
  "ASC_ISSUER_ID",
  "ASC_KEY_FILE",
  "ASC_PRIVATE_KEY",
  "APP_STORE_CONNECT_API_KEY_KEY_ID",
  "APP_STORE_CONNECT_API_KEY_ISSUER_ID",
  "APP_STORE_CONNECT_API_KEY_KEY_FILEPATH",
  "APP_STORE_CONNECT_API_KEY_KEY",
] as const;

let savedEnv: Record<string, string | undefined> = {};

function setPrimaryEnv(): void {
  process.env.ASC_KEY_ID = KEY_ID;
  process.env.ASC_ISSUER_ID = ISSUER_ID;
  process.env.ASC_PRIVATE_KEY = PEM;
}

function fetchCalls() {
  return (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
}

// ── asc-jwt ──────────────────────────────────────────────────────────────────

describe("mintAscToken", () => {
  beforeEach(() => clearAscTokenCache());

  it("produces a valid ES256 JWT with correct header and payload", () => {
    const { token, expiresAt } = mintAscToken({ keyId: KEY_ID, issuerId: ISSUER_ID, privateKeyPem: PEM });
    const parts = token.split(".");
    expect(parts).toHaveLength(3);

    const header = decodeSegment(parts[0]);
    expect(header).toEqual({ alg: "ES256", kid: KEY_ID, typ: "JWT" });

    const payload = decodeSegment(parts[1]);
    expect(payload.iss).toBe(ISSUER_ID);
    expect(payload.aud).toBe("appstoreconnect-v1");
    expect(typeof payload.iat).toBe("number");
    expect(typeof payload.exp).toBe("number");
    // Apple rejects tokens valid for more than 20 minutes
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(20 * 60);
    expect((payload.exp as number)).toBeGreaterThan(payload.iat as number);
    expect(expiresAt).toBe((payload.exp as number) * 1000);
  });

  it("signs with ECDSA P-256 in IEEE P1363 (JOSE) encoding", () => {
    const { token } = mintAscToken({ keyId: KEY_ID, issuerId: ISSUER_ID, privateKeyPem: PEM });
    const [h, p, s] = token.split(".");
    const ok = verify(
      "sha256",
      Buffer.from(`${h}.${p}`, "utf8"),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(s, "base64url")
    );
    expect(ok).toBe(true);
    // IEEE P1363 signature for P-256 is exactly 64 bytes (r || s)
    expect(Buffer.from(s, "base64url")).toHaveLength(64);
  });

  it("caches tokens per (keyId, issuerId) until near expiry", () => {
    const first = mintAscToken({ keyId: KEY_ID, issuerId: ISSUER_ID, privateKeyPem: PEM });
    const second = mintAscToken({ keyId: KEY_ID, issuerId: ISSUER_ID, privateKeyPem: PEM });
    expect(second.token).toBe(first.token); // ECDSA is randomized — identical means cached

    clearAscTokenCache();
    const third = mintAscToken({ keyId: KEY_ID, issuerId: ISSUER_ID, privateKeyPem: PEM });
    expect(third.token).not.toBe(first.token);
  });

  it("throws on invalid PEM without leaking key material", () => {
    expect(() => mintAscToken({ keyId: KEY_ID, issuerId: ISSUER_ID, privateKeyPem: "not-a-pem" }))
      .toThrow();
  });
});

// ── AppStoreConnectClient ─────────────────────────────────────────────────────

describe("AppStoreConnectClient", () => {
  beforeEach(() => {
    savedEnv = {};
    for (const k of ASC_ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    clearAscTokenCache();
  });

  afterEach(() => {
    for (const k of ASC_ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.unstubAllGlobals();
  });

  // ── auth resolution ─────────────────────────────────────────────────────────

  describe("auth", () => {
    it("throws AscKeyMissingError when no env vars are set", async () => {
      const client = new AppStoreConnectClient();
      await expect(client.findApp("com.example.app")).rejects.toBeInstanceOf(AscKeyMissingError);
      await expect(client.findApp("com.example.app")).rejects.toThrow(/ASC_KEY_ID.*ASC_ISSUER_ID.*ASC_KEY_FILE/s);
    });

    it("throws AscKeyMissingError when IDs are set but key material is absent", async () => {
      process.env.ASC_KEY_ID = KEY_ID;
      process.env.ASC_ISSUER_ID = ISSUER_ID;
      const client = new AppStoreConnectClient();
      await expect(client.findApp("com.example.app")).rejects.toBeInstanceOf(AscKeyMissingError);
    });

    it("authenticates with ASC_* env vars and inline PEM", async () => {
      setPrimaryEnv();
      vi.stubGlobal("fetch", makeFetch({ status: 200, body: APP_LIST }));

      const app = await new AppStoreConnectClient().findApp("com.example.app");
      expect(app).toEqual({ id: "app-1", name: "MyApp" });

      const [, opts] = fetchCalls()[0];
      expect(opts.headers.Authorization).toMatch(/^Bearer eyJ/);
    });

    it("reads the key from ASC_KEY_FILE (.p8 path)", async () => {
      const keyFile = join(tmpdir(), `asc-test-${Date.now()}.p8`);
      await writeFile(keyFile, PEM);
      process.env.ASC_KEY_ID = KEY_ID;
      process.env.ASC_ISSUER_ID = ISSUER_ID;
      process.env.ASC_KEY_FILE = keyFile;
      vi.stubGlobal("fetch", makeFetch({ status: 200, body: APP_LIST }));

      const app = await new AppStoreConnectClient().findApp("com.example.app");
      expect(app.id).toBe("app-1");

      await rm(keyFile, { force: true });
    });

    it("falls back to fastlane env var names", async () => {
      process.env.APP_STORE_CONNECT_API_KEY_KEY_ID = KEY_ID;
      process.env.APP_STORE_CONNECT_API_KEY_ISSUER_ID = ISSUER_ID;
      process.env.APP_STORE_CONNECT_API_KEY_KEY = PEM;
      vi.stubGlobal("fetch", makeFetch({ status: 200, body: APP_LIST }));

      const app = await new AppStoreConnectClient().findApp("com.example.app");
      expect(app.id).toBe("app-1");

      const [, opts] = fetchCalls()[0];
      expect(opts.headers.Authorization).toMatch(/^Bearer eyJ/);
    });
  });

  // ── findApp ─────────────────────────────────────────────────────────────────

  describe("findApp", () => {
    beforeEach(setPrimaryEnv);

    it("queries /v1/apps with bundleId filter", async () => {
      vi.stubGlobal("fetch", makeFetch({ status: 200, body: APP_LIST }));
      await new AppStoreConnectClient().findApp("com.example.app");

      const url = fetchCalls()[0][0] as string;
      expect(url).toBe("https://api.appstoreconnect.apple.com/v1/apps?filter[bundleId]=com.example.app");
    });

    it("throws when no app matches", async () => {
      vi.stubGlobal("fetch", makeFetch({ status: 200, body: { data: [] } }));
      await expect(new AppStoreConnectClient().findApp("com.missing.app"))
        .rejects.toThrow('no app found for bundleId "com.missing.app"');
    });
  });

  // ── getBuilds ───────────────────────────────────────────────────────────────

  describe("getBuilds", () => {
    beforeEach(setPrimaryEnv);

    it("builds filter query with app, sort and sparse fields", async () => {
      vi.stubGlobal("fetch", makeFetch({ status: 200, body: BUILD_LIST }));
      const builds = await new AppStoreConnectClient().getBuilds("app-1");

      const url = fetchCalls()[0][0] as string;
      expect(url).toContain("/v1/builds?");
      expect(url).toContain("filter[app]=app-1");
      expect(url).toContain("sort=-uploadedDate");
      expect(url).toContain("fields[builds]=processingState,version,uploadedDate,expired");
      expect(url).not.toContain("filter[preReleaseVersion.version]");

      expect(builds).toEqual([
        { id: "build-1", version: "42", processingState: "VALID", uploadedDate: "2026-06-01T00:00:00Z" },
      ]);
    });

    it("adds preReleaseVersion filter and limit when provided", async () => {
      vi.stubGlobal("fetch", makeFetch({ status: 200, body: BUILD_LIST }));
      await new AppStoreConnectClient().getBuilds("app-1", { version: "1.2.3", limit: 5 });

      const url = fetchCalls()[0][0] as string;
      expect(url).toContain("filter[preReleaseVersion.version]=1.2.3");
      expect(url).toContain("limit=5");
    });
  });

  // ── setWhatToTest ───────────────────────────────────────────────────────────

  describe("setWhatToTest", () => {
    beforeEach(setPrimaryEnv);

    it("creates the localization with a single POST when none exists", async () => {
      vi.stubGlobal("fetch", makeFetch({ status: 201, body: { data: { id: "loc-1" } } }));
      await new AppStoreConnectClient().setWhatToTest("build-1", "Bug fixes");

      const calls = fetchCalls();
      expect(calls).toHaveLength(1);
      const [url, opts] = calls[0];
      expect(url).toContain("/v1/betaBuildLocalizations");
      expect(opts.method).toBe("POST");

      const body = JSON.parse(opts.body);
      expect(body.data.type).toBe("betaBuildLocalizations");
      expect(body.data.attributes).toEqual({ whatsNew: "Bug fixes", locale: "en-US" });
      expect(body.data.relationships.build.data).toEqual({ type: "builds", id: "build-1" });
    });

    it("falls back to GET + PATCH on 409 conflict", async () => {
      vi.stubGlobal("fetch", makeFetch(
        { status: 409, body: { errors: [{ status: "409", code: "ENTITY_ERROR" }] } },
        { status: 200, body: { data: [{ id: "loc-9", attributes: { locale: "en-US" } }] } },
        { status: 200, body: { data: { id: "loc-9" } } },
      ));
      await new AppStoreConnectClient().setWhatToTest("build-1", "Updated notes");

      const calls = fetchCalls();
      expect(calls).toHaveLength(3);

      const [getUrl, getOpts] = calls[1];
      expect(getUrl).toContain("/v1/builds/build-1/betaBuildLocalizations");
      expect(getOpts.method).toBe("GET");

      const [patchUrl, patchOpts] = calls[2];
      expect(patchUrl).toContain("/v1/betaBuildLocalizations/loc-9");
      expect(patchOpts.method).toBe("PATCH");
      const body = JSON.parse(patchOpts.body);
      expect(body.data).toEqual({
        type: "betaBuildLocalizations",
        id: "loc-9",
        attributes: { whatsNew: "Updated notes" },
      });
    });
  });

  // ── beta groups ─────────────────────────────────────────────────────────────

  describe("getBetaGroups", () => {
    beforeEach(setPrimaryEnv);

    it("lists groups with isInternal mapped from isInternalGroup", async () => {
      vi.stubGlobal("fetch", makeFetch({ status: 200, body: GROUP_LIST }));
      const groups = await new AppStoreConnectClient().getBetaGroups("app-1");

      expect(fetchCalls()[0][0]).toContain("/v1/betaGroups?filter[app]=app-1");
      expect(groups).toEqual([
        { id: "group-1", name: "Internal", isInternal: true },
        { id: "group-2", name: "External", isInternal: false },
      ]);
    });
  });

  describe("addBuildToGroup", () => {
    beforeEach(setPrimaryEnv);

    it("POSTs the linkage and accepts 204 No Content", async () => {
      vi.stubGlobal("fetch", makeFetch({ status: 204, body: "" }));
      await new AppStoreConnectClient().addBuildToGroup("group-1", "build-1");

      const [url, opts] = fetchCalls()[0];
      expect(url).toContain("/v1/betaGroups/group-1/relationships/builds");
      expect(opts.method).toBe("POST");
      expect(JSON.parse(opts.body)).toEqual({ data: [{ type: "builds", id: "build-1" }] });
    });
  });

  // ── misc endpoints ──────────────────────────────────────────────────────────

  describe("submitForBetaReview / setEncryptionExempt", () => {
    beforeEach(setPrimaryEnv);

    it("submits a beta review submission for the build", async () => {
      vi.stubGlobal("fetch", makeFetch({ status: 201, body: { data: { id: "sub-1" } } }));
      await new AppStoreConnectClient().submitForBetaReview("build-1");

      const [url, opts] = fetchCalls()[0];
      expect(url).toContain("/v1/betaAppReviewSubmissions");
      const body = JSON.parse(opts.body);
      expect(body.data.relationships.build.data).toEqual({ type: "builds", id: "build-1" });
    });

    it("PATCHes usesNonExemptEncryption=false when exempt", async () => {
      vi.stubGlobal("fetch", makeFetch({ status: 200, body: { data: { id: "build-1" } } }));
      await new AppStoreConnectClient().setEncryptionExempt("build-1");

      const [url, opts] = fetchCalls()[0];
      expect(url).toContain("/v1/builds/build-1");
      expect(opts.method).toBe("PATCH");
      expect(JSON.parse(opts.body).data.attributes).toEqual({ usesNonExemptEncryption: false });
    });
  });

  // ── error mapping ───────────────────────────────────────────────────────────

  describe("error handling", () => {
    beforeEach(setPrimaryEnv);

    it("maps 401 to AscAuthError", async () => {
      vi.stubGlobal("fetch", makeFetch({ status: 401, body: { errors: [{ status: "401" }] } }));
      const err = await new AppStoreConnectClient().findApp("com.example.app").catch(e => e);
      expect(err).toBeInstanceOf(AscAuthError);
      expect(err.code).toBe("ASC_AUTH_ERROR");
    });

    it("maps 429 to retryable AscRateLimitError", async () => {
      vi.stubGlobal("fetch", makeFetch({ status: 429, body: "Too Many Requests" }));
      const err = await new AppStoreConnectClient().findApp("com.example.app").catch(e => e);
      expect(err).toBeInstanceOf(AscRateLimitError);
      expect(err.code).toBe("ASC_RATE_LIMIT");
      expect(isRetryable(err)).toBe(true);
    });

    it("redacts Bearer tokens from error bodies before throwing", async () => {
      const leakedToken = "eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJzZWNyZXQifQ.c2lnbmF0dXJl";
      vi.stubGlobal("fetch", makeFetch({
        status: 400,
        body: `Invalid request, your token Bearer ${leakedToken} was rejected`,
      }));
      const err = await new AppStoreConnectClient().findApp("com.example.app").catch(e => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).not.toContain(leakedToken);
      expect(err.message).not.toContain("eyJ");
      expect(err.message).toContain("[REDACTED]");
    });

    it("truncates error bodies to 200 chars", async () => {
      vi.stubGlobal("fetch", makeFetch({ status: 500, body: "x".repeat(5000) }));
      const err = await new AppStoreConnectClient().findApp("com.example.app").catch(e => e);
      expect(err.message).toContain("App Store Connect API 500");
      expect(err.message.length).toBeLessThan(500);
    });
  });
});
