import { Effect, type JsonSchema, type Result, Schema } from "effect";
import {
  decodeOrInvalidInput,
  decodeOrInvalidInputResult,
  type InvalidToolInput,
  STRICT_PARSE_OPTIONS,
} from "./errors.js";
import type { PrincipalScope, ToolAnnotations } from "./mcp-wire.js";
import {
  AppGetBugFullInputSchema,
  AppGetBugFullOutputSchema,
  AppGetDraftInputSchema,
  AppGetDraftOutputSchema,
  AppResolveProposalInputSchema,
  AppResolveProposalOutputSchema,
  AppSaveDraftInputSchema,
  AppSaveDraftOutputSchema,
  BugzillaCreateBugInputSchema,
  BugzillaCreateBugOutputSchema,
  BugzillaGetAttachmentExcerptInputSchema,
  BugzillaGetAttachmentExcerptOutputSchema,
  BugzillaGetDossierInputSchema,
  BugzillaGetDossierOutputSchema,
  BugzillaPostAnalysisInputSchema,
  BugzillaPostAnalysisOutputSchema,
  BugzillaProposeUpdateInputSchema,
  BugzillaProposeUpdateOutputSchema,
  BugzillaSearchInputSchema,
  BugzillaSearchOutputSchema,
  BugzillaTriageBoardInputSchema,
  BugzillaTriageBoardOutputSchema,
} from "./tools.js";

export const TRIAGE_APP_URI = "ui://bugzilla/triage-app.html" as const;
export const DOSSIER_CARD_URI = "ui://bugzilla/dossier-card.html" as const;

export type ToolVisibility = "model" | "app";

export type ToolName =
  | "bugzilla_search"
  | "bugzilla_get_dossier"
  | "bugzilla_triage_board"
  | "bugzilla_post_analysis"
  | "bugzilla_propose_update"
  | "bugzilla_create_bug"
  | "bugzilla_get_attachment_excerpt"
  | "app_save_draft"
  | "app_get_draft"
  | "app_get_bug_full"
  | "app_resolve_proposal";

export interface ToolDefinition<
  Name extends ToolName = ToolName,
  InputSchema extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>,
  OutputSchema extends Schema.ConstraintDecoder<unknown> = Schema.ConstraintDecoder<unknown>,
> {
  readonly name: Name;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly visibility: ToolVisibility;
  readonly mutating: boolean;
  readonly requiredScope: PrincipalScope;
  readonly inputSchema: InputSchema;
  readonly outputSchema: OutputSchema;
}

export interface McpToolCatalogEntry {
  readonly name: ToolName;
  readonly description: string;
  readonly annotations: ToolAnnotations;
  readonly _meta?: Readonly<Record<string, unknown>>;
  readonly inputSchema: JsonSchema.JsonSchema;
  readonly outputSchema: JsonSchema.JsonSchema;
}

