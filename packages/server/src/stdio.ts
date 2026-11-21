import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  MCP_PROTOCOL_LEGACY,
  MCP_PROTOCOL_MODERN,
  McpErrorCode,
  type PrincipalContext,
} from "@bugzilla-mcp/contracts";
import { createWriteGuardService, McpDomainError } from "@bugzilla-mcp/core";
import { createApprovalPageManager } from "./approval-page.js";
import type { HttpServerConfig } from "./index.js";
import {
  buildFullToolCatalog,
  buildResourceCatalog,
  dispatchToolCall,
  readMcpResource,
} from "./tool-dispatch.js";

interface StdioRpcRequest {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

function requiredScopeForStdioRpc(
  method: string,
  params: Record<string, unknown>,
): PrincipalContext["scopes"][number] | null {
  if (method === "resources/read") return "bz:read";
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

/**
 * Newline-delimited JSON-RPC 2.0 stdio transport for local IDEs / Antigravity / Claude Desktop.
 * Supports both MCP 2025-11-25 initialize handshake and MCP 2026-07-28 server/discover.
 */
export function createStdioRpcProcessor(params: {
  config: HttpServerConfig;
  principal: PrincipalContext;
}) {
  const { config, principal } = params;
  const writeGuard = createWriteGuardService(config.core);
  const approvalPage = createApprovalPageManager(config);

  return async function handleLine(line: string): Promise<string | null> {
    const trimmed = line.trim();
    if (!trimmed) return null;

    let rpc: StdioRpcRequest;
    try {
      rpc = JSON.parse(trimmed) as StdioRpcRequest;
    } catch {
      return JSON.stringify({
        jsonrpc: "2.0",
        error: { code: McpErrorCode.PARSE_ERROR, message: "Invalid JSON" },
      });
    }

    if (!rpc || rpc.jsonrpc !== "2.0" || typeof rpc.method !== "string") {
      return JSON.stringify({
        jsonrpc: "2.0",
        ...(rpc?.id !== undefined ? { id: rpc.id } : {}),
        error: { code: McpErrorCode.INVALID_REQUEST, message: "Invalid JSON-RPC request" },
      });
    }

    // Notifications (no id) require no response
    if (rpc.id === undefined && rpc.method.startsWith("notifications/")) {
      return null;
    }

    const p = rpc.params ?? {};

    // Enforce principal scopes identically to HTTP before resolving client or dispatching (AUTH-09)
    const neededScope = requiredScopeForStdioRpc(rpc.method, p);
    if (neededScope && !principal.scopes.includes(neededScope)) {
      return JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        error: {
          code: McpErrorCode.SEP_EVENTS_FORBIDDEN,
          message: `Insufficient scope: requires ${neededScope}`,
        },
      });
    }

    try {
      if (rpc.method === "initialize") {
        const requested =
          typeof p.protocolVersion === "string" ? p.protocolVersion : MCP_PROTOCOL_LEGACY;
        return JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            protocolVersion:
              requested === MCP_PROTOCOL_MODERN ? MCP_PROTOCOL_MODERN : MCP_PROTOCOL_LEGACY,
            // Advertise only capabilities implemented on stdio transport (RUNTIME-02)
            capabilities: {
              tools: {},
              resources: {},
            },
            serverInfo: { name: "bugzilla-mcp", version: "0.1.0" },
          },
        });
      }

      if (rpc.method === "server/discover") {
        return JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            resultType: "complete",
            ttlMs: 60_000,
            cacheScope: "private",
            supportedVersions: [MCP_PROTOCOL_MODERN],
            capabilities: {
              tools: {},
              resources: {},
            },
            serverInfo: { name: "bugzilla-mcp", version: "0.1.0" },
          },
        });
      }

      if (rpc.method === "ping") {
        return JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: {} });
      }

      if (rpc.method === "tools/list") {
        return JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { tools: buildFullToolCatalog(config.headerRoutedParams) },
        });
      }

      if (rpc.method === "resources/list") {
        return JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { resources: buildResourceCatalog() },
        });
      }

      if (rpc.method === "resources/read") {
        const uri = typeof p.uri === "string" ? p.uri : "";
        const outcome = await readMcpResource({
          uri,
          ctx: principal,
          core: config.core,
          ...(config.appHtmlOverridePath !== undefined
            ? { appHtmlOverridePath: config.appHtmlOverridePath }
            : {}),
        });
        if (outcome.kind === "rpc_error") {
          return JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: outcome.code, message: outcome.message },
          });
        }
        return JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { contents: outcome.contents },
        });
      }

      if (rpc.method === "tools/call") {
        const toolName = typeof p.name === "string" ? p.name : "";
        const toolArgs =
          typeof p.arguments === "object" && p.arguments !== null
            ? (p.arguments as Record<string, unknown>)
            : {};
        const client = await config.core.resolveClient(principal);
        if (!client) {
          return JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: McpErrorCode.INVALID_PARAMS, message: "CredentialBindingRequired" },
          });
        }
        const outcome = await dispatchToolCall({
          toolName,
          toolArgs,
          ctx: principal,
          client,
          core: config.core,
          writeGuard,
          approvalPage,
        });
        if (outcome.kind === "rpc_error") {
          return JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            error: { code: outcome.code, message: outcome.message },
          });
        }
        return JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: {
            content: outcome.content,
            structuredContent: outcome.structuredContent,
          },
        });
      }

      return JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: McpErrorCode.METHOD_NOT_FOUND, message: `Unknown method: ${rpc.method}` },
      });
    } catch (err) {
      if (err instanceof McpDomainError) {
        return JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: {
            code: err.code,
            message: err.message,
            ...(err.data !== undefined ? { data: err.data } : {}),
          },
        });
      }
      return JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: McpErrorCode.INTERNAL_ERROR, message: "Internal server error" },
      });
    }
  };
}

export async function runStdioServer(params: {
  config: HttpServerConfig;
  principal: PrincipalContext;
  input?: Readable;
  output?: Writable;
}): Promise<void> {
  const input = params.input ?? process.stdin;
  const output = params.output ?? process.stdout;
  const handleLine = createStdioRpcProcessor(params);
  const rl = createInterface({ input, crlfDelay: Infinity });

  for await (const line of rl) {
    const response = await handleLine(line);
    if (response !== null) {
      output.write(`${response}\n`);
    }
  }
}
