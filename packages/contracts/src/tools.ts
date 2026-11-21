import { z } from "zod";
import {
  ApprovalProofSchema,
  BugIdSchema,
  DraftKindSchema,
  IdempotencyKeySchema,
  IsoTimestampSchema,
  ProposalDiffSchema,
} from "./domain.js";

export const BugzillaSearchInputSchema = z.object({
  product: z.string().min(1).optional(),
  component: z.string().min(1).optional(),
  status: z.array(z.string().min(1)).optional(),
  assignedTo: z.string().min(1).optional(),
  updatedSince: IsoTimestampSchema.optional(),
  query: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(50).default(20),
  offset: z.number().int().nonnegative().default(0),
});
export type BugzillaSearchInput = z.infer<typeof BugzillaSearchInputSchema>;

export const BugzillaGetDossierInputSchema = z.object({
  bugId: BugIdSchema,
  maxComments: z.number().int().min(0).max(50).default(15),
  maxHistory: z.number().int().min(0).max(100).default(30),
});
export type BugzillaGetDossierInput = z.infer<typeof BugzillaGetDossierInputSchema>;

export const BugzillaTriageBoardInputSchema = z.object({
  tab: z.enum(["pending_proposals", "needinfo_or_mine", "untriaged"]).optional(),
  product: z.string().min(1).optional(),
  focusBugId: BugIdSchema.optional(),
});
export type BugzillaTriageBoardInput = z.infer<typeof BugzillaTriageBoardInputSchema>;

/** Safe-Auto invariant: isPrivate is locked to true at the type/schema boundary */
export const BugzillaPostAnalysisInputSchema = z.object({
  bugId: BugIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  isPrivate: z.literal(true).default(true),
  analysisMarkdown: z.string().min(1).max(32_768),
  causalEventId: z.string().min(1).optional(),
});
export type BugzillaPostAnalysisInput = z.infer<typeof BugzillaPostAnalysisInputSchema>;

export const BugzillaProposeUpdateInputSchema = z.object({
  bugId: BugIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  expectedLastChangeTime: IsoTimestampSchema,
  diff: ProposalDiffSchema,
  rationale: z.string().min(1).max(8_192),
  approval: ApprovalProofSchema.optional(),
  causalEventId: z.string().min(1).optional(),
});
export type BugzillaProposeUpdateInput = z.infer<typeof BugzillaProposeUpdateInputSchema>;

export const BugzillaCreateBugInputSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
  product: z.string().min(1).optional(),
  component: z.string().min(1).optional(),
  version: z.string().min(1).optional(),
  summary: z.string().min(1).max(255),
  description: z.string().min(1).max(32_768),
  severity: z.string().min(1).optional(),
  priority: z.string().min(1).optional(),
  customFields: z.record(z.unknown()).optional(),
});
export type BugzillaCreateBugInput = z.infer<typeof BugzillaCreateBugInputSchema>;

export const BugzillaGetAttachmentExcerptInputSchema = z.object({
  attachmentId: z.number().int().positive(),
  byteOffset: z.number().int().nonnegative().default(0),
  maxBytes: z.number().int().min(1).max(65_536).default(16_384),
});
export type BugzillaGetAttachmentExcerptInput = z.infer<typeof BugzillaGetAttachmentExcerptInputSchema>;

export const AppResolveProposalInputSchema = z.object({
  proposalId: z.string().min(1),
  revision: z.number().int().positive(),
  decision: z.enum(["approve", "reject"]),
  idempotencyKey: IdempotencyKeySchema,
  approval: ApprovalProofSchema.optional(),
});
export type AppResolveProposalInput = z.infer<typeof AppResolveProposalInputSchema>;

export const AppSaveDraftInputSchema = z.object({
  bugId: BugIdSchema,
  draftKind: DraftKindSchema,
  draftRevision: z.number().int().positive(),
  content: z.string().max(32_768),
});
export type AppSaveDraftInput = z.infer<typeof AppSaveDraftInputSchema>;
