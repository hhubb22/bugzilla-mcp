import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createDualEraHttpHandler,
  type DualEraHttpRequest,
  type HttpServerConfig,
} from "./index.js";

export interface RunningHttpServer {
  readonly port: number;
  readonly host: string;
  readonly baseUrl: string;
  close(): Promise<void>;
}

const MAX_REQUEST_BODY_BYTES = 1024 * 1024; // 1 MiB

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

  const handler = createDualEraHttpHandler(params.config);
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
  return {
    port: actualPort,
    host,
    baseUrl: `http://${host}:${actualPort}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
