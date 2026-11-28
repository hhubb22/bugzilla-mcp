import type { BugSummary, WriteGuardOutcome } from "@bugzilla-mcp/contracts";

export interface McpToolContentItem {
  readonly type?: string;
  readonly text?: string;
}

export interface RawMcpToolResult {
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
  readonly content?: readonly McpToolContentItem[];
}

export type AuthErrorKind = "credential_binding_required" | "credential_revoked";

export type UnwrappedToolResult<T = Record<string, unknown>> =
  | {
      readonly ok: true;
      readonly data: T;
      readonly text?: string;
    }
  | {
      readonly ok: false;
      readonly kind: AuthErrorKind;
      readonly code: string;
      readonly message: string;
      readonly bindUrl?: string;
      readonly structured?: Record<string, unknown>;
    }
  | {
      readonly ok: false;
      readonly kind: "error";
      readonly code?: string;
      readonly message: string;
      readonly retryable?: boolean;
      readonly bzErrorCode?: number;
      readonly missingFields?: readonly string[];
      readonly fieldHints?: Readonly<Record<string, readonly string[]>>;
      readonly remediationHint?: string;
      readonly structured?: Record<string, unknown>;
    };

export interface LatestBugSnapshotView {
  readonly summary: string;
  readonly status: string;
  readonly lastChangeTime: string;
}

export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;

export function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeSafeBugUrl(instanceUrl: string, bugId: number): string | null {
  if (!isSafeHttpUrl(instanceUrl)) return null;
  if (!Number.isSafeInteger(bugId) || bugId <= 0) return null;
  const base = instanceUrl.replace(/\/+$/, "");
  const candidate = `${base}/show_bug.cgi?id=${Math.trunc(bugId)}`;
  return isSafeHttpUrl(candidate) ? candidate : null;
}

export function createBoundedIdempotencyKey(
  decision: "approve" | "reject",
  proposalId: string,
  revision: number,
  nonce?: string,
): string {
  const safeNonce =
    nonce && nonce.trim().length > 0
      ? nonce
          .trim()
          .replace(/[^a-zA-Z0-9_-]/g, "")
          .slice(0, 24)
      : generateAttemptNonce();
  const safeRevision = Number.isInteger(revision) && revision > 0 ? revision : 1;
  const prefix = `ui-${decision}-`;
  const suffix = `-r${safeRevision}-${safeNonce}`;
  const maxIdLen = Math.max(1, MAX_IDEMPOTENCY_KEY_LENGTH - prefix.length - suffix.length);
  const sanitizedProposal = proposalId.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, maxIdLen);
  return `${prefix}${sanitizedProposal || "p"}${suffix}`.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
}

function generateAttemptNonce(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  }
  const timePart = Date.now().toString(36);
  const randPart = Math.random().toString(36).slice(2, 10);
  return `${timePart}${randPart}`.slice(0, 12);
}

export function extractErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === "string" && err.trim().length > 0) {
    return err.trim();
  }
  if (err instanceof Error && err.message.trim().length > 0) {
    return err.message.trim();
  }
  if (isPlainRecord(err)) {
    if (typeof err.message === "string" && err.message.trim().length > 0) {
      return err.message.trim();
    }
    if (typeof err.reason === "string" && err.reason.trim().length > 0) {
      return err.reason.trim();
    }
    if (typeof err.bzMessage === "string" && err.bzMessage.trim().length > 0) {
      return err.bzMessage.trim();
    }
  }
  return fallback;
}

export function unwrapToolResult<T = Record<string, unknown>>(
  raw: unknown,
): UnwrappedToolResult<T> {
  if (!isPlainRecord(raw)) {
    return {
      ok: false,
      kind: "error",
      message: "Empty or malformed tool response from server.",
    };
  }

  const res = raw as RawMcpToolResult;
  const textContent = extractFirstTextContent(res.content);
  const structuredFromField = isPlainRecord(res.structuredContent)
    ? res.structuredContent
    : undefined;
  const structuredFromText =
    structuredFromField === undefined && textContent !== undefined
      ? tryParseJsonRecord(textContent)
      : undefined;
  const structured = structuredFromField ?? structuredFromText;

  const authError = detectAuthError(structured, textContent);
  if (authError) {
    return authError;
  }

  const isExplicitError =
    res.isError === true || (structured !== undefined && structured.error === true);

  if (isExplicitError) {
    return buildToolErrorResult(structured, textContent);
  }

  if (structured !== undefined) {
    return {
      ok: true,
      data: structured as T,
      ...(textContent !== undefined ? { text: textContent } : {}),
    };
  }

  return {
    ok: false,
    kind: "error",
    message: textContent ?? "Tool returned no structured content.",
  };
}

