import { loadTriageAppHtml } from "@bugzilla-mcp/app-ui";
import type { BugzillaClient } from "@bugzilla-mcp/bugzilla-client";
import {
  AppResolveProposalInputSchema,
  AppSaveDraftInputSchema,
  BugIdSchema,
  BugzillaCreateBugInputSchema,
  BugzillaGetAttachmentExcerptInputSchema,
  BugzillaGetDossierInputSchema,
  BugzillaPostAnalysisInputSchema,
  BugzillaProposeUpdateInputSchema,
  BugzillaSearchInputSchema,
  BugzillaTriageBoardInputSchema,
  DraftKindSchema,
  McpErrorCode,
  type PrincipalContext,
} from "@bugzilla-mcp/contracts";
import {
  canonicalJson,
  sha256Hex,
  type CoreDependencies,
  type WriteGuardService,
} from "@bugzilla-mcp/core";
import type { createApprovalPageManager } from "./approval-page.js";

export const TRIAGE_APP_URI = "ui://bugzilla/triage-app.html";
export const DOSSIER_CARD_URI = "ui://bugzilla/dossier-card.html";

export const INDISTINGUISHABLE_RESOURCE_ERROR = {
  code: McpErrorCode.INVALID_PARAMS,
  message: "Resource not found or inaccessible",
} as const;

