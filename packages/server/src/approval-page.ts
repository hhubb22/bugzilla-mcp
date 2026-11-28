import { randomBytes, timingSafeEqual } from "node:crypto";
import { toPromiseBugzillaClient } from "@bugzilla-mcp/bugzilla-client";
import {
  RESERVED_LEGACY_ISSUER,
  type PrincipalContext,
  type PrincipalScope,
  type WriteGuardOutcome,
} from "@bugzilla-mcp/contracts";
import {
  asEffectBugzillaClient,
  createWriteGuardService,
  type WriteGuardService,
} from "@bugzilla-mcp/core";
import type { StoredApprovalTicket, StoredProposal } from "@bugzilla-mcp/storage";
import { projectToolExecutionError } from "./error-projector.js";
import type { DualEraHttpRequest, DualEraHttpResponse, HttpServerConfig } from "./index.js";

const APPROVAL_TICKET_TTL_MS = 10 * 60 * 1000;
const MAX_IN_MEMORY_TICKETS = 4096;

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
  readonly scopes: readonly PrincipalScope[];
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

function parseAcceptQuality(acceptHeader: string | undefined, targetType: string): number {
  if (!acceptHeader) return -1;
  const loweredTarget = targetType.toLowerCase();
  let best = -1;
  for (const rawPart of acceptHeader.split(",")) {
    const [rawMedia, ...params] = rawPart.trim().split(";");
    const media = (rawMedia ?? "").trim().toLowerCase();
    if (media !== loweredTarget) continue;
    let q = 1;
    for (const param of params) {
      const [k, v] = param.split("=");
      if (k?.trim().toLowerCase() === "q" && v !== undefined) {
        const parsed = Number.parseFloat(v.trim());
        if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
          q = parsed;
        }
      }
    }
    if (q > best) best = q;
  }
  return best;
}

/**
 * RFC 9110 content negotiation: returns true when the caller explicitly requests `text/html`
 * with quality >= `application/json` (e.g. browser form submission from TriageWorkbench).
 * Programmatic `fetch` callers sending `Accept: application/json`, `* /*`, or no Accept header
 * receive JSON `{ approvalToken }` / `{ decision: "rejected" }`.
 */
export function acceptsHtmlPreference(acceptHeader: string | undefined): boolean {
  const htmlQ = parseAcceptQuality(acceptHeader, "text/html");
  if (htmlQ <= 0) return false;
  const jsonQ = parseAcceptQuality(acceptHeader, "application/json");
  return jsonQ < 0 || htmlQ >= jsonQ;
}

function renderHtmlPage(title: string, bodyHtml: string, status = 200): DualEraHttpResponse {
  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">',
    `<title>${escapeHtml(title)}</title></head><body>`,
    bodyHtml,
    "</body></html>",
  ].join("");
  return {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
    body: html,
  };
}