export function extractWriteGuardOutcome(
  result: UnwrappedToolResult<Record<string, unknown>>,
): WriteGuardOutcome | null {
  const candidate = result.ok ? result.data : result.structured;
  if (!isPlainRecord(candidate) || typeof candidate.outcome !== "string") {
    return null;
  }
  return candidate as unknown as WriteGuardOutcome;
}

export function extractLatestSnapshotView(
  snapshot: unknown,
  fallbackLastChangeTime: string,
): LatestBugSnapshotView | undefined {
  if (!isPlainRecord(snapshot)) return undefined;
  const bug = snapshot as Partial<BugSummary>;
  const summary = typeof bug.summary === "string" ? bug.summary : undefined;
  const status = typeof bug.status === "string" ? bug.status : undefined;
  const lastChangeTime =
    typeof bug.lastChangeTime === "string" && bug.lastChangeTime.length > 0
      ? bug.lastChangeTime
      : fallbackLastChangeTime;
  if (summary === undefined && status === undefined) return undefined;
  return {
    summary: summary ?? "(summary unavailable)",
    status: status ?? "(status unavailable)",
    lastChangeTime,
  };
}

export function formatUpstreamRejectedMessage(payload: {
  readonly reason?: string;
  readonly bzMessage?: string;
  readonly message?: string;
  readonly bzErrorCode?: number;
  readonly missingFields?: readonly string[];
  readonly fieldHints?: Readonly<Record<string, readonly string[]>>;
  readonly remediationHint?: string;
}): string {
  const parts: string[] = [];
  const primary =
    payload.reason ?? payload.bzMessage ?? payload.message ?? "Bugzilla rejected the update.";
  const codeSuffix =
    typeof payload.bzErrorCode === "number" ? ` (Bugzilla error ${payload.bzErrorCode})` : "";
  parts.push(`${primary}${codeSuffix}`);

  if (Array.isArray(payload.missingFields) && payload.missingFields.length > 0) {
    parts.push(`Missing fields: ${payload.missingFields.join(", ")}.`);
  }

  if (payload.fieldHints && isPlainRecord(payload.fieldHints)) {
    const hintEntries = Object.entries(payload.fieldHints)
      .filter(([, vals]) => Array.isArray(vals) && vals.length > 0)
      .map(([field, vals]) => `${field}: ${(vals as readonly string[]).slice(0, 6).join(", ")}`);
    if (hintEntries.length > 0) {
      parts.push(`Allowed values — ${hintEntries.join("; ")}.`);
    }
  }

  if (typeof payload.remediationHint === "string" && payload.remediationHint.trim().length > 0) {
    parts.push(payload.remediationHint.trim());
  }

  return parts.join(" ");
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractFirstTextContent(
  content: readonly McpToolContentItem[] | undefined,
): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const item of content) {
    if (item && typeof item.text === "string" && item.text.trim().length > 0) {
      return item.text.trim();
    }
  }
  return undefined;
}

