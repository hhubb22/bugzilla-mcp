import { randomUUID, timingSafeEqual } from "node:crypto";
import {
  MCP_PROTOCOL_LEGACY,
  MCP_PROTOCOL_MODERN,
  McpErrorCode,
  RESERVED_LEGACY_ISSUER,
  type ClientCapabilities,
  type PrincipalContext,
} from "@bugzilla-mcp/contracts";
import {
  canonicalJson,
  sha256Hex,
  type CoreRuntime,
  type SyntheticEventsService,
} from "@bugzilla-mcp/core";
import { createBindingManager } from "./binding.js";
import {
  createCredentialBindingRequiredOutcome,
  projectTopLevelRpcError,
} from "./error-projector.js";
import type {
  DualEraHttpRequest,
  DualEraHttpResponse,
  DualEraMcpHandler,
  HttpServerConfig,
} from "./index.js";
import { createMcpRequestPipeline } from "./pipeline.js";
import { dispatchToolCall } from "./tool-dispatch.js";

const VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPS_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const LEGACY_SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_LEGACY_SESSIONS = 4096;

const NAMED_METHODS = new Set([
  "tools/call",
  "resources/read",
  "prompts/get",
  "events/poll",
  "events/stream",
  "events/subscribe",
  "events/unsubscribe",
]);

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

interface LegacySessionEntry {
  protocolVersion: string;
  initialized: boolean;
  expiresAtMs: number;
  owner?: { issuer: string; principalId: string; instanceUrl: string };
}

function getHeader(
  headers: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) return v;
  }
  return undefined;
}

function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): DualEraHttpResponse {
  return {
    status,
    headers: {
      "content-type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  };
}

function rpcErrorResponse(
  status: number,
  id: string | number | undefined,
  code: number,
  message: string,
  data?: unknown,
): DualEraHttpResponse {
  return jsonResponse(status, {
    jsonrpc: "2.0",
    ...(id !== undefined ? { id } : {}),
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {}),
    },
  });
}