function renderOutcomeHtml(
  proposal: StoredProposal,
  outcome: WriteGuardOutcome,
): DualEraHttpResponse {
  switch (outcome.outcome) {
    case "Applied":
      return renderHtmlPage(
        "Proposal Applied",
        [
          `<h1>Proposal Applied to Bug #${proposal.bugId}</h1>`,
          `<p>Status: <strong>Applied</strong></p>`,
          `<p>Proposal: <code>${escapeHtml(proposal.proposalId)}</code> (rev ${proposal.revision})</p>`,
          `<p>Artifact: <code>${escapeHtml(outcome.artifactId)}</code></p>`,
          `<p>You may close this tab and refresh the Bugzilla Triage Workbench.</p>`,
        ].join(""),
        200,
      );
    case "ProposalRejected":
      return renderHtmlPage(
        "Proposal Rejected",
        [
          `<h1>Proposal Rejected for Bug #${proposal.bugId}</h1>`,
          `<p>Status: <strong>ProposalRejected</strong></p>`,
          `<p>Proposal: <code>${escapeHtml(outcome.proposalId)}</code> (rev ${outcome.revision})</p>`,
          `<p>No upstream Bugzilla mutation was performed. You may close this tab.</p>`,
        ].join(""),
        200,
      );
    case "DuplicateNoOp":
      return renderHtmlPage(
        "Proposal Already Applied",
        [
          `<h1>Proposal Already Applied for Bug #${proposal.bugId}</h1>`,
          `<p>Status: <strong>DuplicateNoOp</strong></p>`,
          `<p>Original artifact: <code>${escapeHtml(outcome.originalArtifactId)}</code></p>`,
        ].join(""),
        200,
      );
    case "StaleBugConflict":
      return renderHtmlPage(
        "Stale Bug Conflict",
        [
          `<h1>Stale Bug Conflict for Bug #${proposal.bugId}</h1>`,
          `<p>Status: <strong>StaleBugConflict</strong></p>`,
          `<p>Expected last change: <code>${escapeHtml(outcome.expectedLastChangeTime)}</code></p>`,
          `<p>Actual last change: <code>${escapeHtml(outcome.actualLastChangeTime)}</code></p>`,
          `<p>Latest bug status: <strong>${escapeHtml(outcome.latestAuthorizedSnapshot.status)}</strong></p>`,
          `<p>Latest summary: ${escapeHtml(outcome.latestAuthorizedSnapshot.summary)}</p>`,
          `<p>Return to the Triage Workbench to refresh the dossier and create a new proposal.</p>`,
        ].join(""),
        409,
      );
    case "OperationIndeterminate":
      return renderHtmlPage(
        "Reconciliation Required",
        [
          `<h1>Reconciliation Required for Bug #${proposal.bugId}</h1>`,
          `<p>Status: <strong>OperationIndeterminate</strong></p>`,
          `<p>${escapeHtml(outcome.reconciliationHint)}</p>`,
          `<p>Idempotency key: <code>${escapeHtml(outcome.idempotencyKey)}</code></p>`,
        ].join(""),
        502,
      );
    case "UpstreamRejected": {
      const missingHtml =
        outcome.missingFields && outcome.missingFields.length > 0
          ? `<p>Missing fields: <code>${escapeHtml(outcome.missingFields.join(", "))}</code></p>`
          : "";
      return renderHtmlPage(
        "Bugzilla Rejected Update",
        [
          `<h1>Bugzilla Rejected Update for Bug #${proposal.bugId}</h1>`,
          `<p>Status: <strong>UpstreamRejected</strong></p>`,
          `<p>Reason: ${escapeHtml(outcome.reason)}</p>`,
          missingHtml,
          `<p>Remediation: ${escapeHtml(outcome.remediationHint)}</p>`,
        ].join(""),
        422,
      );
    }
    case "CausalBudgetExhausted":
      return renderHtmlPage(
        "Write Budget Exhausted",
        [
          `<h1>Write Budget Exhausted for Bug #${proposal.bugId}</h1>`,
          `<p>Status: <strong>CausalBudgetExhausted</strong></p>`,
          `<p>Retry after ${outcome.retryAfterMs}ms.</p>`,
        ].join(""),
        429,
      );
    case "OperationPending":
      return renderHtmlPage(
        "Operation In Flight",
        [
          `<h1>Operation In Flight for Bug #${proposal.bugId}</h1>`,
          `<p>Status: <strong>OperationPending</strong></p>`,
          `<p>Idempotency key: <code>${escapeHtml(outcome.idempotencyKey)}</code></p>`,
        ].join(""),
        409,
      );
    case "IdempotencyConflict":
      return renderHtmlPage(
        "Idempotency Conflict",
        [
          `<h1>Idempotency Conflict for Bug #${proposal.bugId}</h1>`,
          `<p>Status: <strong>IdempotencyConflict</strong></p>`,
          `<p>Idempotency key: <code>${escapeHtml(outcome.idempotencyKey)}</code></p>`,
        ].join(""),
        409,
      );
    case "ProposalPending":
    case "SavedAsInternalNote":
      return renderHtmlPage(
        "Proposal Status",
        `<p>Outcome: <strong>${escapeHtml(outcome.outcome)}</strong></p>`,
        200,
      );
  }
}

