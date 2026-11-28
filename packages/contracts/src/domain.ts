import { Effect, Schema, SchemaTransformation } from "effect";
import { HttpUrlSchema } from "./mcp-wire.js";

export const BugIdSchema = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(1, { message: "Bug ID must be a positive integer" }),
);
export type BugId = typeof BugIdSchema.Type;

const ISO_TIMESTAMP_WITH_OFFSET_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export const IsoTimestampSchema = Schema.String.check(
  Schema.makeFilter(
    (value) =>
      (ISO_TIMESTAMP_WITH_OFFSET_RE.test(value) && !Number.isNaN(Date.parse(value))) ||
      "Expected an ISO-8601 timestamp with timezone offset (e.g. 2026-01-01T00:00:00Z)",
    {
      message: "Expected an ISO-8601 timestamp with timezone offset",
      toJsonSchema: () => ({ format: "date-time" }),
    },
  ),
);
export type IsoTimestamp = typeof IsoTimestampSchema.Type;

export const IdempotencyKeySchema = Schema.String.check(
  Schema.isMinLength(8, { message: "idempotencyKey must be at least 8 characters" }),
  Schema.isMaxLength(128, { message: "idempotencyKey must be at most 128 characters" }),
);
export type IdempotencyKey = typeof IdempotencyKeySchema.Type;

/**
 * Helper for trimmed strings that preserve minLength / maxLength constraints
 * in both runtime validation and generated JSON Schema 2020-12.
 */
export function trimmedString(options?: {
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly fieldName?: string;
}) {
  const min = options?.minLength ?? 1;
  const max = options?.maxLength;
  const label = options?.fieldName ?? "Value";

  const encodedMin = Schema.isMinLength(min, {
    message: `${label} must be at least ${min} character${min === 1 ? "" : "s"}`,
  });
  const decodedMin = Schema.isMinLength(min, {
    message: `${label} must be non-empty after trimming whitespace`,
  });

  const encodedSchema =
    max !== undefined
      ? Schema.String.check(
          encodedMin,
          Schema.isMaxLength(max, { message: `${label} must be at most ${max} characters` }),
        )
      : Schema.String.check(encodedMin);

  const decodedSchema =
    max !== undefined
      ? Schema.String.check(
          decodedMin,
          Schema.isMaxLength(max, { message: `${label} must be at most ${max} characters` }),
        )
      : Schema.String.check(decodedMin);

  return encodedSchema.pipe(
    Schema.decodeTo(
      decodedSchema,
      SchemaTransformation.transform({
        decode: (s) => s.trim(),
        encode: (s) => s,
      }),
    ),
  );
}

export const NonEmptyTrimmedStringSchema = trimmedString({ minLength: 1 });
export type NonEmptyTrimmedString = typeof NonEmptyTrimmedStringSchema.Type;

export const FlagStatusSchema = Schema.Literals(["?", "+", "-", "X"]);
export type FlagStatus = typeof FlagStatusSchema.Type;

export const BugFlagSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  typeId: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  name: Schema.NonEmptyString,
  status: FlagStatusSchema,
  requestee: Schema.optionalKey(Schema.String),
  setter: Schema.optionalKey(Schema.String),
  new: Schema.optionalKey(Schema.Boolean),
});
export type BugFlag = typeof BugFlagSchema.Type;

export const BugSummarySchema = Schema.Struct({
  id: BugIdSchema,
  summary: Schema.String,
  product: Schema.String,
  component: Schema.String,
  status: Schema.String,
  resolution: Schema.String,
  priority: Schema.String,
  severity: Schema.String,
  assignedTo: Schema.String,
  lastChangeTime: IsoTimestampSchema,
  pendingProposalCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
    Schema.annotateEncoded({ default: 0 }),
  ),
  version: Schema.optionalKey(Schema.String),
  opSys: Schema.optionalKey(Schema.String),
  platform: Schema.optionalKey(Schema.String),
  creator: Schema.optionalKey(Schema.String),
  creationTime: Schema.optionalKey(IsoTimestampSchema),
  flags: Schema.optionalKey(Schema.Array(BugFlagSchema)),
  customFields: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
export type BugSummary = typeof BugSummarySchema.Type;

export const AttachmentMetaSchema = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  fileName: Schema.String,
  contentType: Schema.String,
  sizeBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  isObsolete: Schema.Boolean,
  isPrivate: Schema.Boolean,
  creator: Schema.String,
  creationTime: IsoTimestampSchema,
});
export type AttachmentMeta = typeof AttachmentMetaSchema.Type;

