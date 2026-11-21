import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { canonicalJson, sha256Hex } from "./canonical.js";
import type {
  CloudApprovalExpected,
  CloudApprovalTokenService,
  CloudApprovalVerificationResult,
} from "./index.js";

interface SignedApprovalPayload {
  readonly jti: string;
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

function signPayload(secret: string, encodedPayload: string): string {
  return createHmac("sha256", secret).update(encodedPayload, "utf8").digest("base64url");
}

export function buildCloudApprovalTokenService(signingSecret: string): CloudApprovalTokenService {
  const consumedJtis = new Set<string>();

  return {
    async issue(params) {
      const expiresAtMs = params.nowMs + params.ttlMs;
      const payload: SignedApprovalPayload = {
        jti: randomBytes(16).toString("base64url"),
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

    async verifyAndConsume(
      token: string,
      expected: CloudApprovalExpected,
    ): Promise<CloudApprovalVerificationResult> {
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

      if (expected.nowMs > payload.expiresAtMs) {
        return { valid: false, reason: "expired" };
      }

      if (payload.visibility !== expected.visibility) {
        return { valid: false, reason: "visibility_mismatch" };
      }

      const expectedDiffHash = sha256Hex(canonicalJson(expected.diff));
      const bindingMatches =
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

      // Synchronous check-and-mark guarantees single-use under concurrent Promise.all
      if (consumedJtis.has(payload.jti)) {
        return { valid: false, reason: "replayed" };
      }
      consumedJtis.add(payload.jti);
      return { valid: true };
    },
  };
}