function tryParseJsonRecord(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function detectAuthError(
  structured: Record<string, unknown> | undefined,
  textContent: string | undefined,
): Extract<UnwrappedToolResult<never>, { readonly kind: AuthErrorKind }> | null {
  const rawCode =
    typeof structured?.code === "string"
      ? structured.code
      : typeof structured?._tag === "string"
        ? structured._tag
        : undefined;
  const normalizedCode = rawCode?.toLowerCase();

  let kind: AuthErrorKind | null = null;
  if (
    normalizedCode === "credential_binding_required" ||
    normalizedCode === "credentialbindingrequired" ||
    structured?.unbound === true
  ) {
    kind = "credential_binding_required";
  } else if (normalizedCode === "credential_revoked" || normalizedCode === "credentialrevoked") {
    kind = "credential_revoked";
  } else if (textContent !== undefined) {
    if (/\b(CredentialBindingRequired|credential_binding_required)\b/i.test(textContent)) {
      kind = "credential_binding_required";
    } else if (/\b(CredentialRevoked|credential_revoked)\b/i.test(textContent)) {
      kind = "credential_revoked";
    }
  }

  if (!kind) return null;

  const rawBindUrl = structured?.bindUrl ?? structured?.bindingUrl;
  const bindUrl = isSafeHttpUrl(rawBindUrl) ? rawBindUrl : undefined;
  const defaultMsg =
    kind === "credential_revoked"
      ? "Your Bugzilla API key was revoked or rejected. Re-bind a valid API key to continue."
      : "Bind your Bugzilla API key via the HTTPS binding page to load your authorized queue.";
  const message =
    typeof structured?.message === "string" && structured.message.trim().length > 0
      ? structured.message.trim()
      : (textContent ?? defaultMsg);

  return {
    ok: false,
    kind,
    code: rawCode ?? kind,
    message,
    ...(bindUrl !== undefined ? { bindUrl } : {}),
    ...(structured !== undefined ? { structured } : {}),
  };
}

function buildToolErrorResult(
  structured: Record<string, unknown> | undefined,
  textContent: string | undefined,
): Extract<UnwrappedToolResult<never>, { readonly kind: "error" }> {
  const code =
    typeof structured?.code === "string"
      ? structured.code
      : typeof structured?.outcome === "string"
        ? structured.outcome
        : undefined;

  const missingFields = Array.isArray(structured?.missingFields)
    ? structured.missingFields.filter((v): v is string => typeof v === "string")
    : undefined;

  const fieldHints = isPlainRecord(structured?.fieldHints)
    ? Object.fromEntries(
        Object.entries(structured.fieldHints)
          .filter(([, v]) => Array.isArray(v))
          .map(([k, v]) => [k, (v as unknown[]).filter((s): s is string => typeof s === "string")]),
      )
    : undefined;

  const remediationHint =
    typeof structured?.remediationHint === "string" && structured.remediationHint.trim().length > 0
      ? structured.remediationHint.trim()
      : undefined;

  const bzErrorCode =
    typeof structured?.bzErrorCode === "number" ? structured.bzErrorCode : undefined;

  let message: string;
  if (code === "upstream_rejected" || code === "UpstreamRejected") {
    message = formatUpstreamRejectedMessage({
      ...(typeof structured?.reason === "string" ? { reason: structured.reason } : {}),
      ...(typeof structured?.bzMessage === "string" ? { bzMessage: structured.bzMessage } : {}),
      ...(typeof structured?.message === "string" ? { message: structured.message } : {}),
      ...(bzErrorCode !== undefined ? { bzErrorCode } : {}),
      ...(missingFields !== undefined ? { missingFields } : {}),
      ...(fieldHints !== undefined ? { fieldHints } : {}),
      ...(remediationHint !== undefined ? { remediationHint } : {}),
    });
  } else if (typeof structured?.message === "string" && structured.message.trim().length > 0) {
    message = structured.message.trim();
  } else if (
    typeof structured?.reconciliationHint === "string" &&
    structured.reconciliationHint.trim().length > 0
  ) {
    message = structured.reconciliationHint.trim();
  } else if (typeof structured?.reason === "string" && structured.reason.trim().length > 0) {
    message = structured.reason.trim();
  } else if (textContent !== undefined) {
    message = textContent;
  } else {
    message = code ? `Tool call failed (${code}).` : "Tool call failed.";
  }

  return {
    ok: false,
    kind: "error",
    ...(code !== undefined ? { code } : {}),
    message,
    ...(typeof structured?.retryable === "boolean" ? { retryable: structured.retryable } : {}),
    ...(bzErrorCode !== undefined ? { bzErrorCode } : {}),
    ...(missingFields !== undefined ? { missingFields } : {}),
    ...(fieldHints !== undefined ? { fieldHints } : {}),
    ...(remediationHint !== undefined ? { remediationHint } : {}),
    ...(structured !== undefined ? { structured } : {}),
  };
}
