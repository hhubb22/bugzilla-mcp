import { Effect } from "effect";
import {
  BugzillaAccessDeniedError,
  type BugzillaClientError,
  BugzillaCredentialRevokedError,
  BugzillaRateLimitError,
  BugzillaTransientError,
  BugzillaValidationError,
  redactErrorMessage,
} from "./errors.js";

export type BugzillaHttpMethod = "GET" | "POST" | "PUT";

export interface RawHttpResponse<T> {
  readonly status: number;
  readonly data: T | null;
  readonly parseOk: boolean;
  readonly bzError: boolean;
  readonly bzErrorCode?: number;
  readonly bzMessage?: string;
  readonly retryAfterMs?: number;
}

const CREDENTIAL_REVOKED_CODES: ReadonlySet<number> = new Set([300, 306, 410]);
const ACCESS_DENIED_CODES: ReadonlySet<number> = new Set([101, 102, 110, 111, 505]);
export const PRIVATE_COMMENT_DENIED_CODE = 113;

export function parseRetryAfterMs(
  headerValue: string | null | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
    return undefined;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - nowMs);
  }
  return undefined;
}

const MISSING_FIELD_PATTERNS: readonly RegExp[] = [
  /must\s+(?:select\/enter|enter|specify|provide)\s+(?:a\s+|an\s+)?(product|component|version|summary|description|severity|priority|op_sys|platform|resolution|status|target_milestone|assigned_to)\b/gi,
  /(?:a\s+|the\s+)?(product|component|version|summary|description|severity|priority|op_sys|platform|resolution|status|target_milestone|assigned_to)\s+(?:must be specified|is required|cannot be empty)/gi,
  /field\s+['"`]?([a-z][a-z0-9_]+)['"`]?\s+(?:is required|is mandatory|must be set|cannot be empty|must be filled)/gi,
  /the\s+['"`]([a-z][a-z0-9_]+)['"`]\s+field\s+(?:is required|is mandatory|must be set|cannot be empty)/gi,
  /value must be set for\s+(?:the\s+)?['"`]?([a-z][a-z0-9_]+)['"`]?\s+field/gi,
  /there is no\s+(product|component|version)\s+named/gi,
];

const MISSING_FIELD_LIST_PATTERN = /missing required field(?:s)?\s*[:=]\s*([a-z0-9_,\s]+)/i;

export function extractMissingFields(bzMessage: string | undefined): readonly string[] | undefined {
  if (!bzMessage) return undefined;
  const found: string[] = [];
  const seen = new Set<string>();
  const add = (rawField: string) => {
    const normalized = rawField.trim().toLowerCase();
    if (normalized.length > 0 && !seen.has(normalized)) {
      seen.add(normalized);
      found.push(normalized);
    }
  };

  for (const pattern of MISSING_FIELD_PATTERNS) {
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(bzMessage)) !== null) {
      if (match[1]) add(match[1]);
    }
  }

  const listMatch = MISSING_FIELD_LIST_PATTERN.exec(bzMessage);
  if (listMatch?.[1]) {
    for (const part of listMatch[1].split(",")) {
      const token = part.trim().split(/\s+/)[0];
      if (token && /^[a-z][a-z0-9_]*$/i.test(token)) {
        add(token);
      }
    }
  }

  return found.length > 0 ? found : undefined;
}

const INSIDER_REJECTION_RE =
  /(?:insider\s*group|insider\s+privileges?|not\s+allowed\s+to\s+(?:make|mark|add|post).*private\s+comment|cannot\s+(?:make|mark|add|post).*private\s+comment)/i;

export function isPrivateCommentRejection(
  err: BugzillaAccessDeniedError | BugzillaValidationError,
): boolean {
  if (err.bzErrorCode === PRIVATE_COMMENT_DENIED_CODE) return true;
  if (err.bzMessage !== undefined && INSIDER_REJECTION_RE.test(err.bzMessage)) return true;
  return false;
}

/**
 * Single authoritative HTTP + Bugzilla error-body classifier.
 *
 * Guarantees explicit `effectCertainty` ("none" vs "uncertain") and redacts
 * API keys / query strings from every error message.
 */
export function classifyResponse<T>(
  method: BugzillaHttpMethod,
  resp: RawHttpResponse<T>,
  secrets: readonly string[] = [],
): Effect.Effect<T, BugzillaClientError> {
  const isWrite = method !== "GET";
  const redactedMsg =
    resp.bzMessage !== undefined ? redactErrorMessage(resp.bzMessage, secrets) : undefined;

  if (!resp.parseOk) {
    if (resp.status === 401) {
      return Effect.fail(new BugzillaCredentialRevokedError({ httpStatus: 401 }));
    }
    if (resp.status === 429) {
      return Effect.fail(
        new BugzillaRateLimitError(
          resp.retryAfterMs !== undefined ? { retryAfterMs: resp.retryAfterMs } : {},
        ),
      );
    }
    if (resp.status === 403 || resp.status === 404) {
      return Effect.fail(new BugzillaAccessDeniedError({ httpStatus: resp.status }));
    }
    if (resp.status === 400 || resp.status === 422) {
      return Effect.fail(
        new BugzillaValidationError({
          httpStatus: resp.status,
          bzMessage: `Bugzilla rejected request with non-JSON response (HTTP ${resp.status})`,
        }),
      );
    }
    return Effect.fail(
      new BugzillaTransientError({
        effectCertainty: isWrite ? "uncertain" : "none",
        httpStatus: resp.status,
        message: `Bugzilla returned malformed JSON response (HTTP ${resp.status})`,
      }),
    );
  }

  // Credential revoked: HTTP 401 OR Bugzilla codes 300, 306, 410 (even inside HTTP 200 {error:true})
  if (
    resp.status === 401 ||
    (resp.bzErrorCode !== undefined && CREDENTIAL_REVOKED_CODES.has(resp.bzErrorCode))
  ) {
    return Effect.fail(
      new BugzillaCredentialRevokedError({
        httpStatus: resp.status,
        ...(resp.bzErrorCode !== undefined ? { bzErrorCode: resp.bzErrorCode } : {}),
        ...(redactedMsg !== undefined ? { bzMessage: redactedMsg } : {}),
      }),
    );
  }

  // Rate limited: HTTP 429
  if (resp.status === 429) {
    return Effect.fail(
      new BugzillaRateLimitError({
        ...(resp.retryAfterMs !== undefined ? { retryAfterMs: resp.retryAfterMs } : {}),
        ...(redactedMsg !== undefined ? { bzMessage: redactedMsg } : {}),
      }),
    );
  }

  // Access denied by Bugzilla error code (101, 102, 110, 111, 505, 113)
  if (
    resp.bzErrorCode !== undefined &&
    (ACCESS_DENIED_CODES.has(resp.bzErrorCode) || resp.bzErrorCode === PRIVATE_COMMENT_DENIED_CODE)
  ) {
    return Effect.fail(
      new BugzillaAccessDeniedError({
        httpStatus: resp.status,
        bzErrorCode: resp.bzErrorCode,
        ...(redactedMsg !== undefined ? { bzMessage: redactedMsg } : {}),
      }),
    );
  }

  // Deterministic validation rejection: 400 / 422 OR HTTP 200 { error: true, ... }
  if (
    resp.status === 400 ||
    resp.status === 422 ||
    (resp.bzError && resp.status < 500 && resp.status !== 403 && resp.status !== 404)
  ) {
    const bzMessage = redactedMsg ?? `Bugzilla rejected request (HTTP ${resp.status})`;
    const missingFields = extractMissingFields(redactedMsg);
    return Effect.fail(
      new BugzillaValidationError({
        httpStatus: resp.status,
        ...(resp.bzErrorCode !== undefined ? { bzErrorCode: resp.bzErrorCode } : {}),
        bzMessage,
        ...(missingFields !== undefined ? { missingFields } : {}),
      }),
    );
  }

  // HTTP 403 / 404 (including stock Bugzilla 5.0/5.2 404 code 32614 on /rest/whoami)
  if (resp.status === 403 || resp.status === 404) {
    return Effect.fail(
      new BugzillaAccessDeniedError({
        httpStatus: resp.status,
        ...(resp.bzErrorCode !== undefined ? { bzErrorCode: resp.bzErrorCode } : {}),
        ...(redactedMsg !== undefined ? { bzMessage: redactedMsg } : {}),
      }),
    );
  }

  // Server errors / unexpected non-2xx outside 4xx -> transient
  if (resp.status >= 500 || resp.status < 200 || resp.status >= 300) {
    if (resp.status >= 400 && resp.status < 500) {
      return Effect.fail(
        new BugzillaValidationError({
          httpStatus: resp.status,
          ...(resp.bzErrorCode !== undefined ? { bzErrorCode: resp.bzErrorCode } : {}),
          bzMessage: redactedMsg ?? `Bugzilla rejected request (HTTP ${resp.status})`,
        }),
      );
    }
    return Effect.fail(
      new BugzillaTransientError({
        effectCertainty: isWrite ? "uncertain" : "none",
        httpStatus: resp.status,
        ...(resp.bzErrorCode !== undefined ? { bzErrorCode: resp.bzErrorCode } : {}),
        message: redactedMsg ?? `Bugzilla upstream transient failure (HTTP ${resp.status})`,
      }),
    );
  }

  if (resp.data === null) {
    return Effect.fail(
      new BugzillaTransientError({
        effectCertainty: isWrite ? "uncertain" : "none",
        httpStatus: resp.status,
        message: `Bugzilla returned an empty response body (HTTP ${resp.status})`,
      }),
    );
  }

  return Effect.succeed(resp.data);
}
