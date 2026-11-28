import { Effect, Schema } from "effect";
import {
  ApprovalProofSchema,
  BugDossierSchema,
  BugIdSchema,
  BugSummarySchema,
  DraftKindSchema,
  DraftSaveResultSchema,
  IdempotencyKeySchema,
  IsoTimestampSchema,
  NonEmptyTrimmedStringSchema,
  ProposalDiffSchema,
  ProposalRecordSchema,
  StoredDraftSchema,
  WriteGuardAppliedOutcomeSchema,
  WriteGuardDuplicateNoOpOutcomeSchema,
  WriteGuardProposalPendingOutcomeSchema,
  WriteGuardProposalRejectedOutcomeSchema,
  WriteGuardSavedAsInternalNoteOutcomeSchema,
  trimmedString,
} from "./domain.js";
import { DeploymentModeSchema, HttpUrlSchema } from "./mcp-wire.js";

export const CUSTOM_FIELD_KEY_PATTERN = /^cf_[a-z0-9_]+$/;

export const CustomFieldsSchema = Schema.Record(Schema.String, Schema.Unknown).check(
  Schema.makeFilter(
    (record) => {
      const issues: Schema.FilterIssue[] = [];
      for (const key of Object.keys(record)) {
        if (!CUSTOM_FIELD_KEY_PATTERN.test(key)) {
          issues.push({
            path: [key],
            issue: `Custom field key "${key}" must match /^cf_[a-z0-9_]+$/`,
          });
        }
      }
      return issues.length > 0 ? issues : undefined;
    },
    {
      message: "Custom field keys must match /^cf_[a-z0-9_]+$/",
      toJsonSchema: () => ({
        propertyNames: { pattern: "^cf_[a-z0-9_]+$" },
      }),
    },
  ),
);
export type CustomFields = typeof CustomFieldsSchema.Type;

export const TriageBoardTabSchema = Schema.Literals([
  "pending_proposals",
  "needinfo_or_mine",
  "untriaged",
]);
export type TriageBoardTab = typeof TriageBoardTabSchema.Type;

// ---------------------------------------------------------------------------
// 1. bugzilla_search
// ---------------------------------------------------------------------------

export const BugzillaSearchInputSchema = Schema.Struct({
  product: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  component: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  status: Schema.optionalKey(Schema.Array(NonEmptyTrimmedStringSchema)),
  assignedTo: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  updatedSince: Schema.optionalKey(IsoTimestampSchema),
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  limit: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(20)),
    Schema.annotateEncoded({ default: 20 }),
  ),
  offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
    Schema.annotateEncoded({ default: 0 }),
  ),
});
export type BugzillaSearchInput = typeof BugzillaSearchInputSchema.Type;

export const BugzillaSearchOutputSchema = Schema.Struct({
  items: Schema.Array(BugSummarySchema),
  hasMore: Schema.Boolean,
  nextOffset: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  totalHint: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type BugzillaSearchOutput = typeof BugzillaSearchOutputSchema.Type;

// ---------------------------------------------------------------------------
// 2. bugzilla_get_dossier
// ---------------------------------------------------------------------------

export const BugzillaGetDossierInputSchema = Schema.Struct({
  bugId: BugIdSchema,
  maxComments: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(15)),
    Schema.annotateEncoded({ default: 15 }),
  ),
  maxHistory: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(30)),
    Schema.annotateEncoded({ default: 30 }),
  ),
});
export type BugzillaGetDossierInput = typeof BugzillaGetDossierInputSchema.Type;

export const BugzillaGetDossierOutputSchema = Schema.Struct({
  ...BugDossierSchema.fields,
  tenantKey: Schema.optionalKey(Schema.NonEmptyString),
});
export type BugzillaGetDossierOutput = typeof BugzillaGetDossierOutputSchema.Type;

// ---------------------------------------------------------------------------
// 3. bugzilla_triage_board
// ---------------------------------------------------------------------------

export const BugzillaTriageBoardInputSchema = Schema.Struct({
  tab: Schema.optionalKey(TriageBoardTabSchema),
  product: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  focusBugId: Schema.optionalKey(BugIdSchema),
});
export type BugzillaTriageBoardInput = typeof BugzillaTriageBoardInputSchema.Type;

