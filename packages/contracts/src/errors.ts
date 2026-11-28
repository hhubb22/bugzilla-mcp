import { Data, Effect, Result, Schema, type SchemaAST, SchemaIssue } from "effect";
import {
  McpErrorCode,
  type EffectCertainty,
  type McpErrorCodeValue,
  type SchemaValidationIssue,
  type ToolErrorPayload,
} from "./mcp-wire.js";

export type DomainErrorCode =
  | "invalid_tool_input"
  | "upstream_rejected"
  | "credential_binding_required"
  | "credential_revoked"
  | "access_denied"
  | "upstream_transient"
  | "unsupported_attachment"
  | "webhook_configuration_error";

export interface DomainErrorMetadata {
  readonly code: DomainErrorCode;
  readonly httpStatus: number;
  readonly rpcCode: McpErrorCodeValue;
  readonly toolExecutable: boolean;
  readonly retryable: boolean;
  readonly effectCertainty?: EffectCertainty;
}

export class InvalidToolInput
  extends Data.TaggedError("InvalidToolInput")<{
    readonly message: string;
    readonly issues: readonly SchemaValidationIssue[];
  }>
  implements DomainErrorMetadata
{
  readonly code = "invalid_tool_input" as const;
  readonly httpStatus = 400;
  readonly rpcCode = McpErrorCode.INVALID_PARAMS;
  readonly toolExecutable = true;
  readonly retryable = false;
  readonly effectCertainty = "none" as const;
}

export class UpstreamRejected
  extends Data.TaggedError("UpstreamRejected")<{
    readonly httpStatus: number;
    readonly bzErrorCode?: number;
    readonly bzMessage: string;
    readonly missingFields?: readonly string[];
    readonly fieldHints?: Readonly<Record<string, readonly string[]>>;
    readonly remediationHint?: string;
  }>
  implements DomainErrorMetadata
{
  readonly code = "upstream_rejected" as const;
  readonly rpcCode = McpErrorCode.INVALID_PARAMS;
  readonly toolExecutable = true;
  readonly retryable = false;
  readonly effectCertainty = "none" as const;

  override get message(): string {
    return this.bzMessage;
  }
}

export class CredentialBindingRequired
  extends Data.TaggedError("CredentialBindingRequired")<{
    readonly message: string;
    readonly bindUrl?: string;
  }>
  implements DomainErrorMetadata
{
  readonly code = "credential_binding_required" as const;
  readonly httpStatus = 401;
  readonly rpcCode = McpErrorCode.INVALID_PARAMS;
  readonly toolExecutable = true;
  readonly retryable = false;
  readonly effectCertainty = "none" as const;
}

export class CredentialRevoked
  extends Data.TaggedError("CredentialRevoked")<{
    readonly message: string;
    readonly bzErrorCode?: number;
  }>
  implements DomainErrorMetadata
{
  readonly code = "credential_revoked" as const;
  readonly httpStatus = 401;
  readonly rpcCode = McpErrorCode.INVALID_PARAMS;
  readonly toolExecutable = true;
  readonly retryable = false;
  readonly effectCertainty = "none" as const;
}

export class AccessDenied
  extends Data.TaggedError("AccessDenied")<{
    readonly message: string;
    readonly resource?: string;
  }>
  implements DomainErrorMetadata
{
  readonly code = "access_denied" as const;
  readonly httpStatus = 403;
  readonly rpcCode = McpErrorCode.INVALID_PARAMS;
  readonly toolExecutable = false;
  readonly retryable = false;
  readonly effectCertainty = "none" as const;
}

export class UpstreamTransient
  extends Data.TaggedError("UpstreamTransient")<{
    readonly message: string;
    readonly effectCertainty: EffectCertainty;
    readonly upstreamHttpStatus?: number;
    readonly retryAfterMs?: number;
  }>
  implements DomainErrorMetadata
{
  readonly code = "upstream_transient" as const;
  readonly rpcCode = McpErrorCode.INTERNAL_ERROR;
  readonly toolExecutable = true;
  readonly retryable = true;

  get httpStatus(): number {
    return this.upstreamHttpStatus ?? 503;
  }
}

export class UnsupportedAttachment
  extends Data.TaggedError("UnsupportedAttachment")<{
    readonly message: string;
    readonly contentType?: string;
    readonly sizeBytes?: number;
  }>
  implements DomainErrorMetadata
{
  readonly code = "unsupported_attachment" as const;
  readonly httpStatus = 422;
  readonly rpcCode = McpErrorCode.INVALID_PARAMS;
  readonly toolExecutable = true;
  readonly retryable = false;
  readonly effectCertainty = "none" as const;
}

