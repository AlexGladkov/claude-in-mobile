import { createPrivateKey, sign } from "node:crypto";

/**
 * Zero-dependency ES256 JWT minting for the App Store Connect API.
 *
 * Apple requires ES256 (ECDSA P-256 + SHA-256) tokens signed with the .p8
 * private key downloaded from App Store Connect → Users and Access →
 * Integrations. Tokens are valid for at most 20 minutes; we mint with a
 * 10-minute lifetime and cache in memory until 60 s before expiry.
 *
 * SECURITY: the private key and the minted token are NEVER logged or
 * persisted — the cache is process-memory only.
 */

export interface AscKeyConfig {
  /** Key ID, e.g. "2X9R4HXF34" (10 uppercase alphanumeric chars). */
  keyId: string;
  /** Issuer ID (UUID) from the Integrations page. */
  issuerId: string;
  /** Contents of the .p8 file (PEM, PKCS#8 EC P-256). */
  privateKeyPem: string;
}

export interface AscToken {
  token: string;
  /** Epoch milliseconds when the token expires. */
  expiresAt: number;
}

const TOKEN_TTL_SECONDS = 600; // 10 min — well under Apple's 20-min limit
const EXPIRY_MARGIN_MS = 60_000; // refresh 60 s before expiry

// In-memory cache keyed on (keyId, issuerId). Never persisted.
const tokenCache = new Map<string, AscToken>();

function b64urlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/**
 * Mints (or returns a cached) ES256 JWT for App Store Connect.
 *
 * Header:  { alg: "ES256", kid, typ: "JWT" }
 * Payload: { iss, iat, exp: iat + 600, aud: "appstoreconnect-v1" }
 * Signature: ECDSA P-256 / SHA-256 in IEEE P1363 (r||s) encoding — the JOSE
 * format. Node's default DER encoding is NOT accepted by Apple.
 */
export function mintAscToken(config: AscKeyConfig): AscToken {
  const cacheKey = `${config.keyId}:${config.issuerId}`;
  const now = Date.now();

  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now + EXPIRY_MARGIN_MS) {
    return cached;
  }

  const iat = Math.floor(now / 1000);
  const exp = iat + TOKEN_TTL_SECONDS;

  const header = b64urlJson({ alg: "ES256", kid: config.keyId, typ: "JWT" });
  const payload = b64urlJson({
    iss: config.issuerId,
    iat,
    exp,
    aud: "appstoreconnect-v1",
  });
  const signingInput = `${header}.${payload}`;

  const key = createPrivateKey(config.privateKeyPem);
  const signature = sign("sha256", Buffer.from(signingInput, "utf8"), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");

  const minted: AscToken = {
    token: `${signingInput}.${signature}`,
    expiresAt: exp * 1000,
  };
  tokenCache.set(cacheKey, minted);
  return minted;
}

/** Clears the in-memory token cache (used by tests). */
export function clearAscTokenCache(): void {
  tokenCache.clear();
}