function validatePrimitiveMirror(rawHeader: string | undefined, value: unknown): boolean {
  if (rawHeader === undefined) return false;
  if (typeof value === "boolean") {
    if (rawHeader !== "true" && rawHeader !== "false") return false;
    return rawHeader === String(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    if (!/^-?\d+$/.test(rawHeader)) return false;
    return rawHeader === String(value);
  }
  if (typeof value === "string") {
    if (/[\r\n\0]/.test(rawHeader)) return false;
    return rawHeader === value;
  }
  return false;
}

function isCoreRuntime(
  value: SyntheticEventsService | CoreRuntime | undefined,
): value is CoreRuntime {
  return (
    typeof value === "object" &&
    value !== null &&
    "runtime" in value &&
    "dispose" in value &&
    typeof (value as CoreRuntime).dispose === "function"
  );
}

export function buildDualEraHttpHandler(
  config: HttpServerConfig,
  eventsOrRuntime?: SyntheticEventsService | CoreRuntime,
): DualEraMcpHandler {
  const clock = config.core.clock ?? (() => Date.now());
  const pipeline = createMcpRequestPipeline({
    config,
    ...(isCoreRuntime(eventsOrRuntime)
      ? { coreRuntime: eventsOrRuntime }
      : eventsOrRuntime !== undefined
        ? { eventsOverride: eventsOrRuntime }
        : {}),
  });
  const binding = createBindingManager(config);
  const legacySessions = new Map<string, LegacySessionEntry>();
  const publicBaseUrl = (config.publicBaseUrl ?? "https://mcp.example").replace(/\/+$/, "");

  function pruneLegacySessions(nowMs: number): void {
    for (const [id, entry] of legacySessions) {
      if (nowMs >= entry.expiresAtMs) {
        legacySessions.delete(id);
      }
    }
    while (legacySessions.size >= MAX_LEGACY_SESSIONS) {
      const oldest = legacySessions.keys().next().value;
      if (oldest === undefined) break;
      legacySessions.delete(oldest);
    }
  }

  function getActiveLegacySession(sessionId: string): LegacySessionEntry | undefined {
    const entry = legacySessions.get(sessionId);
    if (!entry) return undefined;
    const nowMs = clock();
    if (nowMs >= entry.expiresAtMs) {
      legacySessions.delete(sessionId);
      return undefined;
    }
    entry.expiresAtMs = nowMs + LEGACY_SESSION_TTL_MS;
    return entry;
  }

  function unauthorizedResponse(): DualEraHttpResponse {
    return {
      status: 401,
      headers: {
        "www-authenticate": `Bearer resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource"`,
      },
      body: "",
    };
  }

  function insufficientScopeResponse(requiredScope: string): DualEraHttpResponse {
    return {
      status: 403,
      headers: {
        "www-authenticate": `Bearer error="insufficient_scope", scope="${requiredScope}", resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource"`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ error: "insufficient_scope", requiredScope }),
    };
  }

  function scopeDenialResponse(
    rpc: JsonRpcRequest,
    decision: { readonly requiredScope: string; readonly isEventsMethod: boolean },
  ): DualEraHttpResponse {
    if (decision.isEventsMethod) {
      return rpcErrorResponse(
        200,
        rpc.id,
        McpErrorCode.SEP_EVENTS_FORBIDDEN,
        "Events access revoked",
        { requiredScope: decision.requiredScope },
      );
    }
    return insufficientScopeResponse(decision.requiredScope);
  }

  async function authenticateSafe(
    req: DualEraHttpRequest,
    rpcId: string | number | undefined,
  ): Promise<
    | { readonly ok: true; readonly ctx: PrincipalContext }
    | { readonly ok: false; readonly response: DualEraHttpResponse }
  > {
    try {
      const auth = getHeader(req.headers, "authorization");
      if (config.mode === "local-trusted-ide" && !config.authenticateBearerToken) {
        // Fail closed in local HTTP mode unless a non-empty localAuthToken is configured (ISO-09, AUTH-07)
        if (!config.localAuthToken || config.localAuthToken.length === 0) {
          return { ok: false, response: unauthorizedResponse() };
        }
        if (!auth || !auth.startsWith("Bearer ")) {
          return { ok: false, response: unauthorizedResponse() };
        }
        const provided = Buffer.from(auth.slice("Bearer ".length).trim(), "utf8");
        const expected = Buffer.from(config.localAuthToken, "utf8");
        if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
          return { ok: false, response: unauthorizedResponse() };
        }
        const localCtx = config.localPrincipal ?? {
          issuer: "local://ide",
          principalId: "local-user",
          clientId: "local-ide",
          instanceUrl: "https://bugzilla.local",
          credentialGeneration: 1,
          scopes: ["bz:read", "bz:write:safe", "bz:write:guarded", "bz:events"],
          deploymentMode: "local-trusted-ide",
        };
        if (localCtx.issuer === RESERVED_LEGACY_ISSUER) {
          return { ok: false, response: unauthorizedResponse() };
        }
        return { ok: true, ctx: localCtx };
      }

      if (!auth || !auth.startsWith("Bearer ")) {
        return { ok: false, response: unauthorizedResponse() };
      }
      const token = auth.slice("Bearer ".length).trim();
      if (!token || !config.authenticateBearerToken) {
        return { ok: false, response: unauthorizedResponse() };
      }
      const ctx = await config.authenticateBearerToken(token);
      if (!ctx || ctx.issuer === RESERVED_LEGACY_ISSUER) {
        return { ok: false, response: unauthorizedResponse() };
      }
      return { ok: true, ctx };
    } catch (err) {
      const projected = projectTopLevelRpcError(err);
      return {
        ok: false,
        response: rpcErrorResponse(
          projected.httpStatus,
          rpcId,
          projected.code,
          projected.message,
          projected.data,
        ),
      };
    }
  }

  function validateMirrorHeaders(
    req: DualEraHttpRequest,
    rpc: JsonRpcRequest,
    metaVersion: string,
  ): boolean {
    const method = rpc.method ?? "";
    const params = rpc.params ?? {};

    const hVersion = getHeader(req.headers, "mcp-protocol-version");
    if (!hVersion || !/^\d{4}-\d{2}-\d{2}$/.test(hVersion) || hVersion !== metaVersion) {
      return false;
    }

    const hMethod = getHeader(req.headers, "mcp-method");
    if (!hMethod || !/^[a-zA-Z0-9/_-]+$/.test(hMethod) || hMethod !== method) {
      return false;
    }

    if (NAMED_METHODS.has(method)) {
      const expectedName =
        method === "resources/read"
          ? typeof params.uri === "string"
            ? params.uri
            : undefined
          : typeof params.name === "string"
            ? params.name
            : undefined;
      const hName = getHeader(req.headers, "mcp-name");
      if (!expectedName || !hName || /\s/.test(hName) || hName !== expectedName) {
        return false;
      }

      const routedParams = config.headerRoutedParams?.[expectedName];
      if (routedParams && routedParams.length > 0) {
        const argObj =
          typeof params.arguments === "object" && params.arguments !== null
            ? (params.arguments as Record<string, unknown>)
            : {};
        for (const paramName of routedParams) {
          const val = argObj[paramName];
          if (val !== undefined && val !== null) {
            const hParam = getHeader(req.headers, `mcp-param-${paramName.toLowerCase()}`);
            if (!validatePrimitiveMirror(hParam, val)) {
              return false;
            }
          }
        }
      }
    }

    return true;
  }

  function formatEventsResponse(
    rpcId: string | number | undefined,
    legacy: boolean,
    outcome: Awaited<ReturnType<typeof pipeline.dispatchEvents>>,
  ): DualEraHttpResponse {
    if (outcome.kind === "rpc_error") {
      return rpcErrorResponse(
        outcome.httpStatus,
        rpcId,
        outcome.code,
        outcome.message,
        outcome.data,
      );
    }
    return jsonResponse(200, {
      jsonrpc: "2.0",
      id: rpcId,
      result: legacy ? outcome.fields : { resultType: "complete", ...outcome.fields },
    });
  }

  return {
    async handleHttp(req: DualEraHttpRequest): Promise<DualEraHttpResponse> {
      try {
        const pathname = new URL(req.path, "https://mcp.local").pathname;

        // RFC 9728 Protected Resource Metadata discovery endpoint (MCP-03)
        if (pathname === "/.well-known/oauth-protected-resource" && req.method === "GET") {
          return jsonResponse(200, {
            resource: `${publicBaseUrl}/mcp`,
            authorization_servers: [],
            scopes_supported: ["bz:read", "bz:write:safe", "bz:write:guarded", "bz:events"],
          });
        }

        // Out-of-band HTTPS binding routes
        if (pathname === "/bind") {
          if (req.method === "GET") return binding.handleBindGet(req);
          if (req.method === "POST") return binding.handleBindPost(req);
          return {
            status: 405,
            headers: { "content-type": "text/plain" },
            body: "Method Not Allowed",
          };
        }

        // Out-of-band HTTPS Guarded-Write human approval routes (Cloud mode)
        if (pathname === "/approve") {
          if (req.method === "GET") return pipeline.approvalPage.handleApproveGet(req);
          if (req.method === "POST") return pipeline.approvalPage.handleApprovePost(req);
          return {
            status: 405,
            headers: { "content-type": "text/plain" },
            body: "Method Not Allowed",
          };
        }

        // Precedence 1: Origin check BEFORE parsing body, version, or mirror headers (R-d34daa)
        const originHeader = getHeader(req.headers, "origin");
        if (originHeader !== undefined) {
          if (!config.allowedOrigins.includes(originHeader)) {
            return {
              status: 403,
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ error: "Forbidden origin" }),
            };
          }
        } else if (config.allowAbsentOrigin === false) {
          return {
            status: 403,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: "Origin header required" }),
          };
        }

        // Parse JSON-RPC envelope
        let rpc: JsonRpcRequest;
        try {
          rpc = JSON.parse(req.rawBody) as JsonRpcRequest;
        } catch {
          return rpcErrorResponse(400, undefined, McpErrorCode.PARSE_ERROR, "Invalid JSON");
        }
        if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
          return rpcErrorResponse(400, rpc?.id, McpErrorCode.INVALID_REQUEST, "Invalid JSON-RPC");
        }

        const params = rpc.params ?? {};
        const meta =
          typeof params._meta === "object" && params._meta !== null
            ? (params._meta as Record<string, unknown>)
            : undefined;
        const hVersion = getHeader(req.headers, "mcp-protocol-version");
        const hSession = getHeader(req.headers, "mcp-session-id");

        // Legacy 2025-11-25 initialize & session routing (never absorbs modern requests!)
        if (rpc.method === "initialize" && params.protocolVersion === MCP_PROTOCOL_LEGACY) {
          // Require valid tenant authentication before allocating a stateful session (ISO-09)
          const authResult = await authenticateSafe(req, rpc.id);
          if (!authResult.ok) return authResult.response;
          const initCtx = authResult.ctx;

          const nowMs = clock();
          pruneLegacySessions(nowMs);
          const sessionId = randomUUID();
          legacySessions.set(sessionId, {
            protocolVersion: MCP_PROTOCOL_LEGACY,
            initialized: false,
            expiresAtMs: nowMs + LEGACY_SESSION_TTL_MS,
            owner: {
              issuer: initCtx.issuer,
              principalId: initCtx.principalId,
              instanceUrl: initCtx.instanceUrl,
            },
          });
          return jsonResponse(
            200,
            {
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                protocolVersion: MCP_PROTOCOL_LEGACY,
                capabilities: { tools: {}, resources: {}, ...pipeline.eventsCapabilities },
                serverInfo: { name: "bugzilla-mcp", version: "0.1.0" },
              },
            },
            { "Mcp-Session-Id": sessionId },
          );
        }

        const activeLegacySession =
          hVersion === MCP_PROTOCOL_LEGACY && hSession !== undefined && meta === undefined
            ? getActiveLegacySession(hSession)
            : undefined;

        if (activeLegacySession) {
          const authResult = await authenticateSafe(req, rpc.id);
          if (!authResult.ok) return authResult.response;
          const ctx = authResult.ctx;

          // Bind anonymous-init sessions on first authenticated use and enforce tenant ownership (ISO-09)
          if (!activeLegacySession.owner) {
            activeLegacySession.owner = {
              issuer: ctx.issuer,
              principalId: ctx.principalId,
              instanceUrl: ctx.instanceUrl,
            };
          } else if (
            activeLegacySession.owner.issuer !== ctx.issuer ||
            activeLegacySession.owner.principalId !== ctx.principalId ||
            activeLegacySession.owner.instanceUrl !== ctx.instanceUrl
          ) {
            return rpcErrorResponse(
              403,
              rpc.id,
              McpErrorCode.INVALID_REQUEST,
              "Session does not belong to authenticated tenant",
            );
          }

          if (rpc.method === "notifications/initialized") {
            activeLegacySession.initialized = true;
            return { status: 202, headers: {}, body: "" };
          }

          try {
            const readOnlyErr = pipeline.checkReadOnlyMutation(rpc.method, params);
            if (readOnlyErr) {
              return rpcErrorResponse(
                200,
                rpc.id,
                readOnlyErr.code,
                readOnlyErr.message,
                readOnlyErr.data,
              );
            }

            const scopeDecision = pipeline.checkScope(ctx, rpc.method, params);
            if (!scopeDecision.allowed) {
              return scopeDenialResponse(rpc, scopeDecision);
            }

            if (rpc.method === "ping") {
              return jsonResponse(200, { jsonrpc: "2.0", id: rpc.id, result: {} });
            }

            if (rpc.method.startsWith("events/")) {
              return formatEventsResponse(
                rpc.id,
                true,
                await pipeline.dispatchEvents(rpc.method, params, ctx),
              );
            }

            if (rpc.method === "tools/list") {
              return jsonResponse(200, {
                jsonrpc: "2.0",
                id: rpc.id,
                result: { tools: pipeline.listedTools },
              });
            }

            if (rpc.method === "resources/list") {
              return jsonResponse(200, {
                jsonrpc: "2.0",
                id: rpc.id,
                result: { resources: pipeline.resources },
              });
            }

            if (rpc.method === "resources/read") {
              const uri = typeof params.uri === "string" ? params.uri : "";
              const outcome = await pipeline.readResource(uri, ctx);
              if (outcome.kind === "rpc_error") {
                return rpcErrorResponse(200, rpc.id, outcome.code, outcome.message, outcome.data);
              }
              return jsonResponse(200, {
                jsonrpc: "2.0",
                id: rpc.id,
                result: { contents: outcome.contents },
              });
            }

            if (rpc.method === "tools/call") {
              const toolName = typeof params.name === "string" ? params.name : "";
              const toolArgs =
                typeof params.arguments === "object" && params.arguments !== null
                  ? (params.arguments as Record<string, unknown>)
                  : {};
              const outcome = await pipeline.callTool({ toolName, toolArgs, ctx });
              if (outcome.kind === "rpc_error") {
                return rpcErrorResponse(200, rpc.id, outcome.code, outcome.message, outcome.data);
              }
              if (outcome.kind === "tool_error") {
                return jsonResponse(200, {
                  jsonrpc: "2.0",
                  id: rpc.id,
                  result: {
                    isError: true,
                    content: outcome.content,
                    structuredContent: outcome.structuredContent,
                  },
                });
              }
              return jsonResponse(200, {
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  content: outcome.content,
                  structuredContent: outcome.structuredContent,
                },
              });
            }

            return rpcErrorResponse(
              404,
              rpc.id,
              McpErrorCode.METHOD_NOT_FOUND,
              "Unknown legacy method",
            );
          } catch (err) {
            const projected = projectTopLevelRpcError(err);
            return rpcErrorResponse(
              projected.httpStatus,
              rpc.id,
              projected.code,
              projected.message,
              projected.data,
            );
          }
        }

        // Modern 2026-07-28 validation precedence:
        // 2. Required _meta keys
        const metaVersion = meta?.[VERSION_META_KEY];
        const metaCaps = meta?.[CAPS_META_KEY];
        if (typeof metaVersion !== "string" || typeof metaCaps !== "object" || metaCaps === null) {
          return rpcErrorResponse(
            400,
            rpc.id,
            McpErrorCode.INVALID_PARAMS,
            "Missing required modern _meta protocolVersion or clientCapabilities",
          );
        }

        // 3. Protocol version check BEFORE mirror headers (R-be7235)
        if (metaVersion !== MCP_PROTOCOL_MODERN) {
          return rpcErrorResponse(
            400,
            rpc.id,
            McpErrorCode.UNSUPPORTED_PROTOCOL_VERSION,
            "Unsupported protocol version",
            { requested: metaVersion, supported: [MCP_PROTOCOL_MODERN] },
          );
        }

        // 4. Mirror headers check BEFORE domain side effects (R-1120b2)
        if (!validateMirrorHeaders(req, rpc, metaVersion)) {
          return rpcErrorResponse(
            400,
            rpc.id,
            McpErrorCode.HEADER_MISMATCH,
            "Missing, malformed, or mismatched MCP routing headers",
          );
        }

        // Discovery may run unauthenticated or authenticated
        if (rpc.method === "server/discover") {
          const capabilities = { tools: {}, resources: {}, ...pipeline.eventsCapabilities };
          return jsonResponse(200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              resultType: "complete",
              ttlMs: 60_000,
              cacheScope: "public",
              supportedVersions: [MCP_PROTOCOL_MODERN],
              capabilities,
              serverInfo: { name: "bugzilla-mcp", version: "0.1.0" },
            },
          });
        }

        const authResult = await authenticateSafe(req, rpc.id);
        if (!authResult.ok) return authResult.response;
        const ctx = authResult.ctx;

        const clientCapabilities = metaCaps as ClientCapabilities;

        // Enforce readOnly and OAuth scopes before resolving credentials, issuing tickets, or reserving receipts (AUTH-01)
        const readOnlyErr = pipeline.checkReadOnlyMutation(rpc.method, params);
        if (readOnlyErr) {
          return rpcErrorResponse(
            200,
            rpc.id,
            readOnlyErr.code,
            readOnlyErr.message,
            readOnlyErr.data,
          );
        }

        const scopeDecision = pipeline.checkScope(ctx, rpc.method, params);
        if (!scopeDecision.allowed) {
          return scopeDenialResponse(rpc, scopeDecision);
        }

        try {
          if (rpc.method === "ping") {
            return jsonResponse(200, {
              jsonrpc: "2.0",
              id: rpc.id,
              result: { resultType: "complete" },
            });
          }

          if (rpc.method.startsWith("events/")) {
            return formatEventsResponse(
              rpc.id,
              false,
              await pipeline.dispatchEvents(rpc.method, params, ctx),
            );
          }

          if (rpc.method === "tools/list") {
            return jsonResponse(200, {
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                resultType: "complete",
                ttlMs: 300_000,
                cacheScope: "private",
                tools: pipeline.listedTools,
              },
            });
          }

          if (rpc.method === "resources/list") {
            return jsonResponse(200, {
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                resultType: "complete",
                ttlMs: 300_000,
                cacheScope: "public",
                resources: pipeline.resources,
              },
            });
          }

          if (rpc.method === "resources/read") {
            const uri = typeof params.uri === "string" ? params.uri : "";
            const outcome = await pipeline.readResource(uri, ctx);
            if (outcome.kind === "rpc_error") {
              return rpcErrorResponse(200, rpc.id, outcome.code, outcome.message, outcome.data);
            }
            return jsonResponse(200, {
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                resultType: "complete",
                ttlMs: outcome.ttlMs,
                cacheScope: outcome.cacheScope,
                contents: outcome.contents,
              },
            });
          }

          if (rpc.method === "tools/call") {
            const toolName = typeof params.name === "string" ? params.name : "";
            const toolArgs =
              typeof params.arguments === "object" && params.arguments !== null
                ? (params.arguments as Record<string, unknown>)
                : {};
            const paramsHash = sha256Hex(canonicalJson(toolArgs));

            // Strictly validate continuation envelope including non-string state & decline/cancel (AUTH-06)
            if (params.requestState !== undefined) {
              if (typeof params.requestState !== "string") {
                return rpcErrorResponse(
                  400,
                  rpc.id,
                  McpErrorCode.INVALID_PARAMS,
                  "Malformed continuation requestState",
                );
              }
              const responses =
                typeof params.inputResponses === "object" && params.inputResponses !== null
                  ? (params.inputResponses as Record<string, { action?: unknown }>)
                  : undefined;
              const bindResp = responses?.bind_bugzilla_api_key;
              if (bindResp && (bindResp.action === "decline" || bindResp.action === "cancel")) {
                return rpcErrorResponse(
                  400,
                  rpc.id,
                  McpErrorCode.INVALID_PARAMS,
                  "User declined or cancelled credential binding elicitation",
                );
              }
              const validRetry = await binding.verifyAndConsumeRetryState(
                params.requestState,
                ctx,
                toolName,
                paramsHash,
              );
              if (!validRetry) {
                return rpcErrorResponse(
                  400,
                  rpc.id,
                  McpErrorCode.INVALID_PARAMS,
                  "Invalid, incomplete, expired, or already-consumed continuation state",
                );
              }
            }

            const client = await config.core.resolveClient(ctx);
            if (!client) {
              if (clientCapabilities.elicitation?.url !== undefined) {
                const challenge = await binding.issueChallenge(ctx, toolName, paramsHash);
                return jsonResponse(200, {
                  jsonrpc: "2.0",
                  id: rpc.id,
                  result: {
                    resultType: "input_required",
                    requestState: challenge.requestState,
                    inputRequests: {
                      [challenge.inputId]: {
                        method: "elicitation/create",
                        params: {
                          mode: "url",
                          url: challenge.url,
                          message: "Bind your personal self-hosted Bugzilla API key to continue.",
                        },
                      },
                    },
                  },
                });
              }
              const unbound = createCredentialBindingRequiredOutcome();
              if (unbound.kind === "tool_error") {
                return jsonResponse(200, {
                  jsonrpc: "2.0",
                  id: rpc.id,
                  result: {
                    resultType: "complete",
                    isError: true,
                    content: unbound.content,
                    structuredContent: unbound.structuredContent,
                  },
                });
              }
            }

            const outcome = await dispatchToolCall({
              toolName,
              toolArgs,
              ctx,
              client: client!,
              core: config.core,
              writeGuard: pipeline.coreRuntime.writeGuard,
              approvalPage: pipeline.approvalPage,
            });
            if (outcome.kind === "rpc_error") {
              return rpcErrorResponse(200, rpc.id, outcome.code, outcome.message, outcome.data);
            }
            if (outcome.kind === "tool_error") {
              return jsonResponse(200, {
                jsonrpc: "2.0",
                id: rpc.id,
                result: {
                  resultType: "complete",
                  isError: true,
                  content: outcome.content,
                  structuredContent: outcome.structuredContent,
                },
              });
            }
            return jsonResponse(200, {
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                resultType: "complete",
                content: outcome.content,
                structuredContent: outcome.structuredContent,
              },
            });
          }

          return rpcErrorResponse(
            404,
            rpc.id,
            McpErrorCode.METHOD_NOT_FOUND,
            `Unknown method: ${rpc.method}`,
          );
        } catch (err) {
          const projected = projectTopLevelRpcError(err);
          return rpcErrorResponse(
            projected.httpStatus,
            rpc.id,
            projected.code,
            projected.message,
            projected.data,
          );
        }
      } catch (err) {
        const projected = projectTopLevelRpcError(err);
        return rpcErrorResponse(
          projected.httpStatus,
          undefined,
          projected.code,
          projected.message,
          projected.data,
        );
      }
    },
    dispose: () => pipeline.dispose(),
  };
}
