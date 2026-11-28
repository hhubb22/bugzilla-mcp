import { loadTriageAppHtml } from "@bugzilla-mcp/app-ui";
import { toPromiseBugzillaClient, type VisibilityStatus } from "@bugzilla-mcp/bugzilla-client";
import {
  CredentialBindingRequired,
  CredentialRevoked,
  McpErrorCode,
  type McpToolCatalogEntry,
  type PrincipalContext,
} from "@bugzilla-mcp/contracts";
import {
  DOSSIER_CARD_URI,
  TRIAGE_APP_URI,
  decodeToolInputResult,
  toMcpToolCatalog,
} from "@bugzilla-mcp/contracts/tool-registry";
import {
  asEffectBugzillaClient,
  canonicalJson,
  createMetadataCache,
  sha256Hex,
  type AnyBugzillaClient,
  type CoreDependencies,
  type MetadataCacheService,
  type WriteGuardService,
} from "@bugzilla-mcp/core";
import { Result } from "effect";
import type { createApprovalPageManager } from "./approval-page.js";
import {
  INDISTINGUISHABLE_RESOURCE_ERROR,
  projectDomainErrorToToolOutcome,
  projectResourceReadError,
  projectToolExecutionError,
  projectWriteGuardOutcome,
  type ResourceReadOutcome,
  type ToolDispatchOutcome,
} from "./error-projector.js";

export {
  DOSSIER_CARD_URI,
  INDISTINGUISHABLE_RESOURCE_ERROR,
  TRIAGE_APP_URI,
  type ResourceReadOutcome,
  type ToolDispatchOutcome,
};

export const SCHEMA_FIELDS_URI = "bugzilla://schema/fields" as const;
export const SCHEMA_PRODUCTS_URI = "bugzilla://schema/products" as const;

const SCHEMA_FIELDS_TTL_MS = 600_000;
const SCHEMA_PRODUCTS_TTL_MS = 300_000;

/**
 * Single-source MCP tool catalog backed by `@bugzilla-mcp/contracts/tool-registry`.
 * Emits generated JSON Schema 2020-12 `inputSchema` and `outputSchema` for all 11 tools.
 */
export function buildFullToolCatalog(
  headerRoutedParams: Readonly<Record<string, readonly string[]>> = {},
): readonly McpToolCatalogEntry[] {
  return toMcpToolCatalog(headerRoutedParams);
}

export function buildResourceCatalog() {
  return [
    {
      uri: TRIAGE_APP_URI,
      name: "Bugzilla Triage Workbench",
      description: "Interactive Bugzilla triage board and proposal review UI.",
      mimeType: "text/html;profile=mcp-app",
      _meta: { ui: { prefersBorder: false } },
    },
    {
      uri: DOSSIER_CARD_URI,
      name: "Bugzilla Bug Dossier Card",
      description: "Inline single-bug dossier card UI.",
      mimeType: "text/html;profile=mcp-app",
      _meta: { ui: { prefersBorder: false } },
    },
    {
      uri: SCHEMA_FIELDS_URI,
      name: "Bugzilla Bug Fields Schema",
      description:
        "Field definitions, mandatory entry fields, and allowed values for the authorized Bugzilla instance.",
      mimeType: "application/json",
    },
    {
      uri: SCHEMA_PRODUCTS_URI,
      name: "Bugzilla Enterable Products",
      description:
        "Enterable Bugzilla products, components, and versions for the authorized principal.",
      mimeType: "application/json",
    },
  ];
}

function tenantKeyFor(ctx: PrincipalContext): string {
  return sha256Hex(
    canonicalJson({
      issuer: ctx.issuer,
      principalId: ctx.principalId,
      instanceUrl: ctx.instanceUrl,
    }),
  );
}

function projectVisibilityFailureForTool(vis: VisibilityStatus): ToolDispatchOutcome | null {
  if (vis === "visible") return null;
  if (vis === "credential_revoked") {
    return projectDomainErrorToToolOutcome(
      new CredentialRevoked({
        message: "CredentialRevoked: Bugzilla API key was revoked or rejected.",
      }),
    );
  }
  return {
    kind: "rpc_error",
    code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
    message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
  };
}