export const BugzillaTriageBoardOutputSchema = Schema.Struct({
  tenantKey: Schema.NonEmptyString,
  instanceUrl: HttpUrlSchema,
  principalId: Schema.NonEmptyString,
  deploymentMode: DeploymentModeSchema,
  fetchedAt: IsoTimestampSchema,
  activeTab: TriageBoardTabSchema,
  focusBugId: Schema.optionalKey(BugIdSchema),
  bugs: Schema.Array(BugSummarySchema),
  proposals: Schema.Array(ProposalRecordSchema),
  hasMore: Schema.Boolean,
});
export type BugzillaTriageBoardOutput = typeof BugzillaTriageBoardOutputSchema.Type;

// ---------------------------------------------------------------------------
// 4. bugzilla_post_analysis (Safe-Auto: isPrivate locked to true)
// ---------------------------------------------------------------------------

/** Safe-Auto invariant: isPrivate is locked to true at the type/schema boundary ([R-80b183]). */
export const BugzillaPostAnalysisInputSchema = Schema.Struct({
  bugId: BugIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  isPrivate: Schema.Literal(true).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
    Schema.annotateEncoded({ default: true }),
  ),
  analysisMarkdown: trimmedString({
    minLength: 1,
    maxLength: 32_768,
    fieldName: "analysisMarkdown",
  }),
  causalEventId: Schema.optionalKey(NonEmptyTrimmedStringSchema),
});
export type BugzillaPostAnalysisInput = typeof BugzillaPostAnalysisInputSchema.Type;

export const BugzillaPostAnalysisOutputSchema = Schema.Union([
  WriteGuardAppliedOutcomeSchema,
  WriteGuardSavedAsInternalNoteOutcomeSchema,
  WriteGuardDuplicateNoOpOutcomeSchema,
]);
export type BugzillaPostAnalysisOutput = typeof BugzillaPostAnalysisOutputSchema.Type;

// ---------------------------------------------------------------------------
// 5. bugzilla_propose_update (Guarded-Write)
// ---------------------------------------------------------------------------

export const BugzillaProposeUpdateInputSchema = Schema.Struct({
  bugId: BugIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  expectedLastChangeTime: IsoTimestampSchema,
  diff: ProposalDiffSchema,
  rationale: trimmedString({ minLength: 1, maxLength: 8_192, fieldName: "rationale" }),
  approval: Schema.optionalKey(ApprovalProofSchema),
  causalEventId: Schema.optionalKey(NonEmptyTrimmedStringSchema),
});
export type BugzillaProposeUpdateInput = typeof BugzillaProposeUpdateInputSchema.Type;

export const BugzillaProposeUpdateOutputSchema = Schema.Union([
  WriteGuardAppliedOutcomeSchema,
  WriteGuardDuplicateNoOpOutcomeSchema,
  WriteGuardProposalPendingOutcomeSchema,
]);
export type BugzillaProposeUpdateOutput = typeof BugzillaProposeUpdateOutputSchema.Type;

// ---------------------------------------------------------------------------
// 6. bugzilla_create_bug
// ---------------------------------------------------------------------------

export const BugzillaCreateBugInputSchema = Schema.Struct({
  idempotencyKey: IdempotencyKeySchema,
  product: trimmedString({ minLength: 1, fieldName: "product" }),
  component: trimmedString({ minLength: 1, fieldName: "component" }),
  version: trimmedString({ minLength: 1, fieldName: "version" }),
  summary: trimmedString({ minLength: 1, maxLength: 255, fieldName: "summary" }),
  description: trimmedString({ minLength: 1, maxLength: 32_768, fieldName: "description" }),
  severity: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  priority: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  opSys: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  platform: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  assignedTo: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  targetMilestone: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  cc: Schema.optionalKey(Schema.Array(NonEmptyTrimmedStringSchema)),
  groups: Schema.optionalKey(Schema.Array(NonEmptyTrimmedStringSchema)),
  keywords: Schema.optionalKey(Schema.Array(NonEmptyTrimmedStringSchema)),
  customFields: Schema.optionalKey(CustomFieldsSchema),
});
export type BugzillaCreateBugInput = typeof BugzillaCreateBugInputSchema.Type;

