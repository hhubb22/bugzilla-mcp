import { Schema } from "effect";

export const MCP_PROTOCOL_MODERN = "2026-07-28" as const;
export const MCP_PROTOCOL_LEGACY = "2025-11-25" as const;

export const McpErrorCode = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  HEADER_MISMATCH: -32020,
  MISSING_REQUIRED_CLIENT_CAPABILITY: -32021,
  UNSUPPORTED_PROTOCOL_VERSION: -32022,
  /** Provisional SEP-3415 allocations — strictly scoped to events/* methods only */
  SEP_EVENTS_NOT_FOUND: -32023,
  SEP_EVENTS_FORBIDDEN: -32024,
  SEP_EVENTS_RESOURCE_EXHAUSTED: -32025,
  SEP_EVENTS_UNSUPPORTED: -32026,
  SEP_EVENTS_CALLBACK_ERROR: -32027,
  /** Vendor-local ChatGPT Events callback error */
  CHATGPT_EVENTS_CALLBACK_ERROR: -32015,
} as const;

export type McpErrorCodeValue = (typeof McpErrorCode)[keyof typeof McpErrorCode];

function tryParseUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}

/** Any syntactically valid URL (used for OAuth issuer identifiers). */
export const ValidUrlSchema = Schema.String.check(
  Schema.makeFilter((value) => tryParseUrl(value) !== null || "Expected a valid URL", {
    message: "Expected a valid URL",
    toJsonSchema: () => ({ format: "uri" }),
  }),
);
export type ValidUrl = typeof ValidUrlSchema.Type;

/** Strict http:// or https:// URL (blocks javascript:, data:, file:, etc.). */
export const HttpUrlSchema = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const parsed = tryParseUrl(value);
      if (!parsed) return "Expected a valid http:// or https:// URL";
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return `URL protocol must be http: or https:, got ${parsed.protocol}`;
      }
      return undefined;
    },
    {
      message: "Expected a valid http:// or https:// URL",
      toJsonSchema: () => ({ format: "uri" }),
    },
  ),
);
export type HttpUrl = typeof HttpUrlSchema.Type;

/** Strict https:// URL (required for webhook callback endpoints [R-28f5c2]). */
export const HttpsUrlSchema = Schema.String.check(
  Schema.makeFilter(
    (value) => {
      const parsed = tryParseUrl(value);
      if (!parsed) return "Expected a valid https:// URL";
      if (parsed.protocol !== "https:") {
        return `URL protocol must be https:, got ${parsed.protocol}`;
      }
      return undefined;
    },
    {
      message: "Expected a valid https:// URL",
      toJsonSchema: () => ({ format: "uri" }),
    },
  ),
);
export type HttpsUrl = typeof HttpsUrlSchema.Type;

export const CacheScopeSchema = Schema.Literals(["public", "private"]);
export type CacheScope = typeof CacheScopeSchema.Type;

export const CacheableResultFieldsSchema = Schema.Struct({
  resultType: Schema.Literal("complete"),
  ttlMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cacheScope: CacheScopeSchema,
});
export type CacheableResultFields = typeof CacheableResultFieldsSchema.Type;

export const ToolAnnotationsSchema = Schema.Struct({
  title: Schema.optionalKey(Schema.String),
  readOnlyHint: Schema.optionalKey(Schema.Boolean),
  destructiveHint: Schema.optionalKey(Schema.Boolean),
  idempotentHint: Schema.optionalKey(Schema.Boolean),
  openWorldHint: Schema.optionalKey(Schema.Boolean),
});
export type ToolAnnotations = typeof ToolAnnotationsSchema.Type;

/**
 * MCP client capabilities object.
 * Preserves unknown capability keys (passthrough semantics per #21 guardrail #3).
 */
