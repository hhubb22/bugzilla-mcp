import { randomUUID } from "node:crypto";
import {
  BugzillaGetDossierInputSchema,
  BugzillaPostAnalysisInputSchema,
  MCP_PROTOCOL_LEGACY,
  MCP_PROTOCOL_MODERN,
  McpErrorCode,
  PollEventsParamsSchema,
  WebhookSubscribeParamsSchema,
  type ClientCapabilities,
  type PrincipalContext,
} from "@bugzilla-mcp/contracts";
import {
  canonicalJson,
  createSyntheticEventsService,
  createWriteGuardService,
  McpDomainError,
  sha256Hex,
} from "@bugzilla-mcp/core";
import { createBindingManager } from "./binding.js";
import type {
  DualEraHttpRequest,
  DualEraHttpResponse,
  DualEraMcpHandler,
  HttpServerConfig,
} from "./index.js";

const VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CAPS_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const NAMED_METHODS = new Set([
  "tools/call",
  "resources/read",
  "prompts/get",
  "events/poll",
  "events/stream",
  "events/subscribe",
  "events/unsubscribe",
]);

const INDISTINGUISHABLE_RESOURCE_ERROR = {
  code: McpErrorCode.INVALID_PARAMS,
  message: "Resource not found or inaccessible",
} as const;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
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

function buildToolCatalog(headerRoutedParams: Readonly<Record<string, readonly string[]>> = {}) {
  const annotate = (toolName: string, propName: string, schema: Record<string, unknown>) => {
    const enabled = headerRoutedParams[toolName]?.includes(propName);
    return enabled ? { ...schema, "x-mcp-header": propName } : schema;
  };

  return [
    {
      name: "bugzilla_search",
      description: "Search Bugzilla bugs with compact projected summaries.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          product: annotate("bugzilla_search", "product", { type: "string" }),
          limit: { type: "integer", minimum: 1, maximum: 50 },
          offset: { type: "integer", minimum: 0 },
        },
      },
    },
    {
      name: "bugzilla_get_dossier",
      description: "Fetch compact Bugzilla dossier with recent comments, history, and metadata.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: { ui: { resourceUri: "ui://bugzilla/dossier-card.html" } },
      inputSchema: {
        type: "object",
        required: ["bugId"],
        properties: {
          bugId: annotate("bugzilla_get_dossier", "bugId", { type: "integer", minimum: 1 }),
        },
      },
    },
    {
      name: "bugzilla_triage_board",
      description: "Open the Bugzilla Triage workbench in side pane or global view.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: {
        ui: { resourceUri: "ui://bugzilla/triage-app.html" },
        "com.google.antigravity/ui": {
          entrypoints: [
            { type: "aux_pane", title: "Bugzilla" },
            { type: "global", title: "Bugzilla" },
          ],
        },
      },
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "bugzilla_post_analysis",
      description: "Post private Safe-Auto analysis comment (fails closed to internal note).",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: "object",
        required: ["bugId", "idempotencyKey", "isPrivate", "analysisMarkdown"],
        properties: {
          bugId: { type: "integer", minimum: 1 },
          idempotencyKey: { type: "string", minLength: 8 },
          isPrivate: annotate("bugzilla_post_analysis", "isPrivate", { const: true }),
          analysisMarkdown: { type: "string", minLength: 1 },
        },
      },
    },
    {
      name: "bugzilla_propose_update",
      description: "Create or execute a guarded Bugzilla update proposal.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "bugzilla_create_bug",
      description: "Create a Bugzilla bug with idempotency protection.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "bugzilla_get_attachment_excerpt",
      description: "Read a bounded text excerpt of a Bugzilla attachment.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: { type: "object", properties: {} },
    },
  ];
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