export const CommentSummarySchema = Schema.Struct({
  id: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  creator: Schema.String,
  time: IsoTimestampSchema,
  isPrivate: Schema.Boolean,
  text: Schema.String,
  untrustedUserContent: Schema.Literal(true),
});
export type CommentSummary = typeof CommentSummarySchema.Type;

export const InternalNoteSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  bugId: BugIdSchema,
  createdAt: IsoTimestampSchema,
  text: Schema.String,
});
export type InternalNote = typeof InternalNoteSchema.Type;

export const BugHistoryChangeSchema = Schema.Struct({
  fieldName: Schema.String,
  removed: Schema.String,
  added: Schema.String,
});
export type BugHistoryChange = typeof BugHistoryChangeSchema.Type;

export const BugHistoryEntrySchema = Schema.Struct({
  when: IsoTimestampSchema,
  who: Schema.String,
  changes: Schema.Array(BugHistoryChangeSchema),
});
export type BugHistoryEntry = typeof BugHistoryEntrySchema.Type;

export const BugDossierSchema = Schema.Struct({
  bug: BugSummarySchema,
  recentComments: Schema.Array(CommentSummarySchema),
  recentHistory: Schema.Array(BugHistoryEntrySchema),
  attachments: Schema.Array(AttachmentMetaSchema),
  internalNotes: Schema.Array(InternalNoteSchema),
});
export type BugDossier = typeof BugDossierSchema.Type;

export const ProposalFlagDiffSchema = Schema.Struct({
  name: NonEmptyTrimmedStringSchema,
  status: FlagStatusSchema,
  requestee: Schema.optionalKey(Schema.String),
  id: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  typeId: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  new: Schema.optionalKey(Schema.Boolean),
});
export type ProposalFlagDiff = typeof ProposalFlagDiffSchema.Type;

export const ProposalDiffSchema = Schema.Struct({
  status: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  resolution: Schema.optionalKey(Schema.String),
  assignedTo: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  priority: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  severity: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  publicComment: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  dupeOf: Schema.optionalKey(BugIdSchema),
  flags: Schema.optionalKey(
    Schema.Array(ProposalFlagDiffSchema).check(
      Schema.isMinLength(1, {
        message: "flags must contain at least one flag update when provided",
      }),
    ),
  ),
}).check(
  Schema.isMinProperties(1, {
    message: "Proposal diff must specify at least one field to update",
  }),
  Schema.makeFilter((diff) => {
    const issues: Schema.FilterIssue[] = [];
    if (diff.status === "RESOLVED" && (!diff.resolution || diff.resolution.trim().length === 0)) {
      issues.push({
        path: ["resolution"],
        issue: 'Setting status to "RESOLVED" requires a non-empty resolution',
      });
    }
    if (diff.resolution === "DUPLICATE" && diff.dupeOf === undefined) {
      issues.push({
        path: ["dupeOf"],
        issue: 'Setting resolution to "DUPLICATE" requires a positive integer dupeOf bug ID',
      });
    }
    return issues.length > 0 ? issues : undefined;
  }),
);
export type ProposalDiff = typeof ProposalDiffSchema.Type;

export const ApprovalProofSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("cloud_signed_token"),
    token: Schema.String.check(Schema.isMinLength(16)),
  }),
  Schema.Struct({
    kind: Schema.Literal("local_ide_host_confirmed"),
    confirmedAt: IsoTimestampSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("policy_grant"),
    policyId: Schema.NonEmptyString,
  }),
]);
export type ApprovalProof = typeof ApprovalProofSchema.Type;

export const ProposalStateSchema = Schema.Literals([
  "pending",
  "executing",
  "approved",
  "rejected",
  "applied",
  "stale",
  "indeterminate",
]);
export type ProposalState = typeof ProposalStateSchema.Type;