export type WebhookConfigurationReason =
  | "ssrf_blocked"
  | "payload_too_large"
  | "transport_unconfigured"
  | "invalid_url"
  | "invalid_secret"
  | "invalid_filter";

export class WebhookConfigurationError
  extends Data.TaggedError("WebhookConfigurationError")<{
    readonly message: string;
    readonly reason: WebhookConfigurationReason;
  }>
  implements DomainErrorMetadata
{
  readonly code = "webhook_configuration_error" as const;
  readonly httpStatus = 400;
  readonly rpcCode = McpErrorCode.INVALID_PARAMS;
  readonly toolExecutable = false;
  readonly retryable = false;
  readonly effectCertainty = "none" as const;
}

export type DomainError =
  | InvalidToolInput
  | UpstreamRejected
  | CredentialBindingRequired
  | CredentialRevoked
  | AccessDenied
  | UpstreamTransient
  | UnsupportedAttachment
  | WebhookConfigurationError;

const DOMAIN_ERROR_TAGS: ReadonlySet<string> = new Set([
  "InvalidToolInput",
  "UpstreamRejected",
  "CredentialBindingRequired",
  "CredentialRevoked",
  "AccessDenied",
  "UpstreamTransient",
  "UnsupportedAttachment",
  "WebhookConfigurationError",
]);

export function isDomainError(u: unknown): u is DomainError {
  return (
    typeof u === "object" &&
    u !== null &&
    "_tag" in u &&
    typeof (u as { _tag?: unknown })._tag === "string" &&
    DOMAIN_ERROR_TAGS.has((u as { _tag: string })._tag)
  );
}

export const STRICT_PARSE_OPTIONS: SchemaAST.ParseOptions = {
  onExcessProperty: "error",
  errors: "all",
};

export const PASSTHROUGH_PARSE_OPTIONS: SchemaAST.ParseOptions = {
  onExcessProperty: "ignore",
  errors: "all",
};

function formatPath(segments: readonly PropertyKey[]): string {
  if (segments.length === 0) return "$";
  let out = "";
  for (const segment of segments) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (typeof segment === "symbol") {
      out += out.length > 0 ? `.${String(segment)}` : String(segment);
    } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(segment)) {
      out += out.length > 0 ? `.${segment}` : segment;
    } else {
      out += `[${JSON.stringify(segment)}]`;
    }
  }
  return out;
}

function issueCodeForLeaf(issue: SchemaIssue.Leaf): string {
  switch (issue._tag) {
    case "MissingKey":
      return "missing_key";
    case "UnexpectedKey":
      return "unexpected_key";
    case "InvalidType":
      return "invalid_type";
    case "InvalidValue":
      return "invalid_value";
    case "Forbidden":
      return "forbidden";
    case "OneOf":
      return "one_of";
  }
}

