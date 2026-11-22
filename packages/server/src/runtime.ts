import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createSyntheticEventsService, startWebhookDeliveryLoop } from "@bugzilla-mcp/core";
import { buildDualEraHttpHandler } from "./http-handler.js";
import type { DualEraHttpRequest, HttpServerConfig } from "./index.js";
import { httpsWebhookTransport } from "./webhook-transport.js";

export interface RunningHttpServer {
  readonly port: number;
  readonly host: string;
  readonly baseUrl: string;
  close(): Promise<void>;
}

const MAX_REQUEST_BODY_BYTES = 1024 * 1024; // 1 MiB
const WEBHOOK_INTERVAL_MS = 250;

async function configureWebhooks(config: HttpServerConfig): Promise<HttpServerConfig> {
  if (config.webhookEnabled !== true) return { ...config, webhookEnabled: false };

  const storage = config.core.storage;
  const local = config.mode === "local-trusted-ide" && !config.authenticateBearerToken;
  const authenticated = local
    ? Boolean(config.localAuthToken?.trim())
    : !!config.authenticateBearerToken;
  const bindingAvailable = local
    ? config.localPrincipal !== undefined &&
      Boolean(await config.core.resolveClient(config.localPrincipal).catch(() => null))
    : !!(config.resolveWebhookPrincipal || storage.getBoundCredential);
  const transport = config.core.webhookTransport ?? httpsWebhookTransport;
  const retryLimit = config.core.maxWebhookRetries ?? 3;
  if (
    !authenticated ||
    !bindingAvailable ||
    !storage.durableWebhooks ||
    !storage.listWebhookGrants ||
    !storage.listWebhookRetryItems ||
    !storage.upsertWebhookRetryItem ||
    !storage.deleteWebhookRetryItem ||
    typeof transport.resolveHost !== "function" ||
    typeof transport.postPinned !== "function" ||
    !Number.isSafeInteger(retryLimit) ||
    retryLimit < 0
  ) {
    throw Object.assign(
      new Error(
        "Webhook delivery requires authentication, current bindings, durable storage and an HTTPS sender",
      ),
      {
        code: "WebhookConfigurationError",
      },
    );
  }

  return {
    ...config,
    core: {
      ...config.core,
      eventsProfile: config.eventsProfile,
      webhookEnabled: true,
      webhookTransport: transport,
      async revalidateWebhookGrant(grant) {
        if (config.resolveWebhookPrincipal) return config.resolveWebhookPrincipal(grant);
        if (local) return config.localPrincipal ?? null;
        const binding = await storage.getBoundCredential?.(
          grant.issuer,
          grant.principalId,
          grant.instanceUrl,
        );
        return binding?.credentialGeneration === grant.credentialGeneration ? grant : null;
      },
      onWebhookScanState(subscriptionId, state) {
        process.stderr.write(
          `${JSON.stringify({ event: "mcp.events.scan", subscriptionId, state })}\n`,
        );
      },
    },
  };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_REQUEST_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body exceeds 1 MiB limit"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function normalizeHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) out[k] = v.join(", ");
    else out[k] = v;
  }
  return out;
}

/**
 * Starts a real Streamable HTTP MCP server bound to loopback by default in local mode.
 * Works natively in both Bun 1.4+ and Node 24/26 via node:http.
 */
export async function startMcpHttpServer(params: {
  config: HttpServerConfig;
  host?: string;
  port?: number;
}): Promise<RunningHttpServer> {
  const host = params.host ?? "127.0.0.1";
  if (
    params.config.mode === "local-trusted-ide" &&
    host !== "127.0.0.1" &&
    host !== "localhost" &&
    host !== "::1"
  ) {
    throw new Error(
      "local-trusted-ide mode must bind strictly to loopback (127.0.0.1 / localhost / ::1)",
    );
  }

  const config = await configureWebhooks(params.config);
  const events = createSyntheticEventsService({
    ...config.core,
    eventsProfile: config.eventsProfile,
    webhookEnabled: config.webhookEnabled === true,
  });
  const handler = buildDualEraHttpHandler(config, events);
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        // Local HTTP mode must strictly reject non-loopback Host headers (DNS rebinding guard: AUTH-07)
        if (params.config.mode === "local-trusted-ide") {
          const hostHeader = (req.headers.host ?? "").toLowerCase();
          const hostnameOnly = hostHeader.startsWith("[")
            ? hostHeader.slice(0, hostHeader.indexOf("]") + 1)
            : hostHeader.split(":")[0];
          if (
            hostnameOnly !== "127.0.0.1" &&
            hostnameOnly !== "localhost" &&
            hostnameOnly !== "[::1]"
          ) {
            res.statusCode = 403;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ error: "Forbidden Host header for local mode" }));
            return;
          }
        }
        const rawBody = await readBody(req);
        const dualReq: DualEraHttpRequest = {
          method: req.method ?? "GET",
          path: req.url ?? "/",
          headers: normalizeHeaders(req),
          rawBody,
        };
        const dualRes = await handler.handleHttp(dualReq);
        res.statusCode = dualRes.status;
        for (const [k, v] of Object.entries(dualRes.headers)) {
          res.setHeader(k, v);
        }
        res.end(dualRes.body);
      } catch (err) {
        res.statusCode = err instanceof Error && err.message.includes("1 MiB") ? 413 : 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Request processing failed" }));
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params.port ?? 0, host, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address() as AddressInfo;
  const actualPort = addr.port;
  const delivery = config.webhookEnabled
    ? startWebhookDeliveryLoop({
        events,
        listPrincipals: () => config.core.storage.listWebhookGrants!(),
        intervalMs: WEBHOOK_INTERVAL_MS,
      })
    : undefined;
  return {
    port: actualPort,
    host,
    baseUrl: `http://${host}:${actualPort}`,
    async close() {
      await Promise.all([
        delivery?.stop(),
        new Promise<void>((resolve, reject) => {
          server.close((err) => (err ? reject(err) : resolve()));
        }),
      ]);
    },
  };
}