export const ProposalRecordSchema = Schema.Struct({
  proposalId: Schema.NonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  issuer: Schema.NonEmptyString,
  principalId: Schema.NonEmptyString,
  instanceUrl: HttpUrlSchema,
  bugId: BugIdSchema,
  baseVersion: IsoTimestampSchema,
  diff: ProposalDiffSchema,
  rationale: Schema.String,
  state: ProposalStateSchema,
  approvalUrl: Schema.optionalKey(HttpUrlSchema),
});
export type ProposalRecord = typeof ProposalRecordSchema.Type;

/** Individual WriteGuardOutcome variants (for tool-specific non-error outputSchemas) */
export const WriteGuardAppliedOutcomeSchema = Schema.Struct({
  outcome: Schema.Literal("Applied"),
  artifactId: Schema.NonEmptyString,
  bugId: BugIdSchema,
  auditRecorded: Schema.Boolean,
});

export const WriteGuardSavedAsInternalNoteOutcomeSchema = Schema.Struct({
  outcome: Schema.Literal("SavedAsInternalNote"),
  noteId: Schema.NonEmptyString,
  bugId: BugIdSchema,
  reason: Schema.Literals(["non_insider", "private_rejected"]),
});

export const WriteGuardDuplicateNoOpOutcomeSchema = Schema.Struct({
  outcome: Schema.Literal("DuplicateNoOp"),
  originalArtifactId: Schema.NonEmptyString,
});

export const WriteGuardOperationPendingOutcomeSchema = Schema.Struct({
  outcome: Schema.Literal("OperationPending"),
  idempotencyKey: IdempotencyKeySchema,
});

export const WriteGuardOperationIndeterminateOutcomeSchema = Schema.Struct({
  outcome: Schema.Literal("OperationIndeterminate"),
  idempotencyKey: IdempotencyKeySchema,
  reconciliationHint: Schema.String,
});

export const WriteGuardIdempotencyConflictOutcomeSchema = Schema.Struct({
  outcome: Schema.Literal("IdempotencyConflict"),
  idempotencyKey: IdempotencyKeySchema,
});

export const WriteGuardProposalPendingOutcomeSchema = Schema.Struct({
  outcome: Schema.Literal("ProposalPending"),
  proposalId: Schema.NonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  approvalUrl: Schema.optionalKey(HttpUrlSchema),
  approvalExpiresAt: Schema.optionalKey(IsoTimestampSchema),
});

export const WriteGuardProposalRejectedOutcomeSchema = Schema.Struct({
  outcome: Schema.Literal("ProposalRejected"),
  proposalId: Schema.NonEmptyString,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  bugId: BugIdSchema,
  artifactId: Schema.NonEmptyString,
  rejectedAt: Schema.optionalKey(IsoTimestampSchema),
});

export const WriteGuardStaleBugConflictOutcomeSchema = Schema.Struct({
  outcome: Schema.Literal("StaleBugConflict"),
  expectedLastChangeTime: IsoTimestampSchema,
  actualLastChangeTime: IsoTimestampSchema,
  latestAuthorizedSnapshot: BugSummarySchema,
});

export const WriteGuardCausalBudgetExhaustedOutcomeSchema = Schema.Struct({
  outcome: Schema.Literal("CausalBudgetExhausted"),
  bugId: BugIdSchema,
  retryAfterMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
});

