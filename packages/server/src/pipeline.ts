import {
  EventNameSchema,
  HttpsUrlSchema,
  McpErrorCode,
  PollEventsParamsSchema,
  STRICT_PARSE_OPTIONS,
  WebhookSubscribeParamsSchema,
  getToolDefinition,
  parseEventFilters,
  type McpToolCatalogEntry,
  type PrincipalContext,
  type PrincipalScope,
} from "@bugzilla-mcp/contracts";
import {
  createCoreRuntime,
  type CoreRuntime,
  type SyntheticEventsService,
} from "@bugzilla-mcp/core";
import { Result, Schema } from "effect";
import { createApprovalPageManager } from "./approval-page.js";
import {
  createCredentialBindingRequiredOutcome,
  projectTopLevelRpcError,
  type ResourceReadOutcome,
  type ToolDispatchOutcome,
} from "./error-projector.js";
import type { HttpServerConfig } from "./index.js";
import {
  buildFullToolCatalog,
  buildResourceCatalog,
  dispatchToolCall,
  readMcpResource,
} from "./tool-dispatch.js";

export type PipelineTransport = "http-modern" | "http-legacy" | "stdio";

export interface JsonRpcRequestEnvelope {
  readonly jsonrpc?: string;
  readonly id?: string | number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
}

export type PipelineScopeDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly requiredScope: PrincipalScope;
      readonly isEventsMethod: boolean;
    };

export type EventsDispatchResult =
  | { readonly kind: "ok"; readonly fields: Record<string, unknown> }
  | {
      readonly kind: "rpc_error";
      readonly httpStatus: number;
      readonly code: number;
      readonly message: string;
      readonly data?: unknown;
    };

const ChatgptUnsubscribeDeliverySchema = Schema.Struct({
  mode: Schema.Literal("webhook"),
  url: HttpsUrlSchema,
});

const SepUnsubscribeDeliverySchema = Schema.Struct({
  url: HttpsUrlSchema,
});

export interface McpRequestPipeline {
  readonly coreRuntime: CoreRuntime;
  readonly allTools: readonly McpToolCatalogEntry[];
  readonly listedTools: readonly McpToolCatalogEntry[];
  readonly resources: ReturnType<typeof buildResourceCatalog>;
  readonly approvalPage: ReturnType<typeof createApprovalPageManager>;
  readonly webhookEnabled: boolean;
  readonly eventsCapabilities: Record<string, unknown>;
  isMutatingTool(toolName: string): boolean;
  checkReadOnlyMutation(
    method: string,
    params: Record<string, unknown>,
  ): { readonly code: number; readonly message: string; readonly data?: unknown } | null;
  requiredScopeForRpc(method: string, params: Record<string, unknown>): PrincipalScope | null;
  checkScope(
    ctx: PrincipalContext,
    method: string,
    params: Record<string, unknown>,
  ): PipelineScopeDecision;
  dispatchEvents(
    method: string,
    params: Record<string, unknown>,
    ctx: PrincipalContext,
  ): Promise<EventsDispatchResult>;
  readResource(uri: string, ctx: PrincipalContext): Promise<ResourceReadOutcome>;
  callTool(params: {
    readonly toolName: string;
    readonly toolArgs: Record<string, unknown>;
    readonly ctx: PrincipalContext;
    readonly bindUrl?: string;
  }): Promise<ToolDispatchOutcome>;
  dispose(): Promise<void>;
}

/**
 * Unified request pipeline shared by HTTP 2026-07-28, HTTP 2025-11-25, and stdio.
 * Centralizes:
 * - Single-source tool catalog & `config.readOnly` enforcement ([R-0b14d8])
 * - Uniform OAuth/principal scope checks across tools/*, resources/*, events/*
 * - Core `ManagedRuntime` lifecycle + disposal
 * - Structured error projection (no uncaught domain/client/storage errors)
 */
