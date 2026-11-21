import { z } from "zod";

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
  /** Provisional SEP-3415 allocations (kept isolated from core schema until merged) */
  SEP_EVENTS_NOT_FOUND: -32023,
  SEP_EVENTS_FORBIDDEN: -32024,
  SEP_EVENTS_RESOURCE_EXHAUSTED: -32025,
  SEP_EVENTS_UNSUPPORTED: -32026,
  SEP_EVENTS_CALLBACK_ERROR: -32027,
  /** Vendor-local ChatGPT Events callback error */
  CHATGPT_EVENTS_CALLBACK_ERROR: -32015,
} as const;

export const CacheScopeSchema = z.enum(["public", "private"]);
export type CacheScope = z.infer<typeof CacheScopeSchema>;

export const CacheableResultFieldsSchema = z.object({
  resultType: z.literal("complete"),
  ttlMs: z.number().int().nonnegative(),
  cacheScope: CacheScopeSchema,
});
export type CacheableResultFields = z.infer<typeof CacheableResultFieldsSchema>;

export const ToolAnnotationsSchema = z.object({
  title: z.string().optional(),
  readOnlyHint: z.boolean().optional(),
  destructiveHint: z.boolean().optional(),
  idempotentHint: z.boolean().optional(),
  openWorldHint: z.boolean().optional(),
});
export type ToolAnnotations = z.infer<typeof ToolAnnotationsSchema>;

export const ClientCapabilitiesSchema = z
  .object({
    elicitation: z
      .object({
        form: z.record(z.unknown()).optional(),
        url: z.record(z.unknown()).optional(),
      })
      .optional(),
    extensions: z.record(z.record(z.unknown())).optional(),
  })
  .passthrough();
export type ClientCapabilities = z.infer<typeof ClientCapabilitiesSchema>;

export const ModernRequestMetaSchema = z
  .object({
    "io.modelcontextprotocol/protocolVersion": z.string().min(1),
    "io.modelcontextprotocol/clientCapabilities": ClientCapabilitiesSchema,
  })
  .passthrough();
export type ModernRequestMeta = z.infer<typeof ModernRequestMetaSchema>;

export const PrincipalContextSchema = z.object({
  issuer: z.string().url(),
  principalId: z.string().min(1),
  clientId: z.string().min(1),
  instanceUrl: z.string().url(),
  credentialGeneration: z.number().int().nonnegative(),
  scopes: z.array(z.enum(["bz:read", "bz:write:safe", "bz:write:guarded", "bz:events"])),
  deploymentMode: z.enum(["cloud-multi-user", "local-trusted-ide"]),
});
export type PrincipalContext = z.infer<typeof PrincipalContextSchema>;