function projectVisibilityFailureForResource(
  vis: VisibilityStatus,
): Extract<ResourceReadOutcome, { readonly kind: "rpc_error" }> | null {
  if (vis === "visible") return null;
  if (vis === "credential_revoked") {
    return projectResourceReadError(
      new CredentialRevoked({
        message: "CredentialRevoked: Bugzilla API key was revoked or rejected.",
      }),
    );
  }
  return {
    kind: "rpc_error",
    code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
    message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
  };
}

export async function dispatchToolCall(params: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  ctx: PrincipalContext;
  client: AnyBugzillaClient;
  core: CoreDependencies;
  writeGuard: WriteGuardService;
  approvalPage: ReturnType<typeof createApprovalPageManager>;
}): Promise<ToolDispatchOutcome> {
  const { toolName, toolArgs, ctx, client: rawClient, core, writeGuard, approvalPage } = params;
  const hasAttachmentExcerpt =
    typeof (rawClient as { readonly getAttachmentExcerpt?: unknown }).getAttachmentExcerpt ===
    "function";
  const client = toPromiseBugzillaClient(asEffectBugzillaClient(rawClient));

  try {
    if (toolName === "bugzilla_post_analysis") {
      const parsed = decodeToolInputResult("bugzilla_post_analysis", toolArgs);
      if (Result.isFailure(parsed)) {
        return projectDomainErrorToToolOutcome(parsed.failure);
      }
      const outcome = await writeGuard.postAnalysis(ctx, parsed.success);
      return projectWriteGuardOutcome(outcome);
    }

    if (toolName === "bugzilla_get_dossier") {
      const parsed = decodeToolInputResult("bugzilla_get_dossier", toolArgs);
      if (Result.isFailure(parsed)) {
        return projectDomainErrorToToolOutcome(parsed.failure);
      }
      const visFail = projectVisibilityFailureForTool(
        await client.checkVisibility(parsed.success.bugId),
      );
      if (visFail) return visFail;

      const raw = await client.getBugDossierData(parsed.success.bugId, {
        maxComments: parsed.success.maxComments,
        maxHistory: parsed.success.maxHistory,
      });
      if (!raw) {
        return {
          kind: "rpc_error",
          code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
          message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
        };
      }
      const internalNotes = await core.storage.listInternalNotes(
        ctx.issuer,
        ctx.principalId,
        ctx.instanceUrl,
        parsed.success.bugId,
      );
      const dossier = { ...raw, internalNotes, tenantKey: tenantKeyFor(ctx) };
      return {
        kind: "ok",
        content: [{ type: "text", text: JSON.stringify(dossier) }],
        structuredContent: dossier,
      };
    }

    if (toolName === "bugzilla_search") {
      const parsed = decodeToolInputResult("bugzilla_search", toolArgs);
      if (Result.isFailure(parsed)) {
        return projectDomainErrorToToolOutcome(parsed.failure);
      }
      const data = parsed.success;
      const search = await client.searchBugs({
        ...(data.product !== undefined ? { product: data.product } : {}),
        ...(data.component !== undefined ? { component: data.component } : {}),
        ...(data.status !== undefined ? { status: [...data.status] } : {}),
        ...(data.assignedTo !== undefined ? { assignedTo: data.assignedTo } : {}),
        ...(data.updatedSince !== undefined ? { updatedSince: data.updatedSince } : {}),
        ...(data.query !== undefined ? { query: data.query } : {}),
        limit: data.limit,
        offset: data.offset,
      });
      return {
        kind: "ok",
        content: [{ type: "text", text: JSON.stringify(search) }],
        structuredContent: search,
      };
    }

    if (toolName === "bugzilla_triage_board") {
      const parsed = decodeToolInputResult("bugzilla_triage_board", toolArgs);
      if (Result.isFailure(parsed)) {
        return projectDomainErrorToToolOutcome(parsed.failure);
      }
      const data = parsed.success;
      const search = await client.searchBugs({
        ...(data.product !== undefined ? { product: data.product } : {}),
        limit: 50,
        offset: 0,
      });
      const rawProposals =
        (await core.storage.listProposals(ctx.issuer, ctx.principalId, ctx.instanceUrl)) ?? [];

      // Re-authorize every proposal's bug against current Bugzilla visibility (AUTH-05).
      // Include pending, indeterminate, stale, etc. proposals for authorized bugs; fail
      // explicitly on credential_revoked instead of hiding proposals silently.
      const visCache = new Map<number, VisibilityStatus>();
      for (const b of search.items) visCache.set(b.id, "visible");

      const proposals = [];
      for (const p of rawProposals) {
        let vis = visCache.get(p.bugId);
        if (vis === undefined) {
          vis = await client.checkVisibility(p.bugId);
          visCache.set(p.bugId, vis);
        }
        if (vis === "credential_revoked") {
          return projectDomainErrorToToolOutcome(
            new CredentialRevoked({
              message: "CredentialRevoked: Bugzilla API key was revoked or rejected.",
            }),
          );
        }
        if (vis !== "visible") continue;

        if (p.state === "pending" && ctx.deploymentMode === "cloud-multi-user") {
          const ticket = await approvalPage.issueApprovalTicket(ctx, p);
          proposals.push({ ...p, approvalUrl: ticket.approvalUrl });
        } else {
          proposals.push(p);
        }
      }

      const pendingCounts = new Map<number, number>();
      for (const p of proposals) {
        if (p.state === "pending") {
          pendingCounts.set(p.bugId, (pendingCounts.get(p.bugId) ?? 0) + 1);
        }
      }
      const bugs = search.items.map((b) => ({
        ...b,
        pendingProposalCount: pendingCounts.get(b.id) ?? 0,
      }));
      const pendingCount = proposals.filter((p) => p.state === "pending").length;
      const indeterminateCount = proposals.filter((p) => p.state === "indeterminate").length;
      const boardPayload = {
        tenantKey: tenantKeyFor(ctx),
        instanceUrl: ctx.instanceUrl,
        principalId: ctx.principalId,
        deploymentMode: ctx.deploymentMode,
        fetchedAt: new Date((core.clock ?? Date.now)()).toISOString(),
        activeTab:
          data.tab ??
          (pendingCount > 0 || indeterminateCount > 0 ? "pending_proposals" : "untriaged"),
        ...(data.focusBugId !== undefined ? { focusBugId: data.focusBugId } : {}),
        bugs,
        proposals,
        hasMore: search.hasMore,
      };
      const reconcileSuffix =
        indeterminateCount > 0 ? `, ${indeterminateCount} requiring reconciliation` : "";
      return {
        kind: "ok",
        content: [
          {
            type: "text",
            text: `Loaded Bugzilla triage board (${bugs.length} bugs, ${pendingCount} pending proposals${reconcileSuffix}).`,
          },
        ],
        structuredContent: boardPayload,
      };
    }

    if (toolName === "bugzilla_propose_update") {
      const parsed = decodeToolInputResult("bugzilla_propose_update", toolArgs);
      if (Result.isFailure(parsed)) {
        return projectDomainErrorToToolOutcome(parsed.failure);
      }
      const outcome = await writeGuard.proposeUpdate(ctx, parsed.success);
      if (outcome.outcome === "ProposalPending" && ctx.deploymentMode === "cloud-multi-user") {
        const stored = await core.storage.getProposal(
          ctx.issuer,
          ctx.principalId,
          ctx.instanceUrl,
          outcome.proposalId,
          outcome.revision,
        );
        if (stored) {
          const ticket = await approvalPage.issueApprovalTicket(ctx, stored);
          const enriched = {
            ...outcome,
            approvalUrl: ticket.approvalUrl,
            approvalExpiresAt: ticket.expiresAt,
          };
          return {
            kind: "ok",
            content: [{ type: "text", text: JSON.stringify(enriched) }],
            structuredContent: enriched,
          };
        }
      }
      return projectWriteGuardOutcome(outcome);
    }

    if (toolName === "bugzilla_create_bug") {
      const parsed = decodeToolInputResult("bugzilla_create_bug", toolArgs);
      if (Result.isFailure(parsed)) {
        return projectDomainErrorToToolOutcome(parsed.failure);
      }
      const outcome = await writeGuard.createBug(ctx, parsed.success);
      return projectWriteGuardOutcome(outcome);
    }

    if (toolName === "bugzilla_get_attachment_excerpt") {
      const parsed = decodeToolInputResult("bugzilla_get_attachment_excerpt", toolArgs);
      if (Result.isFailure(parsed)) {
        return projectDomainErrorToToolOutcome(parsed.failure);
      }
      if (!hasAttachmentExcerpt) {
        return {
          kind: "rpc_error",
          code: McpErrorCode.INTERNAL_ERROR,
          message: "Attachment excerpt reading is not supported by this Bugzilla client",
        };
      }
      const excerpt = await client.getAttachmentExcerpt(parsed.success);
      if (!excerpt) {
        return {
          kind: "rpc_error",
          code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
          message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
        };
      }
      const visFail = projectVisibilityFailureForTool(await client.checkVisibility(excerpt.bugId));
      if (visFail) return visFail;

      const result = { ...excerpt, untrustedUserContent: true as const };
      return {
        kind: "ok",
        content: [{ type: "text", text: JSON.stringify(result) }],
        structuredContent: result,
      };
    }

    if (toolName === "app_save_draft") {
      const parsed = decodeToolInputResult("app_save_draft", toolArgs);
      if (Result.isFailure(parsed)) {
        return projectDomainErrorToToolOutcome(parsed.failure);
      }
      const res = await writeGuard.saveDraft(ctx, parsed.success);
      return {
        kind: "ok",
        content: [{ type: "text", text: JSON.stringify(res) }],
        structuredContent: res,
      };
    }

    if (toolName === "app_get_draft") {
      const parsed = decodeToolInputResult("app_get_draft", toolArgs);
      if (Result.isFailure(parsed)) {
        return projectDomainErrorToToolOutcome(parsed.failure);
      }
      // Re-verify live bug visibility before returning local draft (AUTH-05)
      const visFail = projectVisibilityFailureForTool(
        await client.checkVisibility(parsed.success.bugId),
      );
      if (visFail) return visFail;

      const draft = await writeGuard.getDraft(ctx, parsed.success);
      return {
        kind: "ok",
        content: [{ type: "text", text: JSON.stringify({ draft }) }],
        structuredContent: { draft },
      };
    }

    if (toolName === "app_get_bug_full") {
      const parsed = decodeToolInputResult("app_get_bug_full", toolArgs);
      if (Result.isFailure(parsed)) {
        return projectDomainErrorToToolOutcome(parsed.failure);
      }
      const visFail = projectVisibilityFailureForTool(
        await client.checkVisibility(parsed.success.bugId),
      );
      if (visFail) return visFail;

      const raw = await client.getBugDossierData(parsed.success.bugId, {
        maxComments: parsed.success.maxComments,
        maxHistory: parsed.success.maxHistory,
      });
      if (!raw) {
        return {
          kind: "rpc_error",
          code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
          message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
        };
      }
      const [internalNotes, draft, proposals] = await Promise.all([
        core.storage.listInternalNotes(
          ctx.issuer,
          ctx.principalId,
          ctx.instanceUrl,
          parsed.success.bugId,
        ),
        writeGuard.getDraft(ctx, { bugId: parsed.success.bugId, draftKind: "private_comment" }),
        core.storage.listProposals(ctx.issuer, ctx.principalId, ctx.instanceUrl, {
          bugId: parsed.success.bugId,
        }),
      ]);
      const payload = { dossier: { ...raw, internalNotes }, draft, proposals };
      return {
        kind: "ok",
        content: [{ type: "text", text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    }

    if (toolName === "app_resolve_proposal") {
      const parsed = decodeToolInputResult("app_resolve_proposal", toolArgs);
      if (Result.isFailure(parsed)) {
        return projectDomainErrorToToolOutcome(parsed.failure);
      }
      const outcome = await writeGuard.resolveProposal(ctx, parsed.success);
      return projectWriteGuardOutcome(outcome);
    }

    return {
      kind: "rpc_error",
      code: McpErrorCode.INVALID_PARAMS,
      message: `Unknown tool: ${toolName}`,
    };
  } catch (err) {
    return projectToolExecutionError(err);
  }
}

export async function readMcpResource(params: {
  uri: string;
  ctx: PrincipalContext;
  core: CoreDependencies;
  metadataCache?: MetadataCacheService;
  appHtmlOverridePath?: string;
}): Promise<ResourceReadOutcome> {
  const { uri, ctx, core, appHtmlOverridePath } = params;

  try {
    if (uri === TRIAGE_APP_URI || uri === DOSSIER_CARD_URI) {
      const html = loadTriageAppHtml(appHtmlOverridePath);
      return {
        kind: "ok",
        ttlMs: 0,
        cacheScope: "public",
        contents: [
          {
            uri,
            mimeType: "text/html;profile=mcp-app",
            text: html,
            _meta: { ui: { prefersBorder: false } },
          },
        ],
      };
    }

    if (uri === SCHEMA_FIELDS_URI || uri === SCHEMA_PRODUCTS_URI) {
      const rawClient = await core.resolveClient(ctx);
      if (!rawClient) {
        return projectResourceReadError(
          new CredentialBindingRequired({
            message: "Bind your Bugzilla API key via the HTTPS binding page.",
          }),
        );
      }
      const cache =
        params.metadataCache ?? createMetadataCache(core.clock ? { clock: core.clock } : {});
      const fetchedAt = new Date((core.clock ?? Date.now)()).toISOString();

      if (uri === SCHEMA_FIELDS_URI) {
        const fields = await cache.getBugFields(ctx, rawClient);
        return {
          kind: "ok",
          ttlMs: SCHEMA_FIELDS_TTL_MS,
          cacheScope: "private",
          contents: [
            {
              uri,
              mimeType: "application/json",
              text: JSON.stringify({
                instanceUrl: ctx.instanceUrl,
                fetchedAt,
                fields,
              }),
            },
          ],
        };
      }

      const products = await cache.listEnterableProducts(ctx, rawClient);
      return {
        kind: "ok",
        ttlMs: SCHEMA_PRODUCTS_TTL_MS,
        cacheScope: "private",
        contents: [
          {
            uri,
            mimeType: "application/json",
            text: JSON.stringify({
              instanceUrl: ctx.instanceUrl,
              fetchedAt,
              products,
            }),
          },
        ],
      };
    }

    const match = /^bugzilla:\/\/bug\/([1-9]\d*)$/.exec(uri);
    const bugId = match?.[1] ? Number(match[1]) : NaN;
    if (!Number.isSafeInteger(bugId) || bugId <= 0) {
      return {
        kind: "rpc_error",
        code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
        message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
      };
    }

    const rawClient = await core.resolveClient(ctx);
    if (!rawClient) {
      return projectResourceReadError(
        new CredentialBindingRequired({
          message: "Bind your Bugzilla API key via the HTTPS binding page.",
        }),
      );
    }

    const client = toPromiseBugzillaClient(asEffectBugzillaClient(rawClient));
    const visFail = projectVisibilityFailureForResource(await client.checkVisibility(bugId));
    if (visFail) return visFail;

    const raw = await client.getBugDossierData(bugId, { maxComments: 15, maxHistory: 30 });
    if (!raw) {
      return {
        kind: "rpc_error",
        code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
        message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
      };
    }
    const internalNotes = await core.storage.listInternalNotes(
      ctx.issuer,
      ctx.principalId,
      ctx.instanceUrl,
      bugId,
    );
    const dossier = { ...raw, internalNotes };
    return {
      kind: "ok",
      ttlMs: 0,
      cacheScope: "private",
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(dossier),
        },
      ],
    };
  } catch (err) {
    return projectResourceReadError(err);
  }
}
