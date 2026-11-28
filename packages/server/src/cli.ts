#!/usr/bin/env bun
import { randomBytes } from "node:crypto";
import { createBugzillaClient } from "@bugzilla-mcp/bugzilla-client";
import type { PrincipalContext } from "@bugzilla-mcp/contracts";
import { createCloudApprovalTokenService } from "@bugzilla-mcp/core";
import { createSqliteStorage } from "@bugzilla-mcp/storage";
import { type HttpServerConfig, runStdioServer, startMcpHttpServer } from "./index.js";

function parseFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : undefined;
}

function parseFiniteNonNegativeInt(
  name: string,
  raw: string | undefined,
  fallback: number,
  options?: { readonly min?: number; readonly max?: number },
): number {
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw.trim());
  const min = options?.min ?? 0;
  const max = options?.max;
  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    parsed < min ||
    (max !== undefined && parsed > max)
  ) {
    const rangeDesc = max !== undefined ? `${min}..${max}` : `>= ${min}`;
    throw new Error(
      `Invalid numeric configuration for ${name}="${raw}": expected integer (${rangeDesc})`,
    );
  }
  return parsed;
}

async function main() {
  const transport = parseFlag("transport") ?? process.env.MCP_TRANSPORT ?? "stdio";
  const baseUrl = process.env.BUGZILLA_BASE_URL ?? "http://127.0.0.1:18080";
  const apiKey = process.env.BUGZILLA_API_KEY ?? "";
  const allowQueryFallback = process.env.BUGZILLA_ALLOW_QUERY_FALLBACK === "true";
  const dbPath = process.env.BUGZILLA_DB_PATH ?? ":memory:";
  const mode =
    process.env.MCP_DEPLOYMENT_MODE === "cloud-multi-user"
      ? ("cloud-multi-user" as const)
      : ("local-trusted-ide" as const);
  const eventsProfile =
    process.env.MCP_EVENTS_PROFILE === "chatgpt-events"
      ? ("chatgpt-events" as const)
      : ("sep-3415" as const);

  // Reject unsupported cloud/stdio combination and fail fast on incomplete cloud config (AUTH-09, RUNTIME-01)
  if (mode === "cloud-multi-user") {
    if (transport === "stdio") {
      throw new Error(
        "cloud-multi-user mode cannot run over stdio transport; use --transport=http",
      );
    }
    throw new Error(
      "cloud-multi-user mode requires programmatic OAuth bearer verifier, opener-session verifier, and encrypted credential vault wiring via startMcpHttpServer()",
    );
  }

  const lagWindowMs = parseFiniteNonNegativeInt(
    "MCP_LAG_WINDOW_MS",
    process.env.MCP_LAG_WINDOW_MS,
    3000,
    { min: 0 },
  );
  const maxWebhookRetries = parseFiniteNonNegativeInt(
    "MCP_MAX_WEBHOOK_RETRIES",
    process.env.MCP_MAX_WEBHOOK_RETRIES,
    3,
    { min: 0 },
  );
  const causalBudgetPerBug = parseFiniteNonNegativeInt(
    "MCP_CAUSAL_MAX_WRITES",
    process.env.MCP_CAUSAL_MAX_WRITES,
    5,
    { min: 1 },
  );
  const causalBudgetWindowMs = parseFiniteNonNegativeInt(
    "MCP_CAUSAL_WINDOW_MS",
    process.env.MCP_CAUSAL_WINDOW_MS,
    300_000,
    { min: 1 },
  );

  const allowedOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? "http://127.0.0.1,http://localhost")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const storage = createSqliteStorage(dbPath);
  const signingSecret = process.env.MCP_SIGNING_SECRET ?? randomBytes(32).toString("hex");
  const cloudApprovalService = createCloudApprovalTokenService(signingSecret, storage);

  const client = apiKey ? createBugzillaClient({ baseUrl, apiKey, allowQueryFallback }) : null;

  const localPrincipal: PrincipalContext = {
    issuer: "local://ide",
    principalId: process.env.BUGZILLA_PRINCIPAL_ID ?? "local-user",
    clientId: "local-ide",
    instanceUrl: baseUrl,
    credentialGeneration: 1,
    scopes: ["bz:read", "bz:write:safe", "bz:write:guarded", "bz:events"],
    deploymentMode: "local-trusted-ide",
  };

  // Per-installation bearer token required for local Streamable HTTP (AUTH-07, AUTH-08)
  const explicitLocalToken = process.env.MCP_LOCAL_TOKEN?.trim();
  const generatedToken = !explicitLocalToken;
  const localAuthToken = explicitLocalToken || randomBytes(24).toString("base64url");

  const config: HttpServerConfig = {
    mode: "local-trusted-ide",
    allowedOrigins,
    allowAbsentOrigin: true,
    eventsProfile,
    webhookEnabled: process.env.MCP_WEBHOOK_ENABLED === "true",
    readOnly: process.env.MCP_READ_ONLY === "true",
    bindingSecret: signingSecret,
    localPrincipal,
    localAuthToken,
    core: {
      storage,
      resolveClient: async () => client,
      lagWindowMs,
      maxWebhookRetries,
      causalBudgetPerBug,
      causalBudgetWindowMs,
      eventsProfile,
      cloudApprovalService,
    },
  };

  if (transport === "http") {
    const port = parseFiniteNonNegativeInt("PORT", parseFlag("port") ?? process.env.PORT, 3878, {
      min: 0,
      max: 65535,
    });
    const host = (parseFlag("host") ?? process.env.HOST ?? "127.0.0.1").trim();
    const running = await startMcpHttpServer({ config, host, port });
    process.stderr.write(
      `[bugzilla-mcp] Local HTTP listening on ${running.baseUrl}/mcp (Bearer token required)\n`,
    );
    if (generatedToken) {
      process.stderr.write(`[bugzilla-mcp] Generated local Bearer token: ${localAuthToken}\n`);
    }

    let shuttingDown = false;
    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.stderr.write(`[bugzilla-mcp] Received ${signal}, shutting down...\n`);
      void running
        .close()
        .then(() => process.exit(0))
        .catch((err) => {
          process.stderr.write(`[bugzilla-mcp] Shutdown error: ${String(err)}\n`);
          process.exit(1);
        });
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
    return;
  }

  await runStdioServer({ config, principal: localPrincipal });
}

if (import.meta.main) {
  void main().catch((err) => {
    process.stderr.write(`[bugzilla-mcp] Fatal startup error: ${String(err)}\n`);
    process.exit(1);
  });
}