function collectIssues(
  issue: SchemaIssue.Issue,
  path: readonly PropertyKey[],
  out: SchemaValidationIssue[],
): void {
  switch (issue._tag) {
    case "Pointer":
      collectIssues(issue.issue, [...path, ...issue.path], out);
      return;
    case "Composite":
      for (const child of issue.issues) {
        collectIssues(child, path, out);
      }
      return;
    case "Encoding":
      collectIssues(issue.issue, path, out);
      return;
    case "Filter": {
      const checkMessage = SchemaIssue.defaultCheckHook(issue);
      if (checkMessage !== undefined && issue.issue._tag === "InvalidValue") {
        out.push({
          path: formatPath(path),
          code: "constraint_violation",
          message: checkMessage,
        });
        return;
      }
      collectIssues(issue.issue, path, out);
      return;
    }
    case "AnyOf": {
      if (issue.issues.length === 0) {
        out.push({
          path: formatPath(path),
          code: "invalid_union",
          message: SchemaIssue.makeFormatterDefault()(issue),
        });
        return;
      }
      // Prefer the deepest/most specific union branch issues when discriminating unions
      const childBuckets = issue.issues.map((branch) => {
        const bucket: SchemaValidationIssue[] = [];
        collectIssues(branch, path, bucket);
        return bucket;
      });
      const nonEmpty = childBuckets.filter((b) => b.length > 0);
      if (nonEmpty.length === 1) {
        out.push(...nonEmpty[0]!);
        return;
      }
      // Pick branches that matched deeper paths (discriminator matched) over shallow mismatch
      const maxDepth = Math.max(
        0,
        ...nonEmpty.map((b) => Math.max(...b.map((i) => i.path.length))),
      );
      const deepest = nonEmpty.filter((b) => b.some((i) => i.path.length === maxDepth));
      const chosen = deepest.length === 1 ? deepest[0]! : nonEmpty.flat();
      const seen = new Set<string>();
      for (const item of chosen) {
        const key = `${item.path}|${item.code}|${item.message}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(item);
        }
      }
      return;
    }
    case "MissingKey":
    case "UnexpectedKey":
    case "InvalidType":
    case "InvalidValue":
    case "Forbidden":
    case "OneOf": {
      const message =
        issue._tag === "UnexpectedKey"
          ? `Unexpected property "${String(path[path.length - 1] ?? "")}" is not allowed`
          : SchemaIssue.defaultLeafHook(issue);
      out.push({
        path: formatPath(path),
        code: issueCodeForLeaf(issue),
        message,
      });
    }
  }
}

/**
 * Convert an Effect v4 `Schema.SchemaError` or `SchemaIssue.Issue` into
 * concise, actionable `{ path, code, message }` entries for callers and LLMs.
 */
export function formatSchemaIssues(
  error: Schema.SchemaError | SchemaIssue.Issue,
): readonly SchemaValidationIssue[] {
  const rootIssue = Schema.isSchemaError(error) ? error.issue : error;
  const collected: SchemaValidationIssue[] = [];
  collectIssues(rootIssue, [], collected);
  if (collected.length === 0) {
    return [
      {
        path: "$",
        code: "invalid_value",
        message: Schema.isSchemaError(error)
          ? error.message
          : SchemaIssue.makeFormatterDefault()(error),
      },
    ];
  }
  return collected;
}

export function schemaErrorToInvalidToolInput(
  error: Schema.SchemaError,
  contextLabel?: string,
): InvalidToolInput {
  const issues = formatSchemaIssues(error);
  const summary = issues.map((i) => `${i.path}: ${i.message}`).join("; ");
  const message = contextLabel
    ? `Invalid ${contextLabel}: ${summary}`
    : `Invalid input: ${summary}`;
  return new InvalidToolInput({ message, issues });
}

export function decodeOrInvalidInputResult<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  options?: {
    readonly contextLabel?: string;
    readonly parseOptions?: SchemaAST.ParseOptions;
  },
): Result.Result<S["Type"], InvalidToolInput> {
  const decoded = Schema.decodeUnknownResult(
    schema,
    options?.parseOptions ?? STRICT_PARSE_OPTIONS,
  )(input);
  if (Result.isFailure(decoded)) {
    return Result.fail(schemaErrorToInvalidToolInput(decoded.failure, options?.contextLabel));
  }
  return Result.succeed(decoded.success);
}

export function decodeOrInvalidInput<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  input: unknown,
  options?: {
    readonly contextLabel?: string;
    readonly parseOptions?: SchemaAST.ParseOptions;
  },
): Effect.Effect<S["Type"], InvalidToolInput> {
  const result = decodeOrInvalidInputResult(schema, input, options);
  return Result.isSuccess(result) ? Effect.succeed(result.success) : Effect.fail(result.failure);
}

/** Convert a `DomainError` into a serializable `ToolErrorPayload` for `isError: true` responses. */
export function domainErrorToToolPayload(error: DomainError): ToolErrorPayload {
  switch (error._tag) {
    case "InvalidToolInput":
      return {
        error: true,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        effectCertainty: error.effectCertainty,
        issues: [...error.issues],
      };
    case "UpstreamRejected":
      return {
        error: true,
        code: error.code,
        message: error.bzMessage,
        retryable: error.retryable,
        effectCertainty: error.effectCertainty,
        ...(error.bzErrorCode !== undefined ? { bzErrorCode: error.bzErrorCode } : {}),
        ...(error.missingFields !== undefined ? { missingFields: [...error.missingFields] } : {}),
        ...(error.fieldHints !== undefined
          ? {
              fieldHints: Object.fromEntries(
                Object.entries(error.fieldHints).map(([k, v]) => [k, [...v]]),
              ),
            }
          : {}),
        ...(error.remediationHint !== undefined ? { remediationHint: error.remediationHint } : {}),
      };
    case "CredentialBindingRequired":
      return {
        error: true,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        effectCertainty: error.effectCertainty,
        ...(error.bindUrl !== undefined ? { bindUrl: error.bindUrl } : {}),
      };
    case "CredentialRevoked":
      return {
        error: true,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        effectCertainty: error.effectCertainty,
        ...(error.bzErrorCode !== undefined ? { bzErrorCode: error.bzErrorCode } : {}),
      };
    case "AccessDenied":
      return {
        error: true,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        effectCertainty: error.effectCertainty,
      };
    case "UpstreamTransient":
      return {
        error: true,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        effectCertainty: error.effectCertainty,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      };
    case "UnsupportedAttachment":
      return {
        error: true,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        effectCertainty: error.effectCertainty,
      };
    case "WebhookConfigurationError":
      return {
        error: true,
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        effectCertainty: error.effectCertainty,
      };
  }
}