export const TOOL_REGISTRY = [
  {
    name: "bugzilla_search",
    description: "Search Bugzilla bugs with compact projected summaries.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    visibility: "model",
    mutating: false,
    requiredScope: "bz:read",
    inputSchema: BugzillaSearchInputSchema,
    outputSchema: BugzillaSearchOutputSchema,
  },
  {
    name: "bugzilla_get_dossier",
    description: "Fetch compact Bugzilla dossier with recent comments, history, and metadata.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    _meta: { ui: { resourceUri: DOSSIER_CARD_URI } },
    visibility: "model",
    mutating: false,
    requiredScope: "bz:read",
    inputSchema: BugzillaGetDossierInputSchema,
    outputSchema: BugzillaGetDossierOutputSchema,
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
    visibility: "model",
    mutating: false,
    requiredScope: "bz:read",
    inputSchema: BugzillaTriageBoardInputSchema,
    outputSchema: BugzillaTriageBoardOutputSchema,
  },
  {
    name: "bugzilla_post_analysis",
    description: "Post private Safe-Auto analysis comment (fails closed to internal note).",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    visibility: "model",
    mutating: true,
    requiredScope: "bz:write:safe",
    inputSchema: BugzillaPostAnalysisInputSchema,
    outputSchema: BugzillaPostAnalysisOutputSchema,
  },
  {
    name: "bugzilla_propose_update",
    description: "Create or execute a guarded Bugzilla update proposal.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    visibility: "model",
    mutating: true,
    requiredScope: "bz:write:guarded",
    inputSchema: BugzillaProposeUpdateInputSchema,
    outputSchema: BugzillaProposeUpdateOutputSchema,
  },
  {
    name: "bugzilla_create_bug",
    description: "Create a Bugzilla bug with idempotency protection.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    visibility: "model",
    mutating: true,
    requiredScope: "bz:write:guarded",
    inputSchema: BugzillaCreateBugInputSchema,
    outputSchema: BugzillaCreateBugOutputSchema,
  },
  {
    name: "bugzilla_get_attachment_excerpt",
    description: "Read a bounded text excerpt of a Bugzilla attachment.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    visibility: "model",
    mutating: false,
    requiredScope: "bz:read",
    inputSchema: BugzillaGetAttachmentExcerptInputSchema,
    outputSchema: BugzillaGetAttachmentExcerptOutputSchema,
  },
  {
    name: "app_save_draft",
    description: "Persist scoped draft text from the MCP App with monotonic revision.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    _meta: { ui: { visibility: ["app"] } },
    visibility: "app",
    mutating: true,
    requiredScope: "bz:read",
    inputSchema: AppSaveDraftInputSchema,
    outputSchema: AppSaveDraftOutputSchema,
  },
  {
    name: "app_get_draft",
    description: "Load persisted draft text for a bug inside the MCP App.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    _meta: { ui: { visibility: ["app"] } },
    visibility: "app",
    mutating: false,
    requiredScope: "bz:read",
    inputSchema: AppGetDraftInputSchema,
    outputSchema: AppGetDraftOutputSchema,
  },
  {
    name: "app_get_bug_full",
    description: "Fetch full authorized bug dossier and persisted draft for the MCP App.",
    annotations: { readOnlyHint: true, idempotentHint: true },
    _meta: { ui: { visibility: ["app"] } },
    visibility: "app",
    mutating: false,
    requiredScope: "bz:read",
    inputSchema: AppGetBugFullInputSchema,
    outputSchema: AppGetBugFullOutputSchema,
  },
  {
    name: "app_resolve_proposal",
    description: "Approve or reject a pending guarded-write proposal.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    _meta: { ui: { visibility: ["app"] } },
    visibility: "app",
    mutating: true,
    requiredScope: "bz:write:guarded",
    inputSchema: AppResolveProposalInputSchema,
    outputSchema: AppResolveProposalOutputSchema,
  },
] as const satisfies readonly ToolDefinition[];

const TOOL_BY_NAME: ReadonlyMap<string, (typeof TOOL_REGISTRY)[number]> = new Map(
  TOOL_REGISTRY.map((tool) => [tool.name, tool]),
);

export function getToolDefinition(name: string): (typeof TOOL_REGISTRY)[number] | undefined {
  return TOOL_BY_NAME.get(name);
}

function normalizeJsonSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(normalizeJsonSchemaNode);
  }
  if (typeof node !== "object" || node === null) {
    return node;
  }

  const record = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (
      record.type === "integer" &&
      ((key === "maximum" && value === Number.MAX_SAFE_INTEGER) ||
        (key === "minimum" && value === Number.MIN_SAFE_INTEGER))
    ) {
      continue;
    }
    if (key === "enum" && Array.isArray(value) && value.length === 1) {
      out.const = value[0];
      continue;
    }
    out[key] = normalizeJsonSchemaNode(value);
  }
  return out;
}