export function buildFullToolCatalog(
  headerRoutedParams: Readonly<Record<string, readonly string[]>> = {},
) {
  const annotate = (toolName: string, propName: string, schema: Record<string, unknown>) => {
    const enabled = headerRoutedParams[toolName]?.includes(propName);
    return enabled ? { ...schema, "x-mcp-header": propName } : schema;
  };

  return [
    {
      name: "bugzilla_search",
      description: "Search Bugzilla bugs with compact projected summaries.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        properties: {
          product: annotate("bugzilla_search", "product", { type: "string" }),
          component: { type: "string" },
          status: { type: "array", items: { type: "string" } },
          assignedTo: { type: "string" },
          updatedSince: { type: "string", format: "date-time" },
          query: { type: "string", maxLength: 256 },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          offset: { type: "integer", minimum: 0, default: 0 },
        },
      },
    },
    {
      name: "bugzilla_get_dossier",
      description: "Fetch compact Bugzilla dossier with recent comments, history, and metadata.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: { ui: { resourceUri: DOSSIER_CARD_URI } },
      inputSchema: {
        type: "object",
        required: ["bugId"],
        properties: {
          bugId: annotate("bugzilla_get_dossier", "bugId", { type: "integer", minimum: 1 }),
          maxComments: { type: "integer", minimum: 0, maximum: 50, default: 15 },
          maxHistory: { type: "integer", minimum: 0, maximum: 100, default: 30 },
        },
      },
    },
    {
      name: "bugzilla_triage_board",
      description: "Open the Bugzilla Triage workbench in side pane or global view.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: {
        ui: { resourceUri: TRIAGE_APP_URI },
        "com.google.antigravity/ui": {
          entrypoints: [
            { type: "aux_pane", title: "Bugzilla" },
            { type: "global", title: "Bugzilla" },
          ],
        },
      },
      inputSchema: {
        type: "object",
        properties: {
          tab: {
            type: "string",
            enum: ["pending_proposals", "needinfo_or_mine", "untriaged"],
          },
          product: { type: "string" },
          focusBugId: { type: "integer", minimum: 1 },
        },
      },
    },
    {
      name: "bugzilla_post_analysis",
      description: "Post private Safe-Auto analysis comment (fails closed to internal note).",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: "object",
        required: ["bugId", "idempotencyKey", "isPrivate", "analysisMarkdown"],
        properties: {
          bugId: { type: "integer", minimum: 1 },
          idempotencyKey: { type: "string", minLength: 8 },
          isPrivate: annotate("bugzilla_post_analysis", "isPrivate", { const: true }),
          analysisMarkdown: { type: "string", minLength: 1, maxLength: 32768 },
          causalEventId: { type: "string" },
        },
      },
    },
    {
      name: "bugzilla_propose_update",
      description: "Create or execute a guarded Bugzilla update proposal.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      inputSchema: {
        type: "object",
        required: ["bugId", "idempotencyKey", "expectedLastChangeTime", "diff", "rationale"],
        properties: {
          bugId: { type: "integer", minimum: 1 },
          idempotencyKey: { type: "string", minLength: 8 },
          expectedLastChangeTime: { type: "string", format: "date-time" },
          diff: { type: "object" },
          rationale: { type: "string", minLength: 1, maxLength: 8192 },
          approval: { type: "object" },
          causalEventId: { type: "string" },
        },
      },
    },
    {
      name: "bugzilla_create_bug",
      description: "Create a Bugzilla bug with idempotency protection.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
      inputSchema: {
        type: "object",
        required: ["idempotencyKey", "summary", "description"],
        properties: {
          idempotencyKey: { type: "string", minLength: 8 },
          product: { type: "string" },
          component: { type: "string" },
          version: { type: "string" },
          summary: { type: "string", minLength: 1, maxLength: 255 },
          description: { type: "string", minLength: 1, maxLength: 32768 },
          severity: { type: "string" },
          priority: { type: "string" },
          customFields: { type: "object" },
        },
      },
    },
    {
      name: "bugzilla_get_attachment_excerpt",
      description: "Read a bounded text excerpt of a Bugzilla attachment.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type: "object",
        required: ["attachmentId"],
        properties: {
          attachmentId: { type: "integer", minimum: 1 },
          byteOffset: { type: "integer", minimum: 0, default: 0 },
          maxBytes: { type: "integer", minimum: 1, maximum: 65536, default: 16384 },
        },
      },
    },
    {
      name: "app_save_draft",
      description: "Persist scoped draft text from the MCP App with monotonic revision.",
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
      _meta: { ui: { visibility: ["app"] } },
      inputSchema: {
        type: "object",
        required: ["bugId", "draftKind", "draftRevision", "content"],
        properties: {
          bugId: { type: "integer", minimum: 1 },
          draftKind: {
            type: "string",
            enum: ["private_comment", "public_comment", "proposal_edit"],
          },
          draftRevision: { type: "integer", minimum: 1 },
          content: { type: "string", maxLength: 32768 },
        },
      },
    },
    {
      name: "app_get_draft",
      description: "Load persisted draft text for a bug inside the MCP App.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: { ui: { visibility: ["app"] } },
      inputSchema: {
        type: "object",
        required: ["bugId"],
        properties: {
          bugId: { type: "integer", minimum: 1 },
          draftKind: {
            type: "string",
            enum: ["private_comment", "public_comment", "proposal_edit"],
          },
        },
      },
    },
    {
      name: "app_get_bug_full",
      description: "Fetch full authorized bug dossier and persisted draft for the MCP App.",
      annotations: { readOnlyHint: true, idempotentHint: true },
      _meta: { ui: { visibility: ["app"] } },
      inputSchema: {
        type: "object",
        required: ["bugId"],
        properties: {
          bugId: { type: "integer", minimum: 1 },
          maxComments: { type: "integer", minimum: 0, maximum: 50, default: 20 },
          maxHistory: { type: "integer", minimum: 0, maximum: 100, default: 20 },
        },
      },
    },
    {
      name: "app_resolve_proposal",
      description: "Approve or reject a pending guarded-write proposal.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
      _meta: { ui: { visibility: ["app"] } },
      inputSchema: {
        type: "object",
        required: ["proposalId", "revision", "decision", "idempotencyKey"],
        properties: {
          proposalId: { type: "string", minLength: 1 },
          revision: { type: "integer", minimum: 1 },
          decision: { type: "string", enum: ["approve", "reject"] },
          idempotencyKey: { type: "string", minLength: 8 },
          approval: { type: "object" },
        },
      },
    },
  ];
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
  ];
}

export type ToolDispatchOutcome =
  | {
      readonly kind: "ok";
      readonly content: readonly { readonly type: "text"; readonly text: string }[];
      readonly structuredContent: unknown;
    }
  | {
      readonly kind: "rpc_error";
      readonly code: number;
      readonly message: string;
    };