export function buildDualEraHttpHandler(config: HttpServerConfig): DualEraMcpHandler {
  const writeGuard = createWriteGuardService(config.core);
  const eventsService = createSyntheticEventsService(config.core);
  const binding = createBindingManager(config);
  const legacySessions = new Map<string, { protocolVersion: string; initialized: boolean }>();
  const publicBaseUrl = (config.publicBaseUrl ?? "https://mcp.example").replace(/\/+$/, "");

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

  function requiredScopeForRpc(
    method: string,
    params: Record<string, unknown>,
  ): PrincipalContext["scopes"][number] | null {
    if (method === "resources/read") return "bz:read";
    if (method.startsWith("events/")) return "bz:events";
    if (method === "tools/call") {
      const name = typeof params.name === "string" ? params.name : "";
      if (name === "bugzilla_post_analysis") return "bz:write:safe";
      if (
        name === "bugzilla_propose_update" ||
        name === "bugzilla_create_bug" ||
        name === "app_resolve_proposal"
      ) {
        return "bz:write:guarded";
      }
      return "bz:read";
    }
    return null;
  }

  async function authenticate(req: DualEraHttpRequest): Promise<PrincipalContext | null> {
    if (config.mode === "local-trusted-ide" && !config.authenticateBearerToken) {
      return {
        issuer: "local://ide",
        principalId: "local-user",
        clientId: "local-ide",
        instanceUrl: "https://bugzilla.local",
        credentialGeneration: 1,
        scopes: ["bz:read", "bz:write:safe", "bz:write:guarded", "bz:events"],
        deploymentMode: "local-trusted-ide",
      };
    }
    const auth = getHeader(req.headers, "authorization");
    if (!auth || !auth.startsWith("Bearer ")) return null;
    const token = auth.slice("Bearer ".length).trim();
    if (!token || !config.authenticateBearerToken) return null;
    return config.authenticateBearerToken(token);
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

  return {
    async handleHttp(req: DualEraHttpRequest): Promise<DualEraHttpResponse> {
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
        const sessionId = randomUUID();
        legacySessions.set(sessionId, {
          protocolVersion: MCP_PROTOCOL_LEGACY,
          initialized: false,
        });
        return jsonResponse(
          200,
          {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              protocolVersion: MCP_PROTOCOL_LEGACY,
              capabilities:
                config.eventsProfile === "chatgpt-events"
                  ? { tools: {}, resources: {}, events: {} }
                  : { tools: {}, resources: {} },
              serverInfo: { name: "bugzilla-mcp", version: "0.1.0" },
            },
          },
          { "Mcp-Session-Id": sessionId },
        );
      }

      const isExplicitLegacySessionCall =
        hVersion === MCP_PROTOCOL_LEGACY &&
        hSession !== undefined &&
        legacySessions.has(hSession) &&
        meta === undefined;

      if (isExplicitLegacySessionCall) {
        const session = legacySessions.get(hSession)!;
        if (rpc.method === "notifications/initialized") {
          session.initialized = true;
          return { status: 202, headers: {}, body: "" };
        }
        const ctx = await authenticate(req);
        if (!ctx) {
          return {
            status: 401,
            headers: {
              "www-authenticate": `Bearer resource_metadata="${config.publicBaseUrl ?? "https://mcp.example"}/.well-known/oauth-protected-resource"`,
            },
            body: "",
          };
        }
        if (rpc.method === "tools/list") {
          return jsonResponse(200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: { tools: buildToolCatalog(config.headerRoutedParams) },
          });
        }
        return rpcErrorResponse(
          404,
          rpc.id,
          McpErrorCode.METHOD_NOT_FOUND,
          "Unknown legacy method",
        );
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
        const capabilities =
          config.eventsProfile === "chatgpt-events"
            ? { tools: {}, resources: {}, events: {} }
            : {
                tools: {},
                resources: {},
                extensions: {
                  "io.modelcontextprotocol/events": { listChanged: false },
                },
              };
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

      const ctx = await authenticate(req);
      if (!ctx) {
        return {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${config.publicBaseUrl ?? "https://mcp.example"}/.well-known/oauth-protected-resource"`,
          },
          body: "",
        };
      }

      const clientCapabilities = metaCaps as ClientCapabilities;

      // Enforce OAuth scopes before resolving credentials, issuing tickets, or reserving receipts (AUTH-01)
      const neededScope = requiredScopeForRpc(rpc.method, params);
      if (neededScope && !ctx.scopes.includes(neededScope)) {
        return insufficientScopeResponse(neededScope);
      }

      try {
        if (rpc.method === "tools/list") {
          return jsonResponse(200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              resultType: "complete",
              ttlMs: 300_000,
              cacheScope: "private",
              tools: buildToolCatalog(config.headerRoutedParams),
            },
          });
        }

        if (rpc.method === "resources/read") {
          const uri = typeof params.uri === "string" ? params.uri : "";
          const match = /^bugzilla:\/\/bug\/([1-9]\d*)$/.exec(uri);
          const bugId = match?.[1] ? Number(match[1]) : NaN;
          if (!Number.isSafeInteger(bugId) || bugId <= 0) {
            return rpcErrorResponse(
              200,
              rpc.id,
              INDISTINGUISHABLE_RESOURCE_ERROR.code,
              INDISTINGUISHABLE_RESOURCE_ERROR.message,
            );
          }
          const client = await config.core.resolveClient(ctx);
          if (!client) {
            return rpcErrorResponse(
              200,
              rpc.id,
              McpErrorCode.INVALID_PARAMS,
              "CredentialBindingRequired",
            );
          }
          const vis = await client.checkVisibility(bugId);
          if (vis !== "visible") {
            return rpcErrorResponse(
              200,
              rpc.id,
              INDISTINGUISHABLE_RESOURCE_ERROR.code,
              INDISTINGUISHABLE_RESOURCE_ERROR.message,
            );
          }
          // Always fetch live authorized dossier on sensitive resource reads (AUTH-02: ttlMs 0)
          const raw = await client.getBugDossierData(bugId, { maxComments: 15, maxHistory: 30 });
          if (!raw) {
            return rpcErrorResponse(
              200,
              rpc.id,
              INDISTINGUISHABLE_RESOURCE_ERROR.code,
              INDISTINGUISHABLE_RESOURCE_ERROR.message,
            );
          }
          const internalNotes = await config.core.storage.listInternalNotes(
            ctx.principalId,
            ctx.instanceUrl,
            bugId,
          );
          const dossier = { ...raw, internalNotes };
          return jsonResponse(200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              resultType: "complete",
              ttlMs: 0,
              cacheScope: "private",
              contents: [
                {
                  uri,
                  mimeType: "application/json",
                  text: JSON.stringify(dossier),
                },
              ],
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
            const validRetry = binding.verifyAndConsumeRetryState(
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
              const challenge = binding.issueChallenge(ctx, toolName, paramsHash);
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
            return jsonResponse(200, {
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                resultType: "complete",
                isError: true,
                content: [
                  {
                    type: "text",
                    text: "CredentialBindingRequired: Bind your Bugzilla API key via the HTTPS binding page.",
                  },
                ],
              },
            });
          }

          if (toolName === "bugzilla_post_analysis") {
            const parsed = BugzillaPostAnalysisInputSchema.safeParse(toolArgs);
            if (!parsed.success) {
              return rpcErrorResponse(
                200,
                rpc.id,
                McpErrorCode.INVALID_PARAMS,
                "Invalid Safe-Auto analysis arguments (isPrivate must be true)",
              );
            }
            const outcome = await writeGuard.postAnalysis(ctx, parsed.data);
            return jsonResponse(200, {
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                resultType: "complete",
                content: [{ type: "text", text: JSON.stringify(outcome) }],
                structuredContent: outcome,
              },
            });
          }

          if (toolName === "bugzilla_get_dossier") {
            const parsed = BugzillaGetDossierInputSchema.safeParse(toolArgs);
            if (!parsed.success) {
              return rpcErrorResponse(200, rpc.id, McpErrorCode.INVALID_PARAMS, "Invalid bugId");
            }
            const vis = await client.checkVisibility(parsed.data.bugId);
            if (vis !== "visible") {
              return rpcErrorResponse(
                200,
                rpc.id,
                INDISTINGUISHABLE_RESOURCE_ERROR.code,
                INDISTINGUISHABLE_RESOURCE_ERROR.message,
              );
            }
            const raw = await client.getBugDossierData(parsed.data.bugId, {
              maxComments: parsed.data.maxComments,
              maxHistory: parsed.data.maxHistory,
            });
            if (!raw) {
              return rpcErrorResponse(
                200,
                rpc.id,
                INDISTINGUISHABLE_RESOURCE_ERROR.code,
                INDISTINGUISHABLE_RESOURCE_ERROR.message,
              );
            }
            const internalNotes = await config.core.storage.listInternalNotes(
              ctx.principalId,
              ctx.instanceUrl,
              parsed.data.bugId,
            );
            const dossier = { ...raw, internalNotes };
            return jsonResponse(200, {
              jsonrpc: "2.0",
              id: rpc.id,
              result: {
                resultType: "complete",
                content: [{ type: "text", text: JSON.stringify(dossier) }],
                structuredContent: dossier,
              },
            });
          }

          return rpcErrorResponse(
            200,
            rpc.id,
            McpErrorCode.INVALID_PARAMS,
            `Unknown tool: ${toolName}`,
          );
        }

        if (rpc.method === "events/list") {
          return jsonResponse(200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              resultType: "complete",
              events: eventsService.listEvents().events,
            },
          });
        }

        if (rpc.method === "events/poll") {
          const parsed = PollEventsParamsSchema.safeParse(params);
          if (!parsed.success) {
            return rpcErrorResponse(
              200,
              rpc.id,
              McpErrorCode.INVALID_PARAMS,
              "Invalid poll params",
            );
          }
          const result = await eventsService.poll(ctx, parsed.data);
          return jsonResponse(200, { jsonrpc: "2.0", id: rpc.id, result });
        }

        if (rpc.method === "events/subscribe") {
          const parsed = WebhookSubscribeParamsSchema.safeParse(params);
          if (!parsed.success) {
            return rpcErrorResponse(
              200,
              rpc.id,
              McpErrorCode.INVALID_PARAMS,
              "Invalid webhook subscribe params",
            );
          }
          const result = await eventsService.subscribeWebhook(ctx, parsed.data);
          return jsonResponse(200, { jsonrpc: "2.0", id: rpc.id, result });
        }

        if (rpc.method === "events/unsubscribe") {
          const delivery =
            typeof params.delivery === "object" && params.delivery !== null
              ? (params.delivery as { url?: string; mode?: "webhook" })
              : undefined;
          if (typeof params.name !== "string" || !delivery?.url) {
            return rpcErrorResponse(
              200,
              rpc.id,
              McpErrorCode.INVALID_PARAMS,
              "Invalid unsubscribe params",
            );
          }
          await eventsService.unsubscribeWebhook(ctx, {
            name: params.name as Parameters<typeof eventsService.unsubscribeWebhook>[1]["name"],
            arguments: (params.arguments ?? {}) as Parameters<
              typeof eventsService.unsubscribeWebhook
            >[1]["arguments"],
            delivery: {
              url: delivery.url,
              ...(delivery.mode !== undefined ? { mode: delivery.mode } : {}),
            },
          });
          if (config.eventsProfile === "chatgpt-events") {
            return jsonResponse(200, { jsonrpc: "2.0", id: rpc.id, result: {} });
          }
          return jsonResponse(200, {
            jsonrpc: "2.0",
            id: rpc.id,
            result: { resultType: "complete" },
          });
        }

        return rpcErrorResponse(
          404,
          rpc.id,
          McpErrorCode.METHOD_NOT_FOUND,
          `Unknown method: ${rpc.method}`,
        );
      } catch (err) {
        if (err instanceof McpDomainError) {
          return rpcErrorResponse(200, rpc.id, err.code, err.message, err.data);
        }
        return rpcErrorResponse(500, rpc.id, McpErrorCode.INTERNAL_ERROR, "Internal server error");
      }
    },
  };
}
