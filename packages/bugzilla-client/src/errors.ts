import type { EffectCertainty } from "@bugzilla-mcp/contracts";
import { Data, Predicate } from "effect";

/**
 * Redacts Bugzilla API keys and URL query strings from any upstream or transport error string
 * so credentials never leak into logs, tool errors, or UI surfaces.
 */
export function redactErrorMessage(raw: string, secrets: readonly string[] = []): string {
  let out = raw;
  for (const secret of secrets) {
    if (secret.length > 0) {
      out = out.split(secret).join("[REDACTED]");
    }
  }
  // Redact explicit api_key query/form/JSON/header occurrences
  out = out.replace(/([?&]api_key=)[^&\s"'<>]+/gi, "$1[REDACTED]");
  out = out.replace(/("api_key"\s*:\s*")[^"]*(")/gi, "$1[REDACTED]$2");
  out = out.replace(/(X-BUGZILLA-API-KEY\s*[:=]\s*)[^\s,;'"<>]+/gi, "$1[REDACTED]");
  // Strip any remaining query string on http(s) URLs so query-fallback keys or params never leak
  out = out.replace(/(https?:\/\/[^\s"'<>?#]+)\?[^\s"'<>#]+/gi, "$1?[REDACTED]");
  return out;
}

export class BugzillaValidationError extends Data.TaggedError("BugzillaValidationError")<{
  readonly httpStatus: number;
  readonly bzErrorCode?: number;
  readonly bzMessage: string;
  readonly missingFields?: readonly string[];
  readonly fieldHints?: Readonly<Record<string, readonly string[]>>;
}> {
  readonly effectCertainty = "none" as const;

  override get message(): string {
    return this.bzMessage;
  }
}

export class BugzillaCredentialRevokedError extends Data.TaggedError(
  "BugzillaCredentialRevokedError",
)<{
  readonly httpStatus?: number;
  readonly bzErrorCode?: number;
  readonly bzMessage?: string;
}> {
  readonly effectCertainty = "none" as const;

  override get message(): string {
    return this.bzMessage ?? "Bugzilla API key invalid or revoked";
  }
}

export class BugzillaAccessDeniedError extends Data.TaggedError("BugzillaAccessDeniedError")<{
  readonly httpStatus?: number;
  readonly bzErrorCode?: number;
  readonly bzMessage?: string;
}> {
  readonly effectCertainty = "none" as const;

  override get message(): string {
    return this.bzMessage ?? "Bugzilla resource not found or inaccessible";
  }
}

export class BugzillaRateLimitError extends Data.TaggedError("BugzillaRateLimitError")<{
  readonly retryAfterMs?: number;
  readonly bzMessage?: string;
}> {
  readonly effectCertainty = "none" as const;
  readonly httpStatus = 429 as const;

  override get message(): string {
    return this.bzMessage ?? "Bugzilla API rate limit exceeded (HTTP 429)";
  }
}

export class BugzillaUnsupportedAttachmentError extends Data.TaggedError(
  "BugzillaUnsupportedAttachmentError",
)<{
  readonly contentType?: string;
  readonly sizeBytes?: number;
  readonly message: string;
}> {
  readonly effectCertainty = "none" as const;
}

export class BugzillaTransientError extends Data.TaggedError("BugzillaTransientError")<{
  readonly effectCertainty: EffectCertainty;
  readonly httpStatus?: number;
  readonly bzErrorCode?: number;
  readonly message: string;
}> {}

export type BugzillaClientError =
  | BugzillaValidationError
  | BugzillaCredentialRevokedError
  | BugzillaAccessDeniedError
  | BugzillaRateLimitError
  | BugzillaUnsupportedAttachmentError
  | BugzillaTransientError;

const BUGZILLA_CLIENT_ERROR_TAGS: ReadonlySet<string> = new Set([
  "BugzillaValidationError",
  "BugzillaCredentialRevokedError",
  "BugzillaAccessDeniedError",
  "BugzillaRateLimitError",
  "BugzillaUnsupportedAttachmentError",
  "BugzillaTransientError",
]);

export function isBugzillaClientError(u: unknown): u is BugzillaClientError {
  return (
    Predicate.isObject(u) &&
    "_tag" in u &&
    Predicate.isString(u._tag) &&
    BUGZILLA_CLIENT_ERROR_TAGS.has(u._tag)
  );
}
