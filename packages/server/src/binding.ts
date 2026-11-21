import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { RESERVED_LEGACY_ISSUER, type PrincipalContext } from "@bugzilla-mcp/contracts";
import type { DualEraHttpRequest, DualEraHttpResponse, HttpServerConfig } from "./index.js";

const TICKET_TTL_MS = 10 * 60 * 1000;

interface TicketRecord {
  readonly ticketId: string;
  readonly csrfToken: string;
  readonly issuer: string;
  readonly principalId: string;
  readonly clientId: string;
  readonly instanceUrl: string;
  readonly expiresAtMs: number;
  completed: boolean;
  completedGeneration?: number;
}

interface SignedStatePayload {
  readonly stateId: string;
  readonly ticketId: string;
  readonly issuer: string;
  readonly principalId: string;
  readonly clientId: string;
  readonly instanceUrl: string;
  readonly toolName: string;
  readonly paramsHash: string;
  readonly expiresAtMs: number;
}

function sign(secret: string, encoded: string): string {
  return createHmac("sha256", secret).update(encoded, "utf8").digest("base64url");
}

function escapeAttr(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function createBindingManager(config: HttpServerConfig) {
  const secret = config.bindingSecret ?? randomBytes(32).toString("hex");
  const clock = config.core.clock ?? (() => Date.now());
  const publicBaseUrl = (config.publicBaseUrl ?? "https://mcp.example").replace(/\/+$/, "");

  const tickets = new Map<string, TicketRecord>();
  const consumedStates = new Set<string>();
  const storage = config.core.storage;

  async function loadTicket(ticketId: string): Promise<TicketRecord | undefined> {
    // Always prefer durable SQLite state across workers when available (AUTH-01)
    if (storage.getBindingTicket) {
      const stored = await storage.getBindingTicket(ticketId);
      if (!stored) return undefined;
      return {
        ticketId: stored.ticketId,
        csrfToken: stored.csrfToken,
        issuer: stored.issuer,
        principalId: stored.principalId,
        clientId: stored.clientId,
        instanceUrl: stored.instanceUrl,
        expiresAtMs: stored.expiresAtMs,
        completed: stored.completed,
        ...(stored.credentialGeneration !== undefined
          ? { completedGeneration: stored.credentialGeneration }
          : {}),
      };
    }
    return tickets.get(ticketId);
  }

  return {
    async issueChallenge(ctx: PrincipalContext, toolName: string, paramsHash: string) {
      const nowMs = clock();
      const expiresAtMs = nowMs + TICKET_TTL_MS;
      const ticketId = randomBytes(18).toString("base64url");
      const csrfToken = randomBytes(18).toString("base64url");
      const stateId = randomBytes(18).toString("base64url");

      tickets.set(ticketId, {
        ticketId,
        csrfToken,
        issuer: ctx.issuer,
        principalId: ctx.principalId,
        clientId: ctx.clientId,
        instanceUrl: ctx.instanceUrl,
        expiresAtMs,
        completed: false,
      });
      await storage.saveBindingTicket?.({
        ticketId,
        issuer: ctx.issuer,
        principalId: ctx.principalId,
        clientId: ctx.clientId,
        instanceUrl: ctx.instanceUrl,
        toolName,
        paramsHash,
        expiresAtMs,
        csrfToken,
        completed: false,
      });

      const payload: SignedStatePayload = {
        stateId,
        ticketId,
        issuer: ctx.issuer,
        principalId: ctx.principalId,
        clientId: ctx.clientId,
        instanceUrl: ctx.instanceUrl,
        toolName,
        paramsHash,
        expiresAtMs,
      };
      const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      const requestState = `${encoded}.${sign(secret, encoded)}`;

      return {
        inputId: "bind_bugzilla_api_key",
        requestState,
        url: `${publicBaseUrl}/bind?t=${encodeURIComponent(ticketId)}`,
      };
    },

    async handleBindGet(req: DualEraHttpRequest): Promise<DualEraHttpResponse> {
      const url = new URL(req.path, publicBaseUrl);
      const ticketId = url.searchParams.get("t");
      if (!ticketId) {
        return { status: 400, headers: { "content-type": "text/plain" }, body: "Missing ticket" };
      }
      const ticket = await loadTicket(ticketId);
      if (!ticket || clock() >= ticket.expiresAtMs || ticket.completed) {
        return {
          status: 410,
          headers: { "content-type": "text/plain" },
          body: "Binding ticket expired or already used",
        };
      }
      if (!config.verifyBindingOpenerSession) {
        return {
          status: 403,
          headers: { "content-type": "text/plain" },
          body: "Opener verification unavailable",
        };
      }
      const opener = await config.verifyBindingOpenerSession(req);
      if (
        !opener ||
        opener.issuer === RESERVED_LEGACY_ISSUER ||
        opener.issuer !== ticket.issuer ||
        opener.principalId !== ticket.principalId
      ) {
        return {
          status: 403,
          headers: { "content-type": "text/plain" },
          body: "Opener identity does not match initiating principal",
        };
      }

      const apiKeyHelpUrl = `${ticket.instanceUrl.replace(/\/+$/, "")}/userprefs.cgi?tab=apikey`;
      const html = [
        "<!doctype html>",
        '<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">',
        "<title>Bind Bugzilla API Key</title></head><body>",
        "<h1>Bind Bugzilla API Key</h1>",
        `<p>Instance: <code>${escapeAttr(ticket.instanceUrl)}</code> · <a href="${escapeAttr(apiKeyHelpUrl)}" rel="noopener noreferrer" target="_blank">Generate API key in Bugzilla</a></p>`,
        `<form method="POST" action="/bind?t=${escapeAttr(ticketId)}">`,
        `<input type="hidden" name="t" value="${escapeAttr(ticketId)}" />`,
        `<input type="hidden" name="csrf" value="${escapeAttr(ticket.csrfToken)}" />`,
        `<label for="api_key">Bugzilla API Key</label>`,
        `<input id="api_key" type="password" name="api_key" required />`,
        `<button type="submit">Bind API Key</button>`,
        "</form>",
        "</body></html>",
      ].join("");

      return {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
        body: html,
      };
    },

    async handleBindPost(req: DualEraHttpRequest): Promise<DualEraHttpResponse> {
      const expectedOrigin = new URL(publicBaseUrl).origin;
      const reqOrigin = Object.entries(req.headers).find(
        ([k]) => k.toLowerCase() === "origin",
      )?.[1];
      if (
        (reqOrigin !== undefined && reqOrigin !== expectedOrigin) ||
        (reqOrigin === undefined && config.allowAbsentOrigin === false)
      ) {
        return {
          status: 403,
          headers: { "content-type": "text/plain" },
          body: "Forbidden or missing origin on binding submission",
        };
      }
      const url = new URL(req.path, publicBaseUrl);
      const form = new URLSearchParams(req.rawBody);
      const ticketId = form.get("t") ?? url.searchParams.get("t");
      const csrf = form.get("csrf");
      const apiKey = form.get("api_key");

      if (!ticketId || !csrf || !apiKey) {
        return {
          status: 400,
          headers: { "content-type": "text/plain" },
          body: "Missing required binding fields",
        };
      }
      const ticket = await loadTicket(ticketId);
      if (!ticket || clock() >= ticket.expiresAtMs || ticket.completed) {
        return {
          status: 410,
          headers: { "content-type": "text/plain" },
          body: "Binding ticket expired or already consumed",
        };
      }
      const csrfA = Buffer.from(csrf, "utf8");
      const csrfB = Buffer.from(ticket.csrfToken, "utf8");
      if (csrfA.length !== csrfB.length || !timingSafeEqual(csrfA, csrfB)) {
        return { status: 403, headers: { "content-type": "text/plain" }, body: "Invalid CSRF" };
      }

      if (!config.verifyBindingOpenerSession || !config.storeBoundApiKey) {
        return {
          status: 500,
          headers: { "content-type": "text/plain" },
          body: "Binding callbacks not configured",
        };
      }
      const opener = await config.verifyBindingOpenerSession(req);
      if (
        !opener ||
        opener.issuer === RESERVED_LEGACY_ISSUER ||
        opener.issuer !== ticket.issuer ||
        opener.principalId !== ticket.principalId
      ) {
        return {
          status: 403,
          headers: { "content-type": "text/plain" },
          body: "Opener identity mismatch",
        };
      }

      // Atomic check-and-claim AFTER async opener verification prevents concurrent double-submit (AUTH-01, AUTH-04)
      const nowMs = clock();
      if (nowMs >= ticket.expiresAtMs || ticket.completed) {
        return {
          status: 410,
          headers: { "content-type": "text/plain" },
          body: "Binding ticket expired or already consumed",
        };
      }
      const inMemoryTicket = tickets.get(ticketId);
      if (inMemoryTicket) {
        if (inMemoryTicket.completed) {
          return {
            status: 410,
            headers: { "content-type": "text/plain" },
            body: "Binding ticket expired or already consumed",
          };
        }
        inMemoryTicket.completed = true;
      }
      try {
        const stored = await config.storeBoundApiKey(
          {
            issuer: ticket.issuer,
            principalId: ticket.principalId,
            instanceUrl: ticket.instanceUrl,
          },
          apiKey,
        );
        if (storage.markBindingTicketCompleted) {
          const claimed = await storage.markBindingTicketCompleted(
            ticketId,
            stored.credentialGeneration,
            nowMs,
          );
          if (!claimed) {
            return {
              status: 410,
              headers: { "content-type": "text/plain" },
              body: "Binding ticket expired or already consumed",
            };
          }
        }
        if (inMemoryTicket) {
          inMemoryTicket.completedGeneration = stored.credentialGeneration;
        }
      } catch {
        if (inMemoryTicket) {
          inMemoryTicket.completed = false;
        }
        return {
          status: 400,
          headers: { "content-type": "text/plain" },
          body: "Failed to verify Bugzilla API key",
        };
      }

      return {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
        body: "<!doctype html><html><body><p>Bugzilla API key bound successfully. You may return to your MCP client.</p></body></html>",
      };
    },

    async verifyAndConsumeRetryState(
      requestState: string,
      ctx: PrincipalContext,
      toolName: string,
      paramsHash: string,
    ): Promise<boolean> {
      const parts = requestState.split(".");
      if (parts.length !== 2) return false;
      const [encoded, providedSig] = parts;
      if (!encoded || !providedSig) return false;

      const expectedSig = sign(secret, encoded);
      const a = Buffer.from(providedSig, "utf8");
      const b = Buffer.from(expectedSig, "utf8");
      if (a.length !== b.length || !timingSafeEqual(a, b)) return false;

      let payload: SignedStatePayload;
      try {
        payload = JSON.parse(
          Buffer.from(encoded, "base64url").toString("utf8"),
        ) as SignedStatePayload;
      } catch {
        return false;
      }

      const nowMs = clock();
      if (nowMs >= payload.expiresAtMs) return false;
      if (
        payload.issuer !== ctx.issuer ||
        payload.principalId !== ctx.principalId ||
        payload.clientId !== ctx.clientId ||
        payload.instanceUrl !== ctx.instanceUrl ||
        payload.toolName !== toolName ||
        payload.paramsHash !== paramsHash
      ) {
        return false;
      }

      // Synchronous single-use check-and-mark BEFORE async awaits prevents concurrent Promise.all double-use
      if (consumedStates.has(payload.stateId)) {
        return false;
      }
      consumedStates.add(payload.stateId);

      const ticket = await loadTicket(payload.ticketId);
      if (
        !ticket ||
        !ticket.completed ||
        ticket.completedGeneration === undefined ||
        ticket.completedGeneration !== ctx.credentialGeneration
      ) {
        consumedStates.delete(payload.stateId);
        return false;
      }

      if (storage.consumeRetryState) {
        const fresh = await storage.consumeRetryState(payload.stateId, payload.expiresAtMs, nowMs);
        if (!fresh) {
          return false;
        }
      }
      return true;
    },
  };
}
