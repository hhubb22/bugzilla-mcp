import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { checkServerIdentity } from "node:tls";
import type { WebhookOutboundTransport } from "@bugzilla-mcp/core";

const REQUEST_DEADLINE_MS = 8_000;
const MAX_RESPONSE_BYTES = 16 * 1024;

export const httpsWebhookTransport: WebhookOutboundTransport = {
  async resolveHost(hostname) {
    const host = hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) return [host];
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(
        () => reject(new Error("Webhook DNS lookup timed out")),
        REQUEST_DEADLINE_MS,
      );
      void lookup(host, { all: true, verbatim: true }).then(
        (answers) => {
          clearTimeout(deadline);
          resolve(answers.map(({ address }) => address));
        },
        (error: unknown) => {
          clearTimeout(deadline);
          reject(error);
        },
      );
    });
  },

  async postPinned(input) {
    const target = new URL(input.url);
    const address = input.resolvedIp.replace(/^\[|\]$/g, "");
    const serverName = input.tlsSni.replace(/^\[|\]$/g, "");
    if (target.protocol !== "https:" || !isIP(address)) {
      throw new Error("Webhook requires a pinned HTTPS address");
    }
    return new Promise((resolve, reject) => {
      // The socket endpoint is already resolved. Do not follow redirect responses or
      // reuse a socket selected for an earlier DNS result.
      const outbound = request(
        {
          hostname: address,
          port: target.port || 443,
          path: `${target.pathname}${target.search}`,
          method: "POST",
          agent: false,
          servername: isIP(serverName) ? "" : serverName,
          checkServerIdentity: (_host, certificate) => checkServerIdentity(serverName, certificate),
          rejectUnauthorized: true,
          signal: AbortSignal.timeout(REQUEST_DEADLINE_MS),
          headers: {
            ...input.headers,
            host: input.hostHeader,
            "content-length": Buffer.byteLength(input.rawBody),
          },
        },
        (response) => {
          const status = response.statusCode ?? 500;
          const chunks: Buffer[] = [];
          let received = 0;
          response.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_RESPONSE_BYTES) {
              resolve({ status, body: "" });
              response.destroy();
            } else {
              chunks.push(chunk);
            }
          });
          response.once("end", () =>
            resolve({ status, body: Buffer.concat(chunks).toString("utf8") }),
          );
          response.once("error", reject);
        },
      );
      outbound.once("error", reject);
      outbound.end(input.rawBody);
    });
  },
};