export async function dispatchToolCall(params: {
  toolName: string;
  toolArgs: Record<string, unknown>;
  ctx: PrincipalContext;
  client: BugzillaClient;
  core: CoreDependencies;
  writeGuard: WriteGuardService;
  approvalPage: ReturnType<typeof createApprovalPageManager>;
}): Promise<ToolDispatchOutcome> {
  const { toolName, toolArgs, ctx, client, core, writeGuard, approvalPage } = params;

  if (toolName === "bugzilla_post_analysis") {
    const parsed = BugzillaPostAnalysisInputSchema.safeParse(toolArgs);
    if (!parsed.success) {
      return {
        kind: "rpc_error",
        code: McpErrorCode.INVALID_PARAMS,
        message: "Invalid Safe-Auto analysis arguments (isPrivate must be true)",
      };
    }
    const outcome = await writeGuard.postAnalysis(ctx, parsed.data);
    return {
      kind: "ok",
      content: [{ type: "text", text: JSON.stringify(outcome) }],
      structuredContent: outcome,
    };
  }

  if (toolName === "bugzilla_get_dossier") {
    const parsed = BugzillaGetDossierInputSchema.safeParse(toolArgs);
    if (!parsed.success) {
      return { kind: "rpc_error", code: McpErrorCode.INVALID_PARAMS, message: "Invalid bugId" };
    }
    const vis = await client.checkVisibility(parsed.data.bugId);
    if (vis !== "visible") {
      return {
        kind: "rpc_error",
        code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
        message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
      };
    }
    const raw = await client.getBugDossierData(parsed.data.bugId, {
      maxComments: parsed.data.maxComments,
      maxHistory: parsed.data.maxHistory,
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
      parsed.data.bugId,
    );
    const tenantKey = sha256Hex(
      canonicalJson({
        issuer: ctx.issuer,
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
      }),
    );
    const dossier = { ...raw, internalNotes, tenantKey };
    return {
      kind: "ok",
      content: [{ type: "text", text: JSON.stringify(dossier) }],
      structuredContent: dossier,
    };
  }

  if (toolName === "bugzilla_search") {
    const parsed = BugzillaSearchInputSchema.safeParse(toolArgs);
    if (!parsed.success) {
      return {
        kind: "rpc_error",
        code: McpErrorCode.INVALID_PARAMS,
        message: "Invalid bugzilla_search arguments",
      };
    }
    const search = await client.searchBugs({
      ...(parsed.data.product !== undefined ? { product: parsed.data.product } : {}),
      ...(parsed.data.component !== undefined ? { component: parsed.data.component } : {}),
      ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
      ...(parsed.data.assignedTo !== undefined ? { assignedTo: parsed.data.assignedTo } : {}),
      ...(parsed.data.updatedSince !== undefined ? { updatedSince: parsed.data.updatedSince } : {}),
      ...(parsed.data.query !== undefined ? { query: parsed.data.query } : {}),
      limit: parsed.data.limit,
      offset: parsed.data.offset,
    });
    return {
      kind: "ok",
      content: [{ type: "text", text: JSON.stringify(search) }],
      structuredContent: search,
    };
  }

  if (toolName === "bugzilla_triage_board") {
    const parsed = BugzillaTriageBoardInputSchema.safeParse(toolArgs);
    if (!parsed.success) {
      return {
        kind: "rpc_error",
        code: McpErrorCode.INVALID_PARAMS,
        message: "Invalid bugzilla_triage_board arguments",
      };
    }
    const search = await client.searchBugs({
      ...(parsed.data.product !== undefined ? { product: parsed.data.product } : {}),
      limit: 50,
      offset: 0,
    });
    const rawProposals =
      (await core.storage.listProposals?.(ctx.issuer, ctx.principalId, ctx.instanceUrl)) ?? [];
    // Re-authorize every proposal's bug against current Bugzilla visibility (AUTH-05)
    const visCache = new Map<number, boolean>();
    for (const b of search.items) visCache.set(b.id, true);
    const proposals = [];
    for (const p of rawProposals) {
      let ok = visCache.get(p.bugId);
      if (ok === undefined) {
        ok = (await client.checkVisibility(p.bugId)) === "visible";
        visCache.set(p.bugId, ok);
      }
      if (!ok) continue;
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
    const tenantKey = sha256Hex(
      canonicalJson({
        issuer: ctx.issuer,
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
      }),
    );
    const boardPayload = {
      tenantKey,
      instanceUrl: ctx.instanceUrl,
      principalId: ctx.principalId,
      deploymentMode: ctx.deploymentMode,
      fetchedAt: new Date((core.clock ?? Date.now)()).toISOString(),
      activeTab:
        parsed.data.tab ??
        (proposals.some((p) => p.state === "pending") ? "pending_proposals" : "untriaged"),
      ...(parsed.data.focusBugId !== undefined ? { focusBugId: parsed.data.focusBugId } : {}),
      bugs,
      proposals,
      hasMore: search.hasMore,
    };
    return {
      kind: "ok",
      content: [
        {
          type: "text",
          text: `Loaded Bugzilla triage board (${bugs.length} bugs, ${proposals.filter((p) => p.state === "pending").length} pending proposals).`,
        },
      ],
      structuredContent: boardPayload,
    };
  }

  if (toolName === "bugzilla_propose_update") {
    const parsed = BugzillaProposeUpdateInputSchema.safeParse(toolArgs);
    if (!parsed.success) {
      return {
        kind: "rpc_error",
        code: McpErrorCode.INVALID_PARAMS,
        message: "Invalid bugzilla_propose_update arguments",
      };
    }
    const outcome = await writeGuard.proposeUpdate(ctx, parsed.data);
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
    return {
      kind: "ok",
      content: [{ type: "text", text: JSON.stringify(outcome) }],
      structuredContent: outcome,
    };
  }

  if (toolName === "bugzilla_create_bug") {
    const parsed = BugzillaCreateBugInputSchema.safeParse(toolArgs);
    if (!parsed.success) {
      return {
        kind: "rpc_error",
        code: McpErrorCode.INVALID_PARAMS,
        message: "Invalid bugzilla_create_bug arguments",
      };
    }
    const outcome = await writeGuard.createBug(ctx, parsed.data);
    return {
      kind: "ok",
      content: [{ type: "text", text: JSON.stringify(outcome) }],
      structuredContent: outcome,
    };
  }

  if (toolName === "bugzilla_get_attachment_excerpt") {
    const parsed = BugzillaGetAttachmentExcerptInputSchema.safeParse(toolArgs);
    if (!parsed.success) {
      return {
        kind: "rpc_error",
        code: McpErrorCode.INVALID_PARAMS,
        message: "Invalid attachment excerpt arguments",
      };
    }
    if (!client.getAttachmentExcerpt) {
      return {
        kind: "rpc_error",
        code: McpErrorCode.INTERNAL_ERROR,
        message: "Attachment excerpt reading is not supported by this Bugzilla client",
      };
    }
    let excerpt: Awaited<ReturnType<NonNullable<typeof client.getAttachmentExcerpt>>>;
    try {
      excerpt = await client.getAttachmentExcerpt(parsed.data);
    } catch (err) {
      if (err instanceof Error && err.name === "BugzillaUnsupportedAttachmentError") {
        return {
          kind: "rpc_error",
          code: McpErrorCode.INVALID_PARAMS,
          message: err.message,
        };
      }
      throw err;
    }
    if (!excerpt) {
      return {
        kind: "rpc_error",
        code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
        message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
      };
    }
    const vis = await client.checkVisibility(excerpt.bugId);
    if (vis !== "visible") {
      return {
        kind: "rpc_error",
        code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
        message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
      };
    }
    const result = { ...excerpt, untrustedUserContent: true };
    return {
      kind: "ok",
      content: [{ type: "text", text: JSON.stringify(result) }],
      structuredContent: result,
    };
  }

  if (toolName === "app_save_draft") {
    const parsed = AppSaveDraftInputSchema.safeParse(toolArgs);
    if (!parsed.success) {
      return {
        kind: "rpc_error",
        code: McpErrorCode.INVALID_PARAMS,
        message: "Invalid app_save_draft arguments",
      };
    }
    const res = await writeGuard.saveDraft(ctx, parsed.data);
    return {
      kind: "ok",
      content: [{ type: "text", text: JSON.stringify(res) }],
      structuredContent: res,
    };
  }

  if (toolName === "app_get_draft") {
    const bugIdParsed = BugIdSchema.safeParse(toolArgs.bugId);
    const kindParsed = DraftKindSchema.safeParse(toolArgs.draftKind ?? "private_comment");
    if (!bugIdParsed.success || !kindParsed.success) {
      return {
        kind: "rpc_error",
        code: McpErrorCode.INVALID_PARAMS,
        message: "Invalid app_get_draft arguments",
      };
    }
    // Re-verify live bug visibility before returning local draft (AUTH-05)
    if ((await client.checkVisibility(bugIdParsed.data)) !== "visible") {
      return {
        kind: "rpc_error",
        code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
        message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
      };
    }
    const draft = await writeGuard.getDraft(ctx, {
      bugId: bugIdParsed.data,
      draftKind: kindParsed.data,
    });
    return {
      kind: "ok",
      content: [{ type: "text", text: JSON.stringify({ draft }) }],
      structuredContent: { draft },
    };
  }

  if (toolName === "app_get_bug_full") {
    const parsed = BugzillaGetDossierInputSchema.safeParse(toolArgs);
    if (!parsed.success) {
      return { kind: "rpc_error", code: McpErrorCode.INVALID_PARAMS, message: "Invalid bugId" };
    }
    const vis = await client.checkVisibility(parsed.data.bugId);
    if (vis !== "visible") {
      return {
        kind: "rpc_error",
        code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
        message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
      };
    }
    const raw = await client.getBugDossierData(parsed.data.bugId, {
      maxComments: parsed.data.maxComments,
      maxHistory: parsed.data.maxHistory,
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
        parsed.data.bugId,
      ),
      writeGuard.getDraft(ctx, { bugId: parsed.data.bugId, draftKind: "private_comment" }),
      core.storage.listProposals?.(ctx.issuer, ctx.principalId, ctx.instanceUrl, {
        bugId: parsed.data.bugId,
      }) ?? Promise.resolve([]),
    ]);
    const payload = { dossier: { ...raw, internalNotes }, draft, proposals };
    return {
      kind: "ok",
      content: [{ type: "text", text: JSON.stringify(payload) }],
      structuredContent: payload,
    };
  }

  if (toolName === "app_resolve_proposal") {
    const parsed = AppResolveProposalInputSchema.safeParse(toolArgs);
    if (!parsed.success) {
      return {
        kind: "rpc_error",
        code: McpErrorCode.INVALID_PARAMS,
        message: "Invalid app_resolve_proposal arguments",
      };
    }
    const outcome = await writeGuard.resolveProposal(ctx, parsed.data);
    return {
      kind: "ok",
      content: [{ type: "text", text: JSON.stringify(outcome) }],
      structuredContent: outcome,
    };
  }

  return {
    kind: "rpc_error",
    code: McpErrorCode.INVALID_PARAMS,
    message: `Unknown tool: ${toolName}`,
  };
}

export async function readMcpResource(params: {
  uri: string;
  ctx: PrincipalContext;
  core: CoreDependencies;
  appHtmlOverridePath?: string;
}): Promise<
  | {
      readonly kind: "ok";
      readonly ttlMs: number;
      readonly cacheScope: "public" | "private";
      readonly contents: readonly {
        readonly uri: string;
        readonly mimeType: string;
        readonly text: string;
        readonly _meta?: Record<string, unknown>;
      }[];
    }
  | { readonly kind: "rpc_error"; readonly code: number; readonly message: string }
> {
  const { uri, ctx, core, appHtmlOverridePath } = params;

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

  const match = /^bugzilla:\/\/bug\/([1-9]\d*)$/.exec(uri);
  const bugId = match?.[1] ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(bugId) || bugId <= 0) {
    return {
      kind: "rpc_error",
      code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
      message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
    };
  }
  const client = await core.resolveClient(ctx);
  if (!client) {
    return {
      kind: "rpc_error",
      code: McpErrorCode.INVALID_PARAMS,
      message: "CredentialBindingRequired",
    };
  }
  const vis = await client.checkVisibility(bugId);
  if (vis !== "visible") {
    return {
      kind: "rpc_error",
      code: INDISTINGUISHABLE_RESOURCE_ERROR.code,
      message: INDISTINGUISHABLE_RESOURCE_ERROR.message,
    };
  }
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
}