export const ClientCapabilitiesSchema = Schema.StructWithRest(
  Schema.Struct({
    elicitation: Schema.optionalKey(
      Schema.StructWithRest(
        Schema.Struct({
          form: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
          url: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
        }),
        [Schema.Record(Schema.String, Schema.Unknown)],
      ),
    ),
    extensions: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
    ),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type ClientCapabilities = typeof ClientCapabilitiesSchema.Type;

/**
 * Modern 2026-07-28 request `_meta` envelope.
 * Preserves unknown `_meta` keys (passthrough semantics per #21 guardrail #3).
 */
export const ModernRequestMetaSchema = Schema.StructWithRest(
  Schema.Struct({
    "io.modelcontextprotocol/protocolVersion": Schema.NonEmptyString,
    "io.modelcontextprotocol/clientCapabilities": ClientCapabilitiesSchema,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type ModernRequestMeta = typeof ModernRequestMetaSchema.Type;

/** Reserved issuer namespace for quarantined pre-v3 migrated SQLite rows (never valid for live OAuth principals). */
export const RESERVED_LEGACY_ISSUER = "legacy://migrated" as const;

export const PrincipalScopeSchema = Schema.Literals([
  "bz:read",
  "bz:write:safe",
  "bz:write:guarded",
  "bz:events",
]);
export type PrincipalScope = typeof PrincipalScopeSchema.Type;

export const DeploymentModeSchema = Schema.Literals(["cloud-multi-user", "local-trusted-ide"]);
export type DeploymentMode = typeof DeploymentModeSchema.Type;

export const PrincipalContextSchema = Schema.Struct({
  issuer: ValidUrlSchema.check(
    Schema.makeFilter(
      (value) =>
        value !== RESERVED_LEGACY_ISSUER ||
        "Reserved legacy issuer cannot be used for live principals",
      { message: "Reserved legacy issuer cannot be used for live principals" },
    ),
  ),
  principalId: Schema.NonEmptyString,
  clientId: Schema.NonEmptyString,
  instanceUrl: HttpUrlSchema,
  credentialGeneration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  scopes: Schema.Array(PrincipalScopeSchema),
  deploymentMode: DeploymentModeSchema,
});
export type PrincipalContext = typeof PrincipalContextSchema.Type;

export const SchemaValidationIssueSchema = Schema.Struct({
  path: Schema.String,
  code: Schema.String,
  message: Schema.String,
});
export type SchemaValidationIssue = typeof SchemaValidationIssueSchema.Type;

export const EffectCertaintySchema = Schema.Literals(["none", "uncertain"]);
export type EffectCertainty = typeof EffectCertaintySchema.Type;

/** Structured tool execution error payload returned alongside `isError: true`. */
export const ToolErrorPayloadSchema = Schema.Struct({
  error: Schema.Literal(true),
  code: Schema.NonEmptyString,
  message: Schema.NonEmptyString,
  retryable: Schema.Boolean,
  effectCertainty: Schema.optionalKey(EffectCertaintySchema),
  issues: Schema.optionalKey(Schema.Array(SchemaValidationIssueSchema)),
  bzErrorCode: Schema.optionalKey(Schema.Int),
  missingFields: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  fieldHints: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  remediationHint: Schema.optionalKey(Schema.String),
  retryAfterMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  bindUrl: Schema.optionalKey(HttpUrlSchema),
});
export type ToolErrorPayload = typeof ToolErrorPayloadSchema.Type;

/** MRTR 2026-07-28 InputRequiredResult for URL and Form elicitation. */
export const InputRequiredElicitationUrlSchema = Schema.Struct({
  mode: Schema.Literal("url"),
  url: HttpUrlSchema,
  message: Schema.NonEmptyString,
});

export const InputRequiredElicitationFormSchema = Schema.Struct({
  mode: Schema.Literal("form"),
  message: Schema.NonEmptyString,
  requestedSchema: Schema.Record(Schema.String, Schema.Unknown),
});

export const InputRequiredResultSchema = Schema.Struct({
  resultType: Schema.Literal("input_required"),
  requestState: Schema.NonEmptyString,
  elicitation: Schema.Union([
    InputRequiredElicitationUrlSchema,
    InputRequiredElicitationFormSchema,
  ]),
});
export type InputRequiredResult = typeof InputRequiredResultSchema.Type;
