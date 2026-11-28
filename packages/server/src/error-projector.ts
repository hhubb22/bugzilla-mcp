import {
  isBugzillaClientError,
  redactErrorMessage,
  type BugzillaClientError,
} from "@bugzilla-mcp/bugzilla-client";
import {
  AccessDenied,
  CredentialBindingRequired,
  CredentialRevoked,
  domainErrorToToolPayload,
  isDomainError,
  McpErrorCode,
  UnsupportedAttachment,
  UpstreamRejected,
  UpstreamTransient,
  type DomainError,
  type ToolErrorPayload,
  type WriteGuardOutcome,
} from "@bugzilla-mcp/contracts";
import { McpDomainError } from "@bugzilla-mcp/core";
import { StorageError } from "@bugzilla-mcp/storage";

export const INDISTINGUISHABLE_RESOURCE_ERROR = {
  code: McpErrorCode.INVALID_PARAMS,
  message: "Resource not found or inaccessible",
} as const;

export interface ToolTextContent {
  readonly type: "text";
  readonly text: string;
}

export type ToolDispatchOutcome =
  | {
      readonly kind: "ok";
      readonly isError?: false;
      readonly content: readonly ToolTextContent[];
      readonly structuredContent: unknown;
    }
  | {
      readonly kind: "tool_error";
      readonly isError: true;
      readonly content: readonly ToolTextContent[];
      readonly structuredContent: unknown;
    }
  | {
      readonly kind: "rpc_error";
      readonly code: number;
      readonly message: string;
      readonly data?: unknown;
    };

export type ResourceReadOutcome =
  | {
      readonly kind: "ok";
      readonly ttlMs: number;
      readonly cacheScope: "public" | "private";
      readonly contents: readonly {
        readonly uri: string;
        readonly mimeType: string;
        readonly text: string;
        readonly _meta?: Record<string, unknown>;
      }[];
    }
  | {
      readonly kind: "rpc_error";
      readonly code: number;
      readonly message: string;
      readonly data?: unknown;
    };