export function createMcpRequestPipeline(params: {
  readonly config: HttpServerConfig;
  readonly coreRuntime?: CoreRuntime;
  readonly eventsOverride?: SyntheticEventsService;
}): McpRequestPipeline {
  const { config } = params;
  const webhookEnabled = config.webhookEnabled ?? Boolean(config.core.webhookTransport);
  const chatgpt = config.eventsProfile === "chatgpt-events";

  const ownsRuntime = params.coreRuntime === undefined;
  const coreRuntime =
    params.coreRuntime ??
    createCoreRuntime({
      ...config.core,
      eventsProfile: config.eventsProfile,
      webhookEnabled,
    });

  const eventsService = params.eventsOverride ?? coreRuntime.events;
  const eventsCapabilities: Record<string, unknown> = chatgpt
    ? webhookEnabled
      ? { events: {} }
      : {}
    : { extensions: { "io.modelcontextprotocol/events": { listChanged: false } } };

  const allTools = buildFullToolCatalog(config.headerRoutedParams);
  const mutatingTools = new Set<string>(
    allTools.filter((tool) => tool.annotations.readOnlyHint !== true).map((tool) => tool.name),
  );
  const listedTools = config.readOnly
    ? allTools.filter((tool) => tool.annotations.readOnlyHint === true)
    : allTools;
  const resources = buildResourceCatalog();
  const approvalPage = createApprovalPageManager(config, coreRuntime.writeGuard);

  function isMutatingTool(toolName: string): boolean {
    const def = getToolDefinition(toolName);
    if (def) return def.mutating;
    return mutatingTools.has(toolName);
  }

  function checkReadOnlyMutation(
    method: string,
    rpcParams: Record<string, unknown>,
  ): { readonly code: number; readonly message: string; readonly data?: unknown } | null {
    if (!config.readOnly || method !== "tools/call") return null;
    const name = typeof rpcParams.name === "string" ? rpcParams.name : "";
    if (!isMutatingTool(name)) return null;
    return {
      code: McpErrorCode.INVALID_PARAMS,
      message: "Connector is read-only",
      data: { code: "read_only_mode", toolName: name },
    };
  }

  function requiredScopeForRpc(
    method: string,
    rpcParams: Record<string, unknown>,
  ): PrincipalScope | null {
    if (method === "resources/read") return "bz:read";
    if (method.startsWith("events/")) return "bz:events";
    if (method === "tools/call") {
      const name = typeof rpcParams.name === "string" ? rpcParams.name : "";
      const def = getToolDefinition(name);
      return def ? def.requiredScope : "bz:read";
    }
    return null;
  }

  function checkScope(
    ctx: PrincipalContext,
    method: string,
    rpcParams: Record<string, unknown>,
  ): PipelineScopeDecision {
    const requiredScope = requiredScopeForRpc(method, rpcParams);
    if (!requiredScope || ctx.scopes.includes(requiredScope)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      requiredScope,
      isEventsMethod: method.startsWith("events/"),
    };
  }

  async function dispatchEvents(
    method: string,
    rpcParams: Record<string, unknown>,
    ctx: PrincipalContext,
  ): Promise<EventsDispatchResult> {
    const invalid = (data?: unknown): EventsDispatchResult => ({
      kind: "rpc_error",
      httpStatus: 200,
      code: McpErrorCode.INVALID_PARAMS,
      message: "Invalid Events parameters",
      ...(data !== undefined ? { data } : {}),
    });

    if (
      (chatgpt && (!webhookEnabled || method === "events/poll")) ||
      (chatgpt && method === "events/stream")
    ) {
      return {
        kind: "rpc_error",
        httpStatus: 200,
        code: McpErrorCode.METHOD_NOT_FOUND,
        message: "Unknown Events method",
      };
    }
    if (
      method === "events/stream" ||
      (!webhookEnabled && (method === "events/subscribe" || method === "events/unsubscribe"))
    ) {
      return {
        kind: "rpc_error",
        httpStatus: 200,
        code: McpErrorCode.SEP_EVENTS_UNSUPPORTED,
        message: "Delivery disabled",
        data: { reason: "delivery_disabled" },
      };
    }

    try {
      if (method === "events/list") {
        return { kind: "ok", fields: { events: eventsService.listEvents().events } };
      }

      const { _meta: _ignoredMeta, ...cleanParams } = rpcParams;

      const decodedName = Schema.decodeUnknownResult(
        EventNameSchema,
        STRICT_PARSE_OPTIONS,
      )(cleanParams.name);
      if (Result.isFailure(decodedName)) return invalid();
      const eventName = decodedName.success;

      const filters = parseEventFilters(eventName, cleanParams.arguments);
      if (!filters.success) return invalid({ issues: filters.issues });

      if (method === "events/poll") {
        const parsed = Schema.decodeUnknownResult(
          PollEventsParamsSchema,
          STRICT_PARSE_OPTIONS,
        )({
          ...cleanParams,
          name: eventName,
          arguments: filters.data,
        });
        if (Result.isFailure(parsed)) return invalid();
        const { resultType: _complete, ...fields } = await eventsService.poll(ctx, parsed.success);
        return { kind: "ok", fields };
      }

      if (method === "events/subscribe") {
        if ("id" in cleanParams) return invalid();
        const parsed = Schema.decodeUnknownResult(
          WebhookSubscribeParamsSchema,
          STRICT_PARSE_OPTIONS,
        )({
          ...cleanParams,
          name: eventName,
          arguments: filters.data,
        });
        if (Result.isFailure(parsed)) return invalid();
        const { resultType: _complete, ...fields } = await eventsService.subscribeWebhook(
          ctx,
          parsed.success,
        );
        return { kind: "ok", fields };
      }

      if (method === "events/unsubscribe") {
        if ("id" in cleanParams) return invalid();
        const deliverySchema = chatgpt
          ? ChatgptUnsubscribeDeliverySchema
          : SepUnsubscribeDeliverySchema;
        const parsedDelivery = Schema.decodeUnknownResult(
          deliverySchema,
          STRICT_PARSE_OPTIONS,
        )(cleanParams.delivery);
        if (Result.isFailure(parsedDelivery)) return invalid();
        await eventsService.unsubscribeWebhook(ctx, {
          name: eventName,
          arguments: filters.data,
          delivery: parsedDelivery.success,
        });
        return { kind: "ok", fields: {} };
      }

      return {
        kind: "rpc_error",
        httpStatus: 200,
        code: McpErrorCode.METHOD_NOT_FOUND,
        message: "Unknown Events method",
      };
    } catch (err) {
      const projected = projectTopLevelRpcError(err);
      return {
        kind: "rpc_error",
        httpStatus: projected.httpStatus,
        code: projected.code,
        message: projected.message,
        ...(projected.data !== undefined ? { data: projected.data } : {}),
      };
    }
  }

  async function readResource(uri: string, ctx: PrincipalContext): Promise<ResourceReadOutcome> {
    return readMcpResource({
      uri,
      ctx,
      core: config.core,
      metadataCache: coreRuntime.metadataCache,
      ...(config.appHtmlOverridePath !== undefined
        ? { appHtmlOverridePath: config.appHtmlOverridePath }
        : {}),
    });
  }

  async function callTool(callParams: {
    readonly toolName: string;
    readonly toolArgs: Record<string, unknown>;
    readonly ctx: PrincipalContext;
    readonly bindUrl?: string;
  }): Promise<ToolDispatchOutcome> {
    const { toolName, toolArgs, ctx, bindUrl } = callParams;
    if (!getToolDefinition(toolName)) {
      return {
        kind: "rpc_error",
        code: McpErrorCode.INVALID_PARAMS,
        message: `Unknown tool: ${toolName}`,
      };
    }

    let rawClient: Awaited<ReturnType<HttpServerConfig["core"]["resolveClient"]>>;
    try {
      rawClient = await config.core.resolveClient(ctx);
    } catch (err) {
      const projected = projectTopLevelRpcError(err);
      return {
        kind: "rpc_error",
        code: projected.code,
        message: projected.message,
        ...(projected.data !== undefined ? { data: projected.data } : {}),
      };
    }

    if (!rawClient) {
      return createCredentialBindingRequiredOutcome(bindUrl);
    }

    return dispatchToolCall({
      toolName,
      toolArgs,
      ctx,
      client: rawClient,
      core: config.core,
      writeGuard: coreRuntime.writeGuard,
      approvalPage,
    });
  }

  let disposed = false;
  async function dispose(): Promise<void> {
    if (disposed || !ownsRuntime) return;
    disposed = true;
    await coreRuntime.dispose();
  }

  return {
    coreRuntime,
    allTools,
    listedTools,
    resources,
    approvalPage,
    webhookEnabled,
    eventsCapabilities,
    isMutatingTool,
    checkReadOnlyMutation,
    requiredScopeForRpc,
    checkScope,
    dispatchEvents,
    readResource,
    callTool,
    dispose,
  };
}
