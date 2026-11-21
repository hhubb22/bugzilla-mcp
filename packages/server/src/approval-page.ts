import { randomBytes, timingSafeEqual } from "node:crypto";
import { RESERVED_LEGACY_ISSUER, type PrincipalContext } from "@bugzilla-mcp/contracts";
import type { StoredApprovalTicket, StoredProposal } from "@bugzilla-mcp/storage";
import type { DualEraHttpRequest, DualEraHttpResponse, HttpServerConfig } from "./index.js";

const APPROVAL_TICKET_TTL_MS = 10 * 60 * 1000;

interface ApprovalTicket {
  readonly ticketId: string;
  readonly csrfToken: string;
  readonly issuer: string;
  readonly approverPrincipalId: string;
  readonly instanceUrl: string;
  readonly proposalId: string;
  readonly revision: number;
  readonly bugId: number;
  readonly baseVersion: string;
  readonly visibility: "public" | "private";
  readonly expiresAtMs: number;
  consumed: boolean;
}

function escapeHtml(value: string): string {
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

export function createApprovalPageManager(config: HttpServerConfig) {
  const clock = config.core.clock ?? (() => Date.now());
  const publicBaseUrl = (config.publicBaseUrl ?? "https://mcp.example").replace(/\/+$/, "");
  const storage = config.core.storage;
  const tickets = new Map<string, ApprovalTicket>();

  async function loadTicket(ticketId: string): Promise<ApprovalTicket | undefined> {
    if (storage.getApprovalTicket) {
      const stored = await storage.getApprovalTicket(ticketId);
      if (!stored) return undefined;
      return { ...stored };
    }
    return tickets.get(ticketId);
  }

  return {
    async issueApprovalTicket(ctx: PrincipalContext, proposal: StoredProposal) {
      const ticketId = randomBytes(18).toString("base64url");
      const csrfToken = randomBytes(18).toString("base64url");
      // Guarded-Write updates (bug fields and/or public comments) are visible to bug readers
      const visibility = "public" as const;
      const expiresAtMs = clock() + APPROVAL_TICKET_TTL_MS;
      const record: StoredApprovalTicket = {
        ticketId,
        csrfToken,
        issuer: ctx.issuer,
        approverPrincipalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
        proposalId: proposal.proposalId,
        revision: proposal.revision,
        bugId: proposal.bugId,
        baseVersion: proposal.baseVersion,
        visibility,
        expiresAtMs,
        consumed: false,
      };
      tickets.set(ticketId, { ...record });
      await storage.saveApprovalTicket?.(record);
      return {
        ticketId,
        approvalUrl: `${publicBaseUrl}/approve?t=${encodeURIComponent(ticketId)}`,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },

    async handleApproveGet(req: DualEraHttpRequest): Promise<DualEraHttpResponse> {
      const url = new URL(req.path, publicBaseUrl);
      const ticketId = url.searchParams.get("t");
      if (!ticketId) {
        return { status: 400, headers: { "content-type": "text/plain" }, body: "Missing ticket" };
      }
      const ticket = await loadTicket(ticketId);
      if (!ticket || clock() >= ticket.expiresAtMs || ticket.consumed) {
        return {
          status: 410,
          headers: { "content-type": "text/plain" },
          body: "Approval ticket expired or already consumed",
        };
      }
      if (!config.verifyBindingOpenerSession) {
        return {
          status: 403,
          headers: { "content-type": "text/plain" },
          body: "Approver verification unavailable",
        };
      }
      const opener = await config.verifyBindingOpenerSession(req);
      if (
        !opener ||
        opener.issuer === RESERVED_LEGACY_ISSUER ||
        opener.issuer !== ticket.issuer ||
        opener.principalId !== ticket.approverPrincipalId
      ) {
        return {
          status: 403,
          headers: { "content-type": "text/plain" },
          body: "Approver identity does not match proposal principal",
        };
      }
      // Re-verify live target bug visibility before rendering proposal diff (AUTH-05)
      const client = await config.core.resolveClient({
        issuer: ticket.issuer,
        principalId: ticket.approverPrincipalId,
        clientId: "approval-page",
        instanceUrl: ticket.instanceUrl,
        credentialGeneration: 1,
        scopes: ["bz:read", "bz:write:guarded"],
        deploymentMode: config.mode,
      });
      if (!client || (await client.checkVisibility(ticket.bugId)) !== "visible") {
        return {
          status: 404,
          headers: { "content-type": "text/plain" },
          body: "Proposal not found or inaccessible",
        };
      }
      const proposal = await config.core.storage.getProposal(
        ticket.issuer,
        ticket.approverPrincipalId,
        ticket.instanceUrl,
        ticket.proposalId,
        ticket.revision,
      );
      if (!proposal) {
        return {
          status: 404,
          headers: { "content-type": "text/plain" },
          body: "Proposal not found",
        };
      }

      const html = [
        "<!doctype html>",
        '<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">',
        "<title>Approve Bugzilla Proposal</title></head><body>",
        `<h1>Approve Guarded Write for Bug #${ticket.bugId}</h1>`,
        `<p>Instance: <code>${escapeHtml(ticket.instanceUrl)}</code></p>`,
        `<p>Proposal: <code>${escapeHtml(ticket.proposalId)}</code> (rev ${ticket.revision})</p>`,
        `<p>Visibility: <strong>${escapeHtml(ticket.visibility.toUpperCase())}</strong></p>`,
        `<pre>${escapeHtml(JSON.stringify(proposal.diff, null, 2))}</pre>`,
        `<form method="POST" action="/approve?t=${escapeHtml(ticketId)}">`,
        `<input type="hidden" name="t" value="${escapeHtml(ticketId)}" />`,
        `<input type="hidden" name="csrf" value="${escapeHtml(ticket.csrfToken)}" />`,
        `<button type="submit" name="decision" value="approve">Issue Single-Use Approval Token</button>`,
        "</form></body></html>",
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

    async handleApprovePost(req: DualEraHttpRequest): Promise<DualEraHttpResponse> {
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
          body: "Forbidden or missing origin on approval submission",
        };
      }
      const url = new URL(req.path, publicBaseUrl);
      const form = new URLSearchParams(req.rawBody);
      const ticketId = form.get("t") ?? url.searchParams.get("t");
      const csrf = form.get("csrf");
      if (!ticketId || !csrf) {
        return {
          status: 400,
          headers: { "content-type": "text/plain" },
          body: "Missing required approval fields",
        };
      }
      const ticket = await loadTicket(ticketId);
      if (!ticket || clock() >= ticket.expiresAtMs || ticket.consumed) {
        return {
          status: 410,
          headers: { "content-type": "text/plain" },
          body: "Approval ticket expired or already consumed",
        };
      }
      const a = Buffer.from(csrf, "utf8");
      const b = Buffer.from(ticket.csrfToken, "utf8");
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return { status: 403, headers: { "content-type": "text/plain" }, body: "Invalid CSRF" };
      }
      if (!config.verifyBindingOpenerSession || !config.core.cloudApprovalService) {
        return {
          status: 500,
          headers: { "content-type": "text/plain" },
          body: "Cloud approval service not configured",
        };
      }
      const opener = await config.verifyBindingOpenerSession(req);
      if (
        !opener ||
        opener.issuer === RESERVED_LEGACY_ISSUER ||
        opener.issuer !== ticket.issuer ||
        opener.principalId !== ticket.approverPrincipalId
      ) {
        return {
          status: 403,
          headers: { "content-type": "text/plain" },
          body: "Approver identity mismatch",
        };
      }
      const proposal = await config.core.storage.getProposal(
        ticket.issuer,
        ticket.approverPrincipalId,
        ticket.instanceUrl,
        ticket.proposalId,
        ticket.revision,
      );
      if (!proposal) {
        return { status: 404, headers: { "content-type": "text/plain" }, body: "Proposal missing" };
      }
      const nowMs = clock();
      if (storage.consumeApprovalTicket) {
        const claimed = await storage.consumeApprovalTicket(ticketId, nowMs);
        if (!claimed) {
          return {
            status: 410,
            headers: { "content-type": "text/plain" },
            body: "Ticket consumed",
          };
        }
      } else {
        const local = tickets.get(ticketId);
        if (!local || nowMs >= local.expiresAtMs || local.consumed) {
          return {
            status: 410,
            headers: { "content-type": "text/plain" },
            body: "Ticket consumed",
          };
        }
        local.consumed = true;
      }
      const issued = await config.core.cloudApprovalService.issue({
        approverIssuer: ticket.issuer,
        approverPrincipalId: ticket.approverPrincipalId,
        instanceUrl: ticket.instanceUrl,
        proposalId: proposal.proposalId,
        revision: proposal.revision,
        bugId: proposal.bugId,
        baseVersion: proposal.baseVersion,
        diff: proposal.diff,
        visibility: ticket.visibility,
        ttlMs: APPROVAL_TICKET_TTL_MS,
        nowMs,
      });
      return {
        status: 200,
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
        },
        body: JSON.stringify({
          proposalId: proposal.proposalId,
          revision: proposal.revision,
          approvalToken: issued.token,
          expiresAt: issued.expiresAt,
        }),
      };
    },
  };
}
