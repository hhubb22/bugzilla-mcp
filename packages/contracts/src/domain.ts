import { z } from "zod";

export const BugIdSchema = z.number().int().positive();
export type BugId = z.infer<typeof BugIdSchema>;

export const IsoTimestampSchema = z.string().datetime({ offset: true });
export type IsoTimestamp = z.infer<typeof IsoTimestampSchema>;

export const IdempotencyKeySchema = z.string().min(8).max(128);
export type IdempotencyKey = z.infer<typeof IdempotencyKeySchema>;

export const BugSummarySchema = z.object({
  id: BugIdSchema,
  summary: z.string(),
  product: z.string(),
  component: z.string(),
  status: z.string(),
  resolution: z.string(),
  priority: z.string(),
  severity: z.string(),
  assignedTo: z.string(),
  lastChangeTime: IsoTimestampSchema,
  pendingProposalCount: z.number().int().nonnegative().default(0),
});
export type BugSummary = z.infer<typeof BugSummarySchema>;

export const AttachmentMetaSchema = z.object({
  id: z.number().int().positive(),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  isObsolete: z.boolean(),
  isPrivate: z.boolean(),
  creator: z.string(),
  creationTime: IsoTimestampSchema,
});
export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

export const CommentSummarySchema = z.object({
  id: z.number().int().positive(),
  creator: z.string(),
  time: IsoTimestampSchema,
  isPrivate: z.boolean(),
  text: z.string(),
  untrustedUserContent: z.literal(true),
});
export type CommentSummary = z.infer<typeof CommentSummarySchema>;

export const InternalNoteSchema = z.object({
  id: z.string().min(1),
  bugId: BugIdSchema,
  createdAt: IsoTimestampSchema,
  text: z.string(),
});
export type InternalNote = z.infer<typeof InternalNoteSchema>;

export const BugDossierSchema = z.object({
  bug: BugSummarySchema,
  recentComments: z.array(CommentSummarySchema),
  recentHistory: z.array(
    z.object({
      when: IsoTimestampSchema,
      who: z.string(),
      changes: z.array(
        z.object({
          fieldName: z.string(),
          removed: z.string(),
          added: z.string(),
        }),
      ),
    }),
  ),
  attachments: z.array(AttachmentMetaSchema),
  internalNotes: z.array(InternalNoteSchema),
});
export type BugDossier = z.infer<typeof BugDossierSchema>;

export const ProposalDiffSchema = z.object({
  status: z.string().optional(),
  resolution: z.string().optional(),
  assignedTo: z.string().optional(),
  priority: z.string().optional(),
  severity: z.string().optional(),
  publicComment: z.string().optional(),
  flags: z
    .array(
      z.object({
        name: z.string().min(1),
        status: z.enum(["?", "+", "-", "X"]),
        requestee: z.string().optional(),
      }),
    )
    .optional(),
});
export type ProposalDiff = z.infer<typeof ProposalDiffSchema>;

export const ApprovalProofSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cloud_signed_token"),
    token: z.string().min(16),
  }),
  z.object({
    kind: z.literal("local_ide_host_confirmed"),
    confirmedAt: IsoTimestampSchema,
  }),
  z.object({
    kind: z.literal("policy_grant"),
    policyId: z.string().min(1),
  }),
]);
export type ApprovalProof = z.infer<typeof ApprovalProofSchema>;

/** Mutually exclusive write guard outcomes (Section 4.2 Parnas table) */
export const WriteGuardOutcomeSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("Applied"),
    artifactId: z.string().min(1),
    bugId: BugIdSchema,
    auditRecorded: z.boolean(),
  }),
  z.object({
    outcome: z.literal("SavedAsInternalNote"),
    noteId: z.string().min(1),
    bugId: BugIdSchema,
    reason: z.enum(["non_insider", "private_rejected"]),
  }),
  z.object({
    outcome: z.literal("DuplicateNoOp"),
    originalArtifactId: z.string().min(1),
  }),
  z.object({
    outcome: z.literal("OperationPending"),
    idempotencyKey: IdempotencyKeySchema,
  }),
  z.object({
    outcome: z.literal("OperationIndeterminate"),
    idempotencyKey: IdempotencyKeySchema,
    reconciliationHint: z.string(),
  }),
  z.object({
    outcome: z.literal("IdempotencyConflict"),
    idempotencyKey: IdempotencyKeySchema,
  }),
  z.object({
    outcome: z.literal("ProposalPending"),
    proposalId: z.string().min(1),
    revision: z.number().int().positive(),
    approvalUrl: z.string().url().optional(),
  }),
  z.object({
    outcome: z.literal("StaleBugConflict"),
    expectedLastChangeTime: IsoTimestampSchema,
    actualLastChangeTime: IsoTimestampSchema,
    latestAuthorizedSnapshot: BugSummarySchema,
  }),
  z.object({
    outcome: z.literal("CausalBudgetExhausted"),
    bugId: BugIdSchema,
    retryAfterMs: z.number().int().positive(),
  }),
]);
export type WriteGuardOutcome = z.infer<typeof WriteGuardOutcomeSchema>;

export const DraftKindSchema = z.enum(["private_comment", "public_comment", "proposal_edit"]);
export type DraftKind = z.infer<typeof DraftKindSchema>;

export const DraftSaveResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("acknowledged"),
    draftRevision: z.number().int().positive(),
    savedAt: IsoTimestampSchema,
  }),
  z.object({
    status: z.literal("stale_revision"),
    currentRevision: z.number().int().positive(),
  }),
]);
export type DraftSaveResult = z.infer<typeof DraftSaveResultSchema>;
