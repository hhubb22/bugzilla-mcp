import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import {
  MCP_PROTOCOL_LEGACY,
  MCP_PROTOCOL_MODERN,
  McpErrorCode,
  RESERVED_LEGACY_ISSUER,
  type PrincipalContext,
} from "@bugzilla-mcp/contracts";
import { createCoreRuntime, type CoreRuntime } from "@bugzilla-mcp/core";
import { projectTopLevelRpcError } from "./error-projector.js";
import type { HttpServerConfig } from "./index.js";
import { createMcpRequestPipeline } from "./pipeline.js";

interface StdioRpcRequest {
  jsonrpc?: string;
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
}

export type StdioRpcProcessor = ((line: string) => Promise<string | null>) & {
  dispose(): Promise<void>;
};

/**
 * Newline-delimited JSON-RPC 2.0 stdio transport for local IDEs / Antigravity / Claude Desktop.
 * Supports both MCP 2025-11-25 initialize handshake and MCP 2026-07-28 server/discover,
 * sharing the unified `McpRequestPipeline` (`readOnly`, scopes, error projection, Effect CoreRuntime).
 */
export function createStdioRpcProcessor(params: {
  config: HttpServerConfig;
  principal: PrincipalContext;
  coreRuntime?: CoreRuntime;
}): StdioRpcProcessor {
  const { config, principal, coreRuntime } = params;
  if (principal.issuer === RESERVED_LEGACY_ISSUER) {
    throw new Error("Reserved legacy issuer cannot be used for live stdio principals");
  }
  const pipeline = createMcpRequestPipeline({
    config,
    ...(coreRuntime !== undefined ? { coreRuntime } : {}),
  });

  const handleLine = async function handleLine(line: string): Promise<string | null> {
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

    try {
      // Enforce config.readOnly identically to HTTP before scope/client/dispatch ([R-0b14d8])
      const readOnlyErr = pipeline.checkReadOnlyMutation(rpc.method, p);
      if (readOnlyErr) {
        return JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: {
            code: readOnlyErr.code,
            message: readOnlyErr.message,
            ...(readOnlyErr.data !== undefined ? { data: readOnlyErr.data } : {}),
          },
        });
      }

      // Enforce principal scopes without abusing provisional SEP_EVENTS_FORBIDDEN (-32024) outside events/*
      const scopeDecision = pipeline.checkScope(principal, rpc.method, p);
      if (!scopeDecision.allowed) {
        return JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: {
            code: McpErrorCode.INVALID_PARAMS,
            message: `Insufficient scope: requires ${scopeDecision.requiredScope}`,
            data: { code: "insufficient_scope", requiredScope: scopeDecision.requiredScope },
          },
        });
      }

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
          result: { tools: pipeline.listedTools },
        });
      }

      if (rpc.method === "resources/list") {
        return JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          result: { resources: pipeline.resources },
        });
      }

      if (rpc.method === "resources/read") {
        const uri = typeof p.uri === "string" ? p.uri : "";
        const outcome = await pipeline.readResource(uri, principal);
        if (outcome.kind === "rpc_error") {
          return JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            error: {
              code: outcome.code,
              message: outcome.message,
              ...(outcome.data !== undefined ? { data: outcome.data } : {}),
            },
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
        const outcome = await pipeline.callTool({
          toolName,
          toolArgs,
          ctx: principal,
        });
        if (outcome.kind === "rpc_error") {
          return JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            error: {
              code: outcome.code,
              message: outcome.message,
              ...(outcome.data !== undefined ? { data: outcome.data } : {}),
            },
          });
        }
        if (outcome.kind === "tool_error") {
          return JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: {
              isError: true,
              content: outcome.content,
              structuredContent: outcome.structuredContent,
            },
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
      const projected = projectTopLevelRpcError(err);
      return JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        error: {
          code: projected.code,
          message: projected.message,
          ...(projected.data !== undefined ? { data: projected.data } : {}),
        },
      });
    }
  };

  return Object.assign(handleLine, {
    dispose: () => pipeline.dispose(),
  });
}

export async function runStdioServer(params: {
  config: HttpServerConfig;
  principal: PrincipalContext;
  input?: Readable;
  output?: Writable;
}): Promise<void> {
  const input = params.input ?? process.stdin;
  const output = params.output ?? process.stdout;
  const coreRuntime = createCoreRuntime({
    ...params.config.core,
    eventsProfile: params.config.eventsProfile,
    webhookEnabled: false,
  });
  const handleLine = createStdioRpcProcessor({
    config: params.config,
    principal: params.principal,
    coreRuntime,
  });
  const rl = createInterface({ input, crlfDelay: Infinity });

  const onSignal = () => {
    rl.close();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    for await (const line of rl) {
      const response = await handleLine(line);
      if (response !== null) {
        output.write(`${response}\n`);
      }
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    rl.close();
    await coreRuntime.dispose();
  }
}
