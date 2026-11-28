import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { StoragePorts } from "@bugzilla-mcp/storage";
import { canonicalJson, sha256Hex } from "./canonical.js";
import type {
  CloudApprovalExpected,
  CloudApprovalPrecheckResult,
  CloudApprovalTokenService,
  CloudApprovalVerificationResult,
} from "./index.js";

interface SignedApprovalPayload {
  readonly jti: string;
  readonly approverIssuer: string;
  readonly approverPrincipalId: string;
  readonly instanceUrl: string;
  readonly proposalId: string;
  readonly revision: number;
  readonly bugId: number;
  readonly baseVersion: string;
  readonly diffHash: string;
  readonly visibility: "public" | "private";
  readonly expiresAtMs: number;
}

const MAX_CONSUMED_JTIS = 10_000;

function signPayload(secret: string, encodedPayload: string): string {
  return createHmac("sha256", secret).update(encodedPayload, "utf8").digest("base64url");
}

export function buildCloudApprovalTokenService(
  signingSecret: string,
  storage?: StoragePorts,
): CloudApprovalTokenService {
  // Map of jti -> expiresAtMs, pruned by TTL and capped at MAX_CONSUMED_JTIS.
  const consumedJtis = new Map<string, number>();
  // Tracks in-flight DB consumption attempts to close concurrent Promise.all windows
  // without poisoning consumedJtis if storage.consumeApprovalJti throws.
  const inFlightJtis = new Set<string>();

  function pruneConsumedJtis(nowMs: number): void {
    for (const [jti, expMs] of consumedJtis) {
      if (expMs <= nowMs) {
        consumedJtis.delete(jti);
      }
    }
    while (consumedJtis.size >= MAX_CONSUMED_JTIS) {
      const oldest = consumedJtis.keys().next().value;
      if (oldest === undefined) break;
      consumedJtis.delete(oldest);
    }
  }

  function recordConsumedInMemory(jti: string, expiresAtMs: number, nowMs: number): void {
    pruneConsumedJtis(nowMs);
    consumedJtis.set(jti, expiresAtMs);
  }

  function verifySignatureAndBindingSync(
    token: string,
    expected: CloudApprovalExpected,
  ): CloudApprovalPrecheckResult {
    const parts = token.split(".");
    if (parts.length !== 2) {
      return { valid: false, reason: "invalid_signature" };
    }
    const [encoded, providedSig] = parts;
    if (!encoded || !providedSig) {
      return { valid: false, reason: "invalid_signature" };
    }
    const expectedSig = signPayload(signingSecret, encoded);
    const a = Buffer.from(providedSig, "utf8");
    const b = Buffer.from(expectedSig, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      return { valid: false, reason: "invalid_signature" };
    }

    let payload: SignedApprovalPayload;
    try {
      payload = JSON.parse(
        Buffer.from(encoded, "base64url").toString("utf8"),
      ) as SignedApprovalPayload;
    } catch {
      return { valid: false, reason: "invalid_signature" };
    }

    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof payload.jti !== "string" ||
      payload.jti.length === 0 ||
      typeof payload.expiresAtMs !== "number" ||
      !Number.isFinite(payload.expiresAtMs)
    ) {
      return { valid: false, reason: "invalid_signature" };
    }

    if (expected.nowMs >= payload.expiresAtMs) {
      return { valid: false, reason: "expired" };
    }

    if (payload.visibility !== expected.visibility) {
      return { valid: false, reason: "visibility_mismatch" };
    }

    const expectedDiffHash = sha256Hex(canonicalJson(expected.diff));
    const bindingMatches =
      payload.approverIssuer === expected.approverIssuer &&
      payload.approverPrincipalId === expected.approverPrincipalId &&
      payload.instanceUrl === expected.instanceUrl &&
      payload.proposalId === expected.proposalId &&
      payload.revision === expected.revision &&
      payload.bugId === expected.bugId &&
      payload.baseVersion === expected.baseVersion &&
      payload.diffHash === expectedDiffHash;

    if (!bindingMatches) {
      return { valid: false, reason: "binding_mismatch" };
    }

    const knownExp = consumedJtis.get(payload.jti);
    if (knownExp !== undefined && knownExp > expected.nowMs) {
      return { valid: false, reason: "replayed" };
    }

    return { valid: true, jti: payload.jti, expiresAtMs: payload.expiresAtMs };
  }

  async function consumeVerifiedJti(
    jti: string,
    expiresAtMs: number,
    nowMs: number,
  ): Promise<boolean> {
    if (nowMs >= expiresAtMs) {
      return false;
    }
    const knownExp = consumedJtis.get(jti);
    if (knownExp !== undefined && knownExp > nowMs) {
      return false;
    }
    if (inFlightJtis.has(jti)) {
      return false;
    }

    inFlightJtis.add(jti);
    try {
      // DB-first consumption (#9 P1.3): persist to SQLite BEFORE updating in-memory cache
      // so transient DB errors never poison consumedJtis.
      if (storage?.consumeApprovalJti) {
        const newlyConsumed = await storage.consumeApprovalJti(jti, expiresAtMs, nowMs);
        recordConsumedInMemory(jti, expiresAtMs, nowMs);
        return newlyConsumed;
      }
      recordConsumedInMemory(jti, expiresAtMs, nowMs);
      return true;
    } finally {
      inFlightJtis.delete(jti);
    }
  }

  return {
    async issue(params) {
      const expiresAtMs = params.nowMs + params.ttlMs;
      const payload: SignedApprovalPayload = {
        jti: randomBytes(16).toString("base64url"),
        approverIssuer: params.approverIssuer,
        approverPrincipalId: params.approverPrincipalId,
        instanceUrl: params.instanceUrl,
        proposalId: params.proposalId,
        revision: params.revision,
        bugId: params.bugId,
        baseVersion: params.baseVersion,
        diffHash: sha256Hex(canonicalJson(params.diff)),
        visibility: params.visibility,
        expiresAtMs,
      };
      const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      const sig = signPayload(signingSecret, encoded);
      return {
        token: `${encoded}.${sig}`,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },

    async verifySignatureAndBinding(
      token: string,
      expected: CloudApprovalExpected,
    ): Promise<CloudApprovalPrecheckResult> {
      return verifySignatureAndBindingSync(token, expected);
    },

    consumeVerifiedJti,

    async verifyAndConsume(
      token: string,
      expected: CloudApprovalExpected,
    ): Promise<CloudApprovalVerificationResult> {
      const precheck = verifySignatureAndBindingSync(token, expected);
      if (!precheck.valid) {
        return precheck;
      }
      const consumed = await consumeVerifiedJti(precheck.jti, precheck.expiresAtMs, expected.nowMs);
      if (!consumed) {
        return { valid: false, reason: "replayed" };
      }
      return { valid: true };
    },
  };
}