export interface ProjectedRpcError {
  readonly httpStatus: number;
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * Convert a typed `BugzillaClientError` into the closed `DomainError` union.
 * Preserves `effectCertainty`, `bzErrorCode`, `missingFields`, and `fieldHints`
 * while redacting any sensitive URL query parameters or API key fragments.
 */
export function bugzillaClientErrorToDomainError(error: BugzillaClientError): DomainError {
  switch (error._tag) {
    case "BugzillaValidationError": {
      const bzMessage = redactErrorMessage(error.bzMessage);
      const remediationHint =
        error.missingFields && error.missingFields.length > 0
          ? `Provide valid values for: ${error.missingFields.join(", ")}.`
          : `Adjust the request to satisfy Bugzilla validation: ${bzMessage}`;
      return new UpstreamRejected({
        httpStatus: error.httpStatus,
        ...(error.bzErrorCode !== undefined ? { bzErrorCode: error.bzErrorCode } : {}),
        bzMessage,
        ...(error.missingFields !== undefined ? { missingFields: error.missingFields } : {}),
        ...(error.fieldHints !== undefined ? { fieldHints: error.fieldHints } : {}),
        remediationHint,
      });
    }
    case "BugzillaCredentialRevokedError":
      return new CredentialRevoked({
        message: `CredentialRevoked: ${redactErrorMessage(error.message)}`,
        ...(error.bzErrorCode !== undefined ? { bzErrorCode: error.bzErrorCode } : {}),
      });
    case "BugzillaAccessDeniedError":
      return new AccessDenied({
        message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
      });
    case "BugzillaRateLimitError":
      return new UpstreamTransient({
        message: redactErrorMessage(error.message),
        effectCertainty: "none",
        upstreamHttpStatus: 429,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      });
    case "BugzillaUnsupportedAttachmentError":
      return new UnsupportedAttachment({
        message: redactErrorMessage(error.message),
        ...(error.contentType !== undefined ? { contentType: error.contentType } : {}),
        ...(error.sizeBytes !== undefined ? { sizeBytes: error.sizeBytes } : {}),
      });
    case "BugzillaTransientError":
      return new UpstreamTransient({
        message: redactErrorMessage(error.message),
        effectCertainty: error.effectCertainty,
        ...(error.httpStatus !== undefined ? { upstreamHttpStatus: error.httpStatus } : {}),
      });
  }
}

/**
 * Format a `DomainError` into complete, actionable plain text for `content[0].text`
 * so both LLM callers and MCP clients that ignore `structuredContent` on `isError: true`
 * receive every validation issue, missing field, hint, or remediation instruction.
 */
export function formatDomainErrorText(error: DomainError): string {
  switch (error._tag) {
    case "InvalidToolInput": {
      const issueLines = error.issues.map(
        (issue) => `- ${issue.path} (${issue.code}): ${issue.message}`,
      );
      return issueLines.length > 0
        ? `${error.message}\nIssues:\n${issueLines.join("\n")}`
        : error.message;
    }
    case "UpstreamRejected": {
      const parts: string[] = [
        error.bzErrorCode !== undefined
          ? `UpstreamRejected (Bugzilla error ${error.bzErrorCode}): ${error.bzMessage}`
          : `UpstreamRejected: ${error.bzMessage}`,
      ];
      if (error.missingFields && error.missingFields.length > 0) {
        parts.push(`Missing fields: ${error.missingFields.join(", ")}.`);
      }
      if (error.fieldHints) {
        const hints = Object.entries(error.fieldHints)
          .filter(([, vals]) => vals.length > 0)
          .map(([field, vals]) => `${field}: ${vals.slice(0, 10).join(", ")}`);
        if (hints.length > 0) {
          parts.push(`Allowed values: ${hints.join("; ")}.`);
        }
      }
      if (error.remediationHint) {
        parts.push(error.remediationHint);
      }
      return parts.join(" ");
    }
    case "CredentialBindingRequired":
      return error.bindUrl
        ? `CredentialBindingRequired: ${error.message} Binding URL: ${error.bindUrl}`
        : `CredentialBindingRequired: ${error.message}`;
    case "CredentialRevoked":
      return error.bzErrorCode !== undefined
        ? `CredentialRevoked (Bugzilla error ${error.bzErrorCode}): ${error.message}`
        : error.message.includes("CredentialRevoked")
          ? error.message
          : `CredentialRevoked: ${error.message}`;
    case "AccessDenied":
      return INDISTINGUISHABLE_RESOURCE_ERROR.message;
    case "UpstreamTransient": {
      const retry = error.retryAfterMs !== undefined ? ` Retry after ${error.retryAfterMs}ms.` : "";
      return `UpstreamTransient (effectCertainty=${error.effectCertainty}): ${error.message}.${retry}`;
    }
    case "UnsupportedAttachment": {
      const meta: string[] = [];
      if (error.contentType) meta.push(`contentType=${error.contentType}`);
      if (error.sizeBytes !== undefined) meta.push(`sizeBytes=${error.sizeBytes}`);
      return meta.length > 0
        ? `UnsupportedAttachment (${meta.join(", ")}): ${error.message}`
        : `UnsupportedAttachment: ${error.message}`;
    }
    case "WebhookConfigurationError":
      return `WebhookConfigurationError (${error.reason}): ${error.message}`;
  }
}

export function isActionableWriteGuardFailure(outcome: WriteGuardOutcome): boolean {
  switch (outcome.outcome) {
    case "Applied":
    case "SavedAsInternalNote":
    case "DuplicateNoOp":
    case "ProposalPending":
    case "ProposalRejected":
      return false;
    case "UpstreamRejected":
    case "StaleBugConflict":
    case "IdempotencyConflict":
    case "OperationPending":
    case "OperationIndeterminate":
    case "CausalBudgetExhausted":
      return true;
  }
}

export function formatWriteGuardFailureText(outcome: WriteGuardOutcome): string {
  switch (outcome.outcome) {
    case "UpstreamRejected": {
      const parts: string[] = [
        outcome.bzErrorCode !== undefined
          ? `UpstreamRejected (Bugzilla error ${outcome.bzErrorCode}): ${outcome.reason}`
          : `UpstreamRejected: ${outcome.reason}`,
      ];
      if (outcome.missingFields && outcome.missingFields.length > 0) {
        parts.push(`Missing fields: ${outcome.missingFields.join(", ")}.`);
      }
      if (outcome.fieldHints) {
        const hints = Object.entries(outcome.fieldHints)
          .filter(([, vals]) => vals.length > 0)
          .map(([field, vals]) => `${field}: ${vals.slice(0, 10).join(", ")}`);
        if (hints.length > 0) {
          parts.push(`Allowed values: ${hints.join("; ")}.`);
        }
      }
      parts.push(outcome.remediationHint);
      return parts.join(" ");
    }
    case "StaleBugConflict":
      return `StaleBugConflict: Expected last_change_time ${outcome.expectedLastChangeTime} but Bug #${outcome.latestAuthorizedSnapshot.id} was updated at ${outcome.actualLastChangeTime} (status: ${outcome.latestAuthorizedSnapshot.status}, summary: ${outcome.latestAuthorizedSnapshot.summary}). Refresh the dossier and re-propose against the latest timestamp.`;
    case "IdempotencyConflict":
      return `IdempotencyConflict: Idempotency key "${outcome.idempotencyKey}" was already used with a different request payload. Generate a fresh idempotencyKey for a new operation.`;
    case "OperationPending":
      return `OperationPending: Operation for idempotency key "${outcome.idempotencyKey}" is currently in flight. Wait briefly before retrying with the same key.`;
    case "OperationIndeterminate":
      return `OperationIndeterminate (key="${outcome.idempotencyKey}"): ${outcome.reconciliationHint}`;
    case "CausalBudgetExhausted":
      return `CausalBudgetExhausted: Automated write budget exhausted for Bug #${outcome.bugId}. Retry after ${outcome.retryAfterMs}ms.`;
    default:
      return JSON.stringify(outcome);
  }
}

export function projectWriteGuardOutcome(outcome: WriteGuardOutcome): ToolDispatchOutcome {
  if (isActionableWriteGuardFailure(outcome)) {
    return {
      kind: "tool_error",
      isError: true,
      content: [{ type: "text", text: formatWriteGuardFailureText(outcome) }],
      structuredContent: outcome,
    };
  }
  return {
    kind: "ok",
    content: [{ type: "text", text: JSON.stringify(outcome) }],
    structuredContent: outcome,
  };
}

export function projectDomainErrorToToolOutcome(error: DomainError): ToolDispatchOutcome {
  // [R-32f1fc] Indistinguishable resource deny stays a protocol JSON-RPC error without distinguishing data.
  if (error._tag === "AccessDenied") {
    return {
      kind: "rpc_error",
      code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
      message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
    };
  }
  if (!error.toolExecutable) {
    return {
      kind: "rpc_error",
      code: error.rpcCode,
      message: error.message,
      data: domainErrorToToolPayload(error),
    };
  }
  const payload: ToolErrorPayload = domainErrorToToolPayload(error);
  return {
    kind: "tool_error",
    isError: true,
    content: [{ type: "text", text: formatDomainErrorText(error) }],
    structuredContent: payload,
  };
}

/**
 * Project ANY thrown error during `tools/call` into either an actionable `tool_error`
 * (`CallToolResult { isError: true }`) or a protocol `rpc_error`. Never throws.
 */
export function projectToolExecutionError(err: unknown): ToolDispatchOutcome {
  if (isDomainError(err)) {
    return projectDomainErrorToToolOutcome(err);
  }
  if (isBugzillaClientError(err)) {
    return projectDomainErrorToToolOutcome(bugzillaClientErrorToDomainError(err));
  }
  if (err instanceof McpDomainError) {
    if (err.domainError) {
      return projectDomainErrorToToolOutcome(err.domainError);
    }
    return {
      kind: "rpc_error",
      code: err.code,
      message: err.message,
      ...(err.data !== undefined ? { data: err.data } : {}),
    };
  }
  if (err instanceof StorageError) {
    return {
      kind: "rpc_error",
      code: McpErrorCode.INTERNAL_ERROR,
      message: "Internal server error",
    };
  }
  if (err instanceof Error) {
    if (err.name === "BugzillaCredentialRevokedError") {
      return projectDomainErrorToToolOutcome(
        new CredentialRevoked({ message: `CredentialRevoked: ${redactErrorMessage(err.message)}` }),
      );
    }
    if (err.name === "BugzillaUnsupportedAttachmentError") {
      return projectDomainErrorToToolOutcome(
        new UnsupportedAttachment({ message: redactErrorMessage(err.message) }),
      );
    }
    if (err.name === "BugzillaAccessDeniedError") {
      return {
        kind: "rpc_error",
        code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
        message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
      };
    }
  }
  return {
    kind: "rpc_error",
    code: McpErrorCode.INTERNAL_ERROR,
    message: "Internal server error",
  };
}

/**
 * Project ANY thrown error during `resources/read` into a JSON-RPC `rpc_error`.
 * Preserves [R-32f1fc] indistinguishability for AccessDenied while NEVER misclassifying
 * CredentialRevoked or CredentialBindingRequired as missing/restricted.
 */
export function projectResourceReadError(
  err: unknown,
): Extract<ResourceReadOutcome, { readonly kind: "rpc_error" }> {
  if (isDomainError(err)) {
    if (err._tag === "AccessDenied") {
      return {
        kind: "rpc_error",
        code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
        message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
      };
    }
    return {
      kind: "rpc_error",
      code: err.rpcCode,
      message: formatDomainErrorText(err),
      data: domainErrorToToolPayload(err),
    };
  }
  if (isBugzillaClientError(err)) {
    return projectResourceReadError(bugzillaClientErrorToDomainError(err));
  }
  if (err instanceof McpDomainError) {
    if (err.domainError) {
      return projectResourceReadError(err.domainError);
    }
    return {
      kind: "rpc_error",
      code: err.code,
      message: err.message,
      ...(err.data !== undefined ? { data: err.data } : {}),
    };
  }
  if (err instanceof StorageError) {
    return {
      kind: "rpc_error",
      code: McpErrorCode.INTERNAL_ERROR,
      message: "Internal server error",
    };
  }
  if (err instanceof Error && err.name === "BugzillaCredentialRevokedError") {
    return projectResourceReadError(
      new CredentialRevoked({ message: `CredentialRevoked: ${redactErrorMessage(err.message)}` }),
    );
  }
  return {
    kind: "rpc_error",
    code: McpErrorCode.INTERNAL_ERROR,
    message: "Internal server error",
  };
}

/**
 * Project ANY thrown error at the top-level JSON-RPC boundary (events, auth, unexpected throws).
 */
export function projectTopLevelRpcError(err: unknown): ProjectedRpcError {
  if (err instanceof McpDomainError) {
    return {
      httpStatus: err.code === McpErrorCode.INTERNAL_ERROR ? 500 : 200,
      code: err.code,
      message: err.message,
      ...(err.data !== undefined ? { data: err.data } : {}),
    };
  }
  if (isDomainError(err)) {
    if (err._tag === "AccessDenied") {
      return {
        httpStatus: 200,
        code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
        message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
      };
    }
    return {
      httpStatus: err.rpcCode === McpErrorCode.INTERNAL_ERROR ? 500 : 200,
      code: err.rpcCode,
      message: formatDomainErrorText(err),
      data: domainErrorToToolPayload(err),
    };
  }
  if (isBugzillaClientError(err)) {
    return projectTopLevelRpcError(bugzillaClientErrorToDomainError(err));
  }
  return {
    httpStatus: 500,
    code: McpErrorCode.INTERNAL_ERROR,
    message: "Internal server error",
  };
}

export function createCredentialBindingRequiredOutcome(bindUrl?: string): ToolDispatchOutcome {
  const err = new CredentialBindingRequired({
    message: "Bind your Bugzilla API key via the HTTPS binding page.",
    ...(bindUrl !== undefined ? { bindUrl } : {}),
  });
  return projectDomainErrorToToolOutcome(err);
}