export function createApprovalPageManager(
  config: HttpServerConfig,
  writeGuardOverride?: WriteGuardService,
) {
  const clock = config.core.clock ?? (() => Date.now());
  const publicBaseUrl = (config.publicBaseUrl ?? "https://mcp.example").replace(/\/+$/, "");
  const storage = config.core.storage;
  const writeGuard = writeGuardOverride ?? createWriteGuardService(config.core);
  const tickets = new Map<string, ApprovalTicket>();

  function pruneInMemoryTickets(nowMs: number): void {
    for (const [id, entry] of tickets) {
      if (entry.consumed || nowMs >= entry.expiresAtMs) {
        tickets.delete(id);
      }
    }
    while (tickets.size >= MAX_IN_MEMORY_TICKETS) {
      const oldest = tickets.keys().next().value;
      if (oldest === undefined) break;
      tickets.delete(oldest);
    }
  }

  async function loadTicket(ticketId: string): Promise<ApprovalTicket | undefined> {
    if (storage.getApprovalTicket) {
      const stored = await storage.getApprovalTicket(ticketId);
      if (!stored) return undefined;
      return {
        ...stored,
        scopes: [...stored.scopes],
      };
    }
    return tickets.get(ticketId);
  }

  async function buildLiveApproverContext(ticket: ApprovalTicket): Promise<PrincipalContext> {
    const bound = await storage.getBoundCredential?.(
      ticket.issuer,
      ticket.approverPrincipalId,
      ticket.instanceUrl,
    );
    return {
      issuer: ticket.issuer,
      principalId: ticket.approverPrincipalId,
      clientId: "approval-page",
      instanceUrl: ticket.instanceUrl,
      credentialGeneration: bound?.credentialGeneration ?? 1,
      scopes: [...ticket.scopes],
      deploymentMode: config.mode,
    };
  }

  function errorResponse(status: number, message: string, htmlMode: boolean): DualEraHttpResponse {
    if (htmlMode) {
      return renderHtmlPage(
        "Approval Error",
        `<h1>Approval Error</h1><p>${escapeHtml(message)}</p>`,
        status,
      );
    }
    return {
      status,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      body: message,
    };
  }

  return {
    async issueApprovalTicket(ctx: PrincipalContext, proposal: StoredProposal) {
      const nowMs = clock();
      pruneInMemoryTickets(nowMs);
      const ticketId = randomBytes(18).toString("base64url");
      const csrfToken = randomBytes(18).toString("base64url");
      // Guarded-Write updates (bug fields and/or public comments) are visible to bug readers
      const visibility = "public" as const;
      const expiresAtMs = nowMs + APPROVAL_TICKET_TTL_MS;
      const persistedScopes: PrincipalScope[] = [...ctx.scopes];
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
        scopes: persistedScopes,
        expiresAtMs,
        consumed: false,
      };
      tickets.set(ticketId, { ...record, scopes: [...persistedScopes] });
      await storage.saveApprovalTicket?.(record);
      return {
        ticketId,
        approvalUrl: `${publicBaseUrl}/approve?t=${encodeURIComponent(ticketId)}`,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
    },

    async handleApproveGet(req: DualEraHttpRequest): Promise<DualEraHttpResponse> {
      try {
        if (config.readOnly === true) {
          return errorResponse(
            403,
            "Connector is read-only; proposal approvals are disabled",
            false,
          );
        }
        const url = new URL(req.path, publicBaseUrl);
        const ticketId = url.searchParams.get("t");
        if (!ticketId) {
          return errorResponse(400, "Missing ticket", false);
        }
        const ticket = await loadTicket(ticketId);
        if (!ticket || clock() >= ticket.expiresAtMs || ticket.consumed) {
          return errorResponse(410, "Approval ticket expired or already consumed", false);
        }
        if (!ticket.scopes.includes("bz:write:guarded")) {
          return errorResponse(403, "Insufficient scope: requires bz:write:guarded", false);
        }
        if (!config.verifyBindingOpenerSession) {
          return errorResponse(403, "Approver verification unavailable", false);
        }
        const opener = await config.verifyBindingOpenerSession(req);
        if (
          !opener ||
          opener.issuer === RESERVED_LEGACY_ISSUER ||
          opener.issuer !== ticket.issuer ||
          opener.principalId !== ticket.approverPrincipalId
        ) {
          return errorResponse(403, "Approver identity does not match proposal principal", false);
        }

        // Re-verify live credential generation and target bug visibility before rendering proposal diff (AUTH-05)
        const approverCtx = await buildLiveApproverContext(ticket);
        const rawClient = await config.core.resolveClient(approverCtx);
        if (!rawClient) {
          return errorResponse(401, "Bugzilla API key is not bound or was revoked", false);
        }
        const client = toPromiseBugzillaClient(asEffectBugzillaClient(rawClient));
        const vis = await client.checkVisibility(ticket.bugId);
        if (vis === "credential_revoked") {
          return errorResponse(401, "Bugzilla API key was revoked or rejected", false);
        }
        if (vis !== "visible") {
          return errorResponse(404, "Proposal not found or inaccessible", false);
        }

        const proposal = await storage.getProposal(
          ticket.issuer,
          ticket.approverPrincipalId,
          ticket.instanceUrl,
          ticket.proposalId,
          ticket.revision,
        );
        if (!proposal) {
          return errorResponse(404, "Proposal not found", false);
        }

        return renderHtmlPage(
          "Approve Bugzilla Proposal",
          [
            `<h1>Approve Guarded Write for Bug #${ticket.bugId}</h1>`,
            `<p>Instance: <code>${escapeHtml(ticket.instanceUrl)}</code></p>`,
            `<p>Proposal: <code>${escapeHtml(ticket.proposalId)}</code> (rev ${ticket.revision})</p>`,
            `<p>Visibility: <strong>${escapeHtml(ticket.visibility.toUpperCase())}</strong></p>`,
            `<pre>${escapeHtml(JSON.stringify(proposal.diff, null, 2))}</pre>`,
            `<form method="POST" action="/approve?t=${escapeHtml(encodeURIComponent(ticketId))}">`,
            `<input type="hidden" name="t" value="${escapeHtml(ticketId)}" />`,
            `<input type="hidden" name="csrf" value="${escapeHtml(ticket.csrfToken)}" />`,
            `<button type="submit" name="decision" value="approve">Approve and Apply Update</button> `,
            `<button type="submit" name="decision" value="reject">Reject Proposal</button>`,
            "</form>",
          ].join(""),
          200,
        );
      } catch {
        return errorResponse(500, "Failed to load approval request", false);
      }
    },

    async handleApprovePost(req: DualEraHttpRequest): Promise<DualEraHttpResponse> {
      const htmlMode = acceptsHtmlPreference(getHeader(req.headers, "accept"));
      try {
        const expectedOrigin = new URL(publicBaseUrl).origin;
        const reqOrigin = getHeader(req.headers, "origin");
        if (
          (reqOrigin !== undefined && reqOrigin !== expectedOrigin) ||
          (reqOrigin === undefined && config.allowAbsentOrigin === false)
        ) {
          return errorResponse(403, "Forbidden or missing origin on approval submission", htmlMode);
        }
        if (config.readOnly === true) {
          return errorResponse(
            403,
            "Connector is read-only; proposal approvals are disabled",
            htmlMode,
          );
        }

        const url = new URL(req.path, publicBaseUrl);
        const form = new URLSearchParams(req.rawBody);
        const ticketId = form.get("t") ?? url.searchParams.get("t");
        const csrf = form.get("csrf");
        const rawDecision = form.get("decision") ?? "approve";
        if (rawDecision !== "approve" && rawDecision !== "reject") {
          return errorResponse(400, "Invalid approval decision", htmlMode);
        }
        const decision: "approve" | "reject" = rawDecision;

        if (!ticketId || !csrf) {
          return errorResponse(400, "Missing required approval fields", htmlMode);
        }

        // Validate ticket, CSRF, scopes, opener identity, live credential & visibility BEFORE consuming ticket
        const ticket = await loadTicket(ticketId);
        if (!ticket || clock() >= ticket.expiresAtMs || ticket.consumed) {
          return errorResponse(410, "Approval ticket expired or already consumed", htmlMode);
        }
        const a = Buffer.from(csrf, "utf8");
        const b = Buffer.from(ticket.csrfToken, "utf8");
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
          return errorResponse(403, "Invalid CSRF", htmlMode);
        }
        if (!ticket.scopes.includes("bz:write:guarded")) {
          return errorResponse(403, "Insufficient scope: requires bz:write:guarded", htmlMode);
        }
        if (
          !config.verifyBindingOpenerSession ||
          (decision === "approve" && !config.core.cloudApprovalService)
        ) {
          return errorResponse(500, "Cloud approval service not configured", htmlMode);
        }

        const opener = await config.verifyBindingOpenerSession(req);
        if (
          !opener ||
          opener.issuer === RESERVED_LEGACY_ISSUER ||
          opener.issuer !== ticket.issuer ||
          opener.principalId !== ticket.approverPrincipalId
        ) {
          return errorResponse(403, "Approver identity mismatch", htmlMode);
        }

        const approverCtx = await buildLiveApproverContext(ticket);
        const rawClient = await config.core.resolveClient(approverCtx);
        if (!rawClient) {
          return errorResponse(401, "Bugzilla API key is not bound or was revoked", htmlMode);
        }
        const client = toPromiseBugzillaClient(asEffectBugzillaClient(rawClient));
        const vis = await client.checkVisibility(ticket.bugId);
        if (vis === "credential_revoked") {
          return errorResponse(401, "Bugzilla API key was revoked or rejected", htmlMode);
        }
        if (vis !== "visible") {
          return errorResponse(404, "Proposal not found or inaccessible", htmlMode);
        }

        const proposal = await storage.getProposal(
          ticket.issuer,
          ticket.approverPrincipalId,
          ticket.instanceUrl,
          ticket.proposalId,
          ticket.revision,
        );
        if (!proposal) {
          return errorResponse(404, "Proposal missing", htmlMode);
        }

        // All validations passed — now consume the single-use ticket atomically
        const nowMs = clock();
        if (storage.consumeApprovalTicket) {
          const claimed = await storage.consumeApprovalTicket(ticketId, nowMs);
          if (!claimed) {
            return errorResponse(410, "Ticket consumed", htmlMode);
          }
          const local = tickets.get(ticketId);
          if (local) local.consumed = true;
        } else {
          const local = tickets.get(ticketId);
          if (!local || nowMs >= local.expiresAtMs || local.consumed) {
            return errorResponse(410, "Ticket consumed", htmlMode);
          }
          local.consumed = true;
        }

        const idempotencyKey = `approve:${ticket.ticketId}`.slice(0, 128);

        if (htmlMode) {
          try {
            if (decision === "reject") {
              const outcome = await writeGuard.resolveProposal(approverCtx, {
                proposalId: proposal.proposalId,
                revision: proposal.revision,
                decision: "reject",
                idempotencyKey,
              });
              return renderOutcomeHtml(proposal, outcome);
            }

            const issued = await config.core.cloudApprovalService!.issue({
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
            const outcome = await writeGuard.resolveProposal(approverCtx, {
              proposalId: proposal.proposalId,
              revision: proposal.revision,
              decision: "approve",
              idempotencyKey,
              approval: { kind: "cloud_signed_token", token: issued.token },
            });
            return renderOutcomeHtml(proposal, outcome);
          } catch (err) {
            const projected = projectToolExecutionError(err);
            const message =
              projected.kind === "tool_error"
                ? (projected.content[0]?.text ?? "Proposal resolution failed")
                : projected.kind === "rpc_error"
                  ? projected.message
                  : "Proposal resolution failed";
            return errorResponse(400, message, true);
          }
        }

        // Programmatic JSON response (Accept does not prefer text/html)
        if (decision === "reject") {
          return {
            status: 200,
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
            },
            body: JSON.stringify({
              proposalId: proposal.proposalId,
              revision: proposal.revision,
              decision: "rejected",
            }),
          };
        }

        const issued = await config.core.cloudApprovalService!.issue({
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
      } catch {
        return errorResponse(500, "Failed to process approval submission", htmlMode);
      }
    },
  };
}