export const BugzillaCreateBugOutputSchema = Schema.Union([
  WriteGuardAppliedOutcomeSchema,
  WriteGuardDuplicateNoOpOutcomeSchema,
]);
export type BugzillaCreateBugOutput = typeof BugzillaCreateBugOutputSchema.Type;

// ---------------------------------------------------------------------------
// 7. bugzilla_get_attachment_excerpt
// ---------------------------------------------------------------------------

export const BugzillaGetAttachmentExcerptInputSchema = Schema.Struct({
  attachmentId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  byteOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
    Schema.annotateEncoded({ default: 0 }),
  ),
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65_536 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(16_384)),
    Schema.annotateEncoded({ default: 16_384 }),
  ),
});
export type BugzillaGetAttachmentExcerptInput = typeof BugzillaGetAttachmentExcerptInputSchema.Type;

export const BugzillaGetAttachmentExcerptOutputSchema = Schema.Struct({
  attachmentId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  bugId: BugIdSchema,
  fileName: Schema.String,
  contentType: Schema.String,
  totalBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  byteOffset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  excerptText: Schema.String,
  truncated: Schema.Boolean,
  isPrivate: Schema.Boolean,
  untrustedUserContent: Schema.Literal(true),
});
export type BugzillaGetAttachmentExcerptOutput =
  typeof BugzillaGetAttachmentExcerptOutputSchema.Type;

// ---------------------------------------------------------------------------
// 8. app_save_draft
// ---------------------------------------------------------------------------

export const AppSaveDraftInputSchema = Schema.Struct({
  bugId: BugIdSchema,
  draftKind: DraftKindSchema,
  draftRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  content: Schema.String.check(Schema.isMaxLength(32_768)),
});
export type AppSaveDraftInput = typeof AppSaveDraftInputSchema.Type;

export const AppSaveDraftOutputSchema = DraftSaveResultSchema;
export type AppSaveDraftOutput = typeof AppSaveDraftOutputSchema.Type;

// ---------------------------------------------------------------------------
// 9. app_get_draft
// ---------------------------------------------------------------------------

export const AppGetDraftInputSchema = Schema.Struct({
  bugId: BugIdSchema,
  draftKind: DraftKindSchema.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("private_comment" as const)),
    Schema.annotateEncoded({ default: "private_comment" }),
  ),
});
export type AppGetDraftInput = typeof AppGetDraftInputSchema.Type;

export const AppGetDraftOutputSchema = Schema.Struct({
  draft: Schema.NullOr(StoredDraftSchema),
});
export type AppGetDraftOutput = typeof AppGetDraftOutputSchema.Type;

// ---------------------------------------------------------------------------
// 10. app_get_bug_full
// ---------------------------------------------------------------------------

export const AppGetBugFullInputSchema = Schema.Struct({
  bugId: BugIdSchema,
  maxComments: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 50 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(20)),
    Schema.annotateEncoded({ default: 20 }),
  ),
  maxHistory: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(20)),
    Schema.annotateEncoded({ default: 20 }),
  ),
});
export type AppGetBugFullInput = typeof AppGetBugFullInputSchema.Type;

export const AppGetBugFullOutputSchema = Schema.Struct({
  dossier: BugDossierSchema,
  draft: Schema.NullOr(StoredDraftSchema),
  proposals: Schema.Array(ProposalRecordSchema),
});
export type AppGetBugFullOutput = typeof AppGetBugFullOutputSchema.Type;

// ---------------------------------------------------------------------------
// 11. app_resolve_proposal
// ---------------------------------------------------------------------------

export const AppResolveProposalInputSchema = Schema.Struct({
  proposalId: NonEmptyTrimmedStringSchema,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  decision: Schema.Literals(["approve", "reject"]),
  idempotencyKey: IdempotencyKeySchema,
  approval: Schema.optionalKey(ApprovalProofSchema),
});
export type AppResolveProposalInput = typeof AppResolveProposalInputSchema.Type;

export const AppResolveProposalOutputSchema = Schema.Union([
  WriteGuardAppliedOutcomeSchema,
  WriteGuardProposalRejectedOutcomeSchema,
  WriteGuardDuplicateNoOpOutcomeSchema,
]);
export type AppResolveProposalOutput = typeof AppResolveProposalOutputSchema.Type;