export const WriteGuardUpstreamRejectedOutcomeSchema = Schema.Struct({
  outcome: Schema.Literal("UpstreamRejected"),
  effectCertainty: Schema.Literal("none"),
  bzErrorCode: Schema.optionalKey(Schema.Int),
  reason: Schema.NonEmptyString,
  missingFields: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  fieldHints: Schema.optionalKey(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  remediationHint: Schema.NonEmptyString,
});

/** Mutually exclusive write guard outcomes (Section 4.2 Parnas table + Track A extensions) */
export const WriteGuardOutcomeSchema = Schema.Union([
  WriteGuardAppliedOutcomeSchema,
  WriteGuardSavedAsInternalNoteOutcomeSchema,
  WriteGuardDuplicateNoOpOutcomeSchema,
  WriteGuardOperationPendingOutcomeSchema,
  WriteGuardOperationIndeterminateOutcomeSchema,
  WriteGuardIdempotencyConflictOutcomeSchema,
  WriteGuardProposalPendingOutcomeSchema,
  WriteGuardProposalRejectedOutcomeSchema,
  WriteGuardStaleBugConflictOutcomeSchema,
  WriteGuardCausalBudgetExhaustedOutcomeSchema,
  WriteGuardUpstreamRejectedOutcomeSchema,
]);
export type WriteGuardOutcome = typeof WriteGuardOutcomeSchema.Type;

export const DraftKindSchema = Schema.Literals([
  "private_comment",
  "public_comment",
  "proposal_edit",
]);
export type DraftKind = typeof DraftKindSchema.Type;

export const DraftSaveResultSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("acknowledged"),
    draftRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    savedAt: IsoTimestampSchema,
  }),
  Schema.Struct({
    status: Schema.Literal("stale_revision"),
    currentRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
]);
export type DraftSaveResult = typeof DraftSaveResultSchema.Type;

export const StoredDraftSchema = Schema.Struct({
  bugId: BugIdSchema,
  draftKind: DraftKindSchema,
  draftRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  content: Schema.String,
  savedAt: IsoTimestampSchema,
});
export type StoredDraftRecord = typeof StoredDraftSchema.Type;

/** Instance schema introspection models (/rest/field/bug, /rest/product, bugzilla://schema/*) */
export const FieldStatusTransitionSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  commentRequired: Schema.Boolean,
});
export type FieldStatusTransition = typeof FieldStatusTransitionSchema.Type;

export const FieldValueMetadataSchema = Schema.Struct({
  name: Schema.String,
  sortKey: Schema.optionalKey(Schema.Int),
  isActive: Schema.optionalKey(Schema.Boolean),
  visibilityValues: Schema.optionalKey(Schema.Array(Schema.String)),
  canChangeTo: Schema.optionalKey(Schema.Array(FieldStatusTransitionSchema)),
});
export type FieldValueMetadata = typeof FieldValueMetadataSchema.Type;

export const FieldMetadataSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.Int),
  name: Schema.NonEmptyString,
  displayName: Schema.String,
  type: Schema.Int,
  isCustom: Schema.Boolean,
  isMandatory: Schema.Boolean,
  isOnBugEntry: Schema.Boolean,
  values: Schema.optionalKey(Schema.Array(FieldValueMetadataSchema)),
});
export type FieldMetadata = typeof FieldMetadataSchema.Type;

export const ProductComponentMetadataSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.Int),
  name: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.String),
  defaultAssignedTo: Schema.optionalKey(Schema.String),
  isActive: Schema.Boolean,
});
export type ProductComponentMetadata = typeof ProductComponentMetadataSchema.Type;

export const ProductVersionMetadataSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.Int),
  name: Schema.NonEmptyString,
  isActive: Schema.Boolean,
});
export type ProductVersionMetadata = typeof ProductVersionMetadataSchema.Type;

export const ProductMetadataSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.Int),
  name: Schema.NonEmptyString,
  description: Schema.optionalKey(Schema.String),
  isActive: Schema.Boolean,
  defaultMilestone: Schema.optionalKey(Schema.String),
  components: Schema.Array(ProductComponentMetadataSchema),
  versions: Schema.Array(ProductVersionMetadataSchema),
  milestones: Schema.optionalKey(Schema.Array(ProductVersionMetadataSchema)),
});
export type ProductMetadata = typeof ProductMetadataSchema.Type;

export const InstanceMetadataSchema = Schema.Struct({
  instanceUrl: HttpUrlSchema,
  fetchedAt: IsoTimestampSchema,
  productNames: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  products: Schema.optionalKey(Schema.Array(ProductMetadataSchema)),
  fields: Schema.optionalKey(Schema.Array(FieldMetadataSchema)),
  defaultOpSys: Schema.optionalKey(Schema.NonEmptyString),
  defaultPlatform: Schema.optionalKey(Schema.NonEmptyString),
});
export type InstanceMetadata = typeof InstanceMetadataSchema.Type;