/**
 * Compile an Effect v4 `Schema` into a clean JSON Schema 2020-12 object,
 * optionally injecting `"x-mcp-header"` annotations for header-routed properties ([R-1120b2]).
 */
export function compileToolJsonSchema(
  schema: Schema.Constraint,
  options?: {
    readonly onExcessProperty?: "error" | "ignore";
    readonly headerRoutedProperties?: readonly string[];
  },
): JsonSchema.JsonSchema {
  const doc = Schema.toJsonSchemaDocument(schema, {
    onExcessProperty: options?.onExcessProperty ?? "error",
  });
  const normalizedRoot = normalizeJsonSchemaNode(doc.schema) as JsonSchema.JsonSchema;
  const defsKeys = Object.keys(doc.definitions);
  const result: JsonSchema.JsonSchema =
    defsKeys.length > 0
      ? {
          ...normalizedRoot,
          $defs: normalizeJsonSchemaNode(doc.definitions) as Record<string, JsonSchema.JsonSchema>,
        }
      : { ...normalizedRoot };

  const headerProps = options?.headerRoutedProperties;
  if (
    headerProps &&
    headerProps.length > 0 &&
    typeof result.properties === "object" &&
    result.properties !== null
  ) {
    const props = { ...(result.properties as Record<string, JsonSchema.JsonSchema>) };
    for (const propName of headerProps) {
      const existing = props[propName];
      if (typeof existing === "object" && existing !== null) {
        props[propName] = { ...existing, "x-mcp-header": propName };
      }
    }
    result.properties = props;
  }

  return result;
}

export type ToolInputByName = {
  readonly [T in (typeof TOOL_REGISTRY)[number] as T["name"]]: T["inputSchema"]["Type"];
};

export type ToolOutputByName = {
  readonly [T in (typeof TOOL_REGISTRY)[number] as T["name"]]: T["outputSchema"]["Type"];
};

/**
 * Build the complete MCP `tools/list` catalog (all 11 tools with generated
 * JSON Schema 2020-12 `inputSchema` and `outputSchema`).
 */
export function toMcpToolCatalog(
  headerRoutedParams: Readonly<Record<string, readonly string[]>> = {},
): readonly McpToolCatalogEntry[] {
  return TOOL_REGISTRY.map((tool) => {
    const headerRoutedProperties = headerRoutedParams[tool.name];
    const meta = "_meta" in tool ? tool._meta : undefined;
    return {
      name: tool.name,
      description: tool.description,
      annotations: tool.annotations,
      ...(meta !== undefined ? { _meta: meta } : {}),
      inputSchema: compileToolJsonSchema(tool.inputSchema, {
        onExcessProperty: "error",
        ...(headerRoutedProperties !== undefined ? { headerRoutedProperties } : {}),
      }),
      outputSchema: compileToolJsonSchema(tool.outputSchema, {
        onExcessProperty: "ignore",
      }),
    };
  });
}

export function decodeToolInputResult<N extends ToolName>(
  name: N,
  input: unknown,
): Result.Result<ToolInputByName[N], InvalidToolInput> {
  const def = TOOL_BY_NAME.get(name)!;
  return decodeOrInvalidInputResult(def.inputSchema, input, {
    contextLabel: `${name} arguments`,
    parseOptions: STRICT_PARSE_OPTIONS,
  }) as unknown as Result.Result<ToolInputByName[N], InvalidToolInput>;
}

export function decodeToolInput<N extends ToolName>(
  name: N,
  input: unknown,
): Effect.Effect<ToolInputByName[N], InvalidToolInput> {
  const def = TOOL_BY_NAME.get(name)!;
  return decodeOrInvalidInput(def.inputSchema, input, {
    contextLabel: `${name} arguments`,
    parseOptions: STRICT_PARSE_OPTIONS,
  }) as unknown as Effect.Effect<ToolInputByName[N], InvalidToolInput>;
}
