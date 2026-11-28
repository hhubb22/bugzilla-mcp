import { Context, Data, Effect, Layer } from "effect";
import type {
  BugId,
  DraftKind,
  DraftSaveResult,
  EventFilterArgs,
  EventName,
  IdempotencyKey,
  InternalNote,
  IsoTimestamp,
  PrincipalContext,
  PrincipalScope,
  ProposalDiff,
  ProposalState,
} from "@bugzilla-mcp/contracts";

export const DEFAULT_RECEIPT_LEASE_MS = 60_000;

export class StorageError extends Data.TaggedError("StorageError")<{
  readonly message: string;
  readonly operation: string;
  readonly cause?: unknown;
}> {}

export interface TenantScope {
  readonly issuer: string;
  readonly principalId: string;
  readonly instanceUrl: string;
}

export interface IdempotencyScope extends TenantScope {
  readonly operation: string;
  readonly key: IdempotencyKey;
}

export interface StoredReceiptPending {
  readonly status: "pending";
  readonly intentHash: string;
  readonly createdAt: IsoTimestamp;
  readonly leaseToken: string;
  readonly leaseExpiresAtMs: number;
  readonly dispatchAttempted: boolean;
}

export interface StoredReceiptApplied {
  readonly status: "applied";
  readonly intentHash: string;
  readonly artifactId: string;
}

export interface StoredReceiptFailed {
  readonly status: "failed";
  readonly intentHash: string;
  readonly errorCode: string;
}

export interface StoredReceiptIndeterminate {
  readonly status: "indeterminate";
  readonly intentHash: string;
  readonly recordedAt: IsoTimestamp;
}

export type StoredReceipt =
  | StoredReceiptPending
  | StoredReceiptApplied
  | StoredReceiptFailed
  | StoredReceiptIndeterminate;

export interface StoredProposal {
  readonly proposalId: string;
  readonly revision: number;
  readonly issuer: string;
  readonly principalId: string;
  readonly instanceUrl: string;
  readonly bugId: BugId;
  readonly baseVersion: IsoTimestamp;
  readonly diff: ProposalDiff;
  readonly rationale: string;
  readonly state: ProposalState;
}

export const VALID_PROPOSAL_TRANSITIONS: Readonly<Record<ProposalState, readonly ProposalState[]>> =
  {
    pending: ["executing", "approved", "rejected", "stale"],
    approved: ["executing", "pending", "rejected", "stale", "applied", "indeterminate"],
    executing: ["pending", "stale", "applied", "indeterminate"],
    rejected: [],
    applied: [],
    stale: [],
    indeterminate: [],
  };

export function isValidProposalTransition(from: ProposalState, to: ProposalState): boolean {
  return VALID_PROPOSAL_TRANSITIONS[from].includes(to);
}

export interface StoredDraft {
  readonly bugId: BugId;
  readonly draftKind: DraftKind;
  readonly draftRevision: number;
  readonly content: string;
  readonly savedAt: IsoTimestamp;
}

export interface SelfWriteProvenance {
  readonly issuer?: string;
  readonly principalId?: string;
  readonly instanceUrl: string;
  readonly bugId: BugId;
  readonly commentId?: number;
  readonly diffKey?: string;
}

export interface WriteAuditEntry {
  readonly auditId: string;
  readonly issuer: string;
  readonly principalId: string;
  readonly instanceUrl: string;
  readonly bugId: BugId;
  readonly proposalId?: string;
  readonly revision?: number;
  readonly expectedLastChangeTime: IsoTimestamp;
  readonly updatedLastChangeTime: IsoTimestamp;
  readonly diff: ProposalDiff;
  readonly recordedAt: IsoTimestamp;
}

export interface StoredWebhookSubscription {
  readonly id: string;
  readonly issuer: string;
  readonly principalId: string;
  readonly instanceUrl: string;
  readonly name: EventName;
  readonly canonicalArgsJson: string;
  readonly args: EventFilterArgs;
  readonly url: string;
  readonly secret: string;
  readonly previousSecret?: string;
  readonly secretRotatedAt?: IsoTimestamp;
  readonly refreshBefore: IsoTimestamp | null;
  readonly verified: boolean;
  readonly safeWatermark: string | null;
  readonly gapPending: boolean;
  readonly grant?: PrincipalContext;
  readonly acquisitionCursor?: string;
  readonly recoveryCursor?: string;
  readonly lastGapCursor?: string;
  readonly gapMessageId?: string;
  readonly gapAttempt?: { cursor: string; attempts: number; nextAttemptAtMs: number };
  readonly revoked?: boolean;
}

export interface StoredBindingTicket {
  readonly ticketId: string;
  readonly issuer: string;
  readonly principalId: string;
  readonly clientId: string;
  readonly instanceUrl: string;
  readonly toolName: string;
  readonly paramsHash: string;
  readonly expiresAtMs: number;
  readonly csrfToken: string;
  readonly completed: boolean;
  readonly credentialGeneration?: number;
}

export interface StoredBoundCredential {
  readonly issuer: string;
  readonly principalId: string;
  readonly instanceUrl: string;
  readonly ciphertext: string;
  readonly iv: string;
  readonly authTag: string;
  readonly credentialGeneration: number;
  readonly updatedAt: IsoTimestamp;
}

export interface StoredApprovalTicket {
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
  readonly consumed: boolean;
}

export interface StoredWebhookRetryItem {
  readonly subscriptionId: string;
  readonly eventId: string;
  readonly payloadJson: string;
  readonly attempts: number;
  readonly nextAttemptAtMs: number;
}

export interface ReservePendingOptions {
  readonly nowMs?: number;
  readonly leaseMs?: number;
}

export type ReservePendingResult =
  | { readonly kind: "reserved"; readonly leaseToken: string }
  | { readonly kind: "existing"; readonly receipt: StoredReceipt };

export interface MarkDispatchStartedOptions {
  readonly nowMs?: number;
}

export interface FinalizeReceiptOptions {
  readonly expectedLeaseToken?: string;
}

export interface TransitionProposalCasParams {
  readonly issuer: string;
  readonly principalId: string;
  readonly instanceUrl: string;
  readonly proposalId: string;
  readonly revision: number;
  readonly fromStates: readonly ProposalState[];
  readonly toState: ProposalState;
}

export interface ClaimProposalTransitionParams {
  readonly issuer: string;
  readonly principalId: string;
  readonly instanceUrl: string;
  readonly proposalId: string;
  readonly revision: number;
  readonly fromState: ProposalState;
  readonly toState: ProposalState;
}

export interface CommitAppliedMutationProposal {
  readonly issuer?: string;
  readonly principalId?: string;
  readonly instanceUrl?: string;
  readonly proposalId: string;
  readonly revision: number;
  readonly fromStates?: readonly ProposalState[];
}

export interface CommitAppliedMutationParams {
  readonly scope: IdempotencyScope;
  readonly leaseToken: string;
  readonly intentHash: string;
  readonly artifactId: string;
  readonly proposal?: CommitAppliedMutationProposal;
  readonly writeAudit?: WriteAuditEntry;
  readonly selfWrite?: SelfWriteProvenance;
}

export type CommitAppliedMutationResult =
  | { readonly committed: true }
  | { readonly committed: false; readonly reason: "lease_fenced" | "proposal_conflict" };

export interface ConsumeCausalBudgetParams {
  readonly issuer: string;
  readonly principalId: string;
  readonly instanceUrl: string;
  readonly bugId: BugId;
  readonly maxWrites: number;
  readonly windowMs: number;
  readonly nowMs: number;
}

export interface ConsumeCausalBudgetResult {
  readonly allowed: boolean;
  readonly tokenId?: number;
  readonly retryAfterMs?: number;
}

export interface RefundCausalBudgetParams {
  readonly issuer: string;
  readonly principalId: string;
  readonly instanceUrl: string;
  readonly bugId: BugId;
  readonly tokenId: number;
}

export interface SaveDraftParams {
  readonly issuer: string;
  readonly principalId: string;
  readonly instanceUrl: string;
  readonly bugId: BugId;
  readonly draftKind: DraftKind;
  readonly draftRevision: number;
  readonly content: string;
}

export interface GetDraftParams {
  readonly issuer: string;
  readonly principalId: string;
  readonly instanceUrl: string;
  readonly bugId: BugId;
  readonly draftKind: DraftKind;
}

export interface WebhookSubscriptionLookupParams {
  readonly issuer: string;
  readonly principalId: string;
  readonly instanceUrl: string;
  readonly url: string;
  readonly name: EventName;
  readonly canonicalArgsJson: string;
}

export interface ListProposalsFilter {
  readonly bugId?: BugId;
  readonly state?: ProposalState;
}

export interface StoragePorts {
  readonly durableWebhooks?: boolean;
  listWebhookGrants(): Promise<PrincipalContext[]>;
  getReceipt(scope: IdempotencyScope): Promise<StoredReceipt | null>;
  reservePending(
    scope: IdempotencyScope,
    intentHash: string,
    opts?: ReservePendingOptions,
  ): Promise<ReservePendingResult>;
  markDispatchStarted(
    scope: IdempotencyScope,
    leaseToken: string,
    opts?: MarkDispatchStartedOptions,
  ): Promise<boolean>;
  finalizeReceipt(
    scope: IdempotencyScope,
    receipt: StoredReceipt,
    opts?: FinalizeReceiptOptions,
  ): Promise<boolean>;
  commitAppliedMutation(params: CommitAppliedMutationParams): Promise<CommitAppliedMutationResult>;
  recordSelfWrite(entry: SelfWriteProvenance): Promise<void>;
  hasSelfWrite(entry: SelfWriteProvenance): Promise<boolean>;
  recordWriteAudit(entry: WriteAuditEntry): Promise<void>;
  listWriteAudits(
    issuer: string,
    principalId: string,
    instanceUrl: string,
    bugId: BugId,
  ): Promise<WriteAuditEntry[]>;
  consumeCausalBudget(params: ConsumeCausalBudgetParams): Promise<ConsumeCausalBudgetResult>;
  refundCausalBudget(params: RefundCausalBudgetParams): Promise<void>;
  saveInternalNote(
    issuer: string,
    principalId: string,
    instanceUrl: string,
    bugId: BugId,
    text: string,
  ): Promise<InternalNote>;
  listInternalNotes(
    issuer: string,
    principalId: string,
    instanceUrl: string,
    bugId: BugId,
  ): Promise<InternalNote[]>;
  saveProposal(proposal: StoredProposal): Promise<void>;
  getProposal(
    issuer: string,
    principalId: string,
    instanceUrl: string,
    proposalId: string,
    revision: number,
  ): Promise<StoredProposal | null>;
  listProposals(
    issuer: string,
    principalId: string,
    instanceUrl: string,
    filter?: ListProposalsFilter,
  ): Promise<StoredProposal[]>;
  transitionProposalCas(params: TransitionProposalCasParams): Promise<boolean>;
  claimProposalTransition?(params: ClaimProposalTransitionParams): Promise<boolean>;
  saveDraft(params: SaveDraftParams): Promise<DraftSaveResult>;
  getDraft(params: GetDraftParams): Promise<StoredDraft | null>;
  upsertWebhookSubscription(sub: StoredWebhookSubscription): Promise<void>;
  getWebhookSubscription(
    params: WebhookSubscriptionLookupParams,
  ): Promise<StoredWebhookSubscription | null>;
  listWebhookSubscriptions(scope: TenantScope): Promise<StoredWebhookSubscription[]>;
  deleteWebhookSubscription(params: WebhookSubscriptionLookupParams): Promise<boolean>;
  consumeApprovalJti(jti: string, expiresAtMs: number, nowMs?: number): Promise<boolean>;
  saveBindingTicket(ticket: StoredBindingTicket): Promise<void>;
  getBindingTicket(ticketId: string): Promise<StoredBindingTicket | null>;
  markBindingTicketCompleted(
    ticketId: string,
    credentialGeneration: number,
    nowMs?: number,
  ): Promise<boolean>;
  consumeRetryState(stateHash: string, expiresAtMs: number, nowMs?: number): Promise<boolean>;
  saveApprovalTicket(ticket: StoredApprovalTicket): Promise<void>;
  getApprovalTicket(ticketId: string): Promise<StoredApprovalTicket | null>;
  consumeApprovalTicket(ticketId: string, nowMs: number): Promise<boolean>;
  saveBoundCredential(
    entry: Omit<StoredBoundCredential, "credentialGeneration" | "updatedAt">,
  ): Promise<{ readonly credentialGeneration: number }>;
  getBoundCredential(
    issuer: string,
    principalId: string,
    instanceUrl: string,
  ): Promise<StoredBoundCredential | null>;
  revokeBoundCredential(issuer: string, principalId: string, instanceUrl: string): Promise<boolean>;
  upsertWebhookRetryItem(item: StoredWebhookRetryItem): Promise<void>;
  listWebhookRetryItems(subscriptionId?: string): Promise<StoredWebhookRetryItem[]>;
  deleteWebhookRetryItem(subscriptionId: string, eventId: string): Promise<void>;
}

export interface StorageEffectPorts {
  readonly durableWebhooks: boolean;
  listWebhookGrants(): Effect.Effect<PrincipalContext[], StorageError>;
  getReceipt(scope: IdempotencyScope): Effect.Effect<StoredReceipt | null, StorageError>;
  reservePending(
    scope: IdempotencyScope,
    intentHash: string,
    opts?: ReservePendingOptions,
  ): Effect.Effect<ReservePendingResult, StorageError>;
  markDispatchStarted(
    scope: IdempotencyScope,
    leaseToken: string,
    opts?: MarkDispatchStartedOptions,
  ): Effect.Effect<boolean, StorageError>;
  finalizeReceipt(
    scope: IdempotencyScope,
    receipt: StoredReceipt,
    opts?: FinalizeReceiptOptions,
  ): Effect.Effect<boolean, StorageError>;
  commitAppliedMutation(
    params: CommitAppliedMutationParams,
  ): Effect.Effect<CommitAppliedMutationResult, StorageError>;
  recordSelfWrite(entry: SelfWriteProvenance): Effect.Effect<void, StorageError>;
  hasSelfWrite(entry: SelfWriteProvenance): Effect.Effect<boolean, StorageError>;
  recordWriteAudit(entry: WriteAuditEntry): Effect.Effect<void, StorageError>;
  listWriteAudits(
    issuer: string,
    principalId: string,
    instanceUrl: string,
    bugId: BugId,
  ): Effect.Effect<WriteAuditEntry[], StorageError>;
  consumeCausalBudget(
    params: ConsumeCausalBudgetParams,
  ): Effect.Effect<ConsumeCausalBudgetResult, StorageError>;
  refundCausalBudget(params: RefundCausalBudgetParams): Effect.Effect<void, StorageError>;
  saveInternalNote(
    issuer: string,
    principalId: string,
    instanceUrl: string,
    bugId: BugId,
    text: string,
  ): Effect.Effect<InternalNote, StorageError>;
  listInternalNotes(
    issuer: string,
    principalId: string,
    instanceUrl: string,
    bugId: BugId,
  ): Effect.Effect<InternalNote[], StorageError>;
  saveProposal(proposal: StoredProposal): Effect.Effect<void, StorageError>;
  getProposal(
    issuer: string,
    principalId: string,
    instanceUrl: string,
    proposalId: string,
    revision: number,
  ): Effect.Effect<StoredProposal | null, StorageError>;
  listProposals(
    issuer: string,
    principalId: string,
    instanceUrl: string,
    filter?: ListProposalsFilter,
  ): Effect.Effect<StoredProposal[], StorageError>;
  transitionProposalCas(params: TransitionProposalCasParams): Effect.Effect<boolean, StorageError>;
  saveDraft(params: SaveDraftParams): Effect.Effect<DraftSaveResult, StorageError>;
  getDraft(params: GetDraftParams): Effect.Effect<StoredDraft | null, StorageError>;
  upsertWebhookSubscription(sub: StoredWebhookSubscription): Effect.Effect<void, StorageError>;
  getWebhookSubscription(
    params: WebhookSubscriptionLookupParams,
  ): Effect.Effect<StoredWebhookSubscription | null, StorageError>;
  listWebhookSubscriptions(
    scope: TenantScope,
  ): Effect.Effect<StoredWebhookSubscription[], StorageError>;
  deleteWebhookSubscription(
    params: WebhookSubscriptionLookupParams,
  ): Effect.Effect<boolean, StorageError>;
  consumeApprovalJti(
    jti: string,
    expiresAtMs: number,
    nowMs?: number,
  ): Effect.Effect<boolean, StorageError>;
  saveBindingTicket(ticket: StoredBindingTicket): Effect.Effect<void, StorageError>;
  getBindingTicket(ticketId: string): Effect.Effect<StoredBindingTicket | null, StorageError>;
  markBindingTicketCompleted(
    ticketId: string,
    credentialGeneration: number,
    nowMs?: number,
  ): Effect.Effect<boolean, StorageError>;
  consumeRetryState(
    stateHash: string,
    expiresAtMs: number,
    nowMs?: number,
  ): Effect.Effect<boolean, StorageError>;
  saveApprovalTicket(ticket: StoredApprovalTicket): Effect.Effect<void, StorageError>;
  getApprovalTicket(ticketId: string): Effect.Effect<StoredApprovalTicket | null, StorageError>;
  consumeApprovalTicket(ticketId: string, nowMs: number): Effect.Effect<boolean, StorageError>;
  saveBoundCredential(
    entry: Omit<StoredBoundCredential, "credentialGeneration" | "updatedAt">,
  ): Effect.Effect<{ readonly credentialGeneration: number }, StorageError>;
  getBoundCredential(
    issuer: string,
    principalId: string,
    instanceUrl: string,
  ): Effect.Effect<StoredBoundCredential | null, StorageError>;
  revokeBoundCredential(
    issuer: string,
    principalId: string,
    instanceUrl: string,
  ): Effect.Effect<boolean, StorageError>;
  upsertWebhookRetryItem(item: StoredWebhookRetryItem): Effect.Effect<void, StorageError>;
  listWebhookRetryItems(
    subscriptionId?: string,
  ): Effect.Effect<StoredWebhookRetryItem[], StorageError>;
  deleteWebhookRetryItem(
    subscriptionId: string,
    eventId: string,
  ): Effect.Effect<void, StorageError>;
}

export class StorageService extends Context.Service<StorageService, StorageEffectPorts>()(
  "StorageService",
) {}

function toStorageError(operation: string, cause: unknown): StorageError {
  if (cause instanceof StorageError) {
    return cause;
  }
  return new StorageError({
    operation,
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });
}

function wrapPort<A>(operation: string, run: () => Promise<A>): Effect.Effect<A, StorageError> {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => toStorageError(operation, cause),
  });
}

export function toEffectStorage(ports: StoragePorts): StorageEffectPorts {
  return StorageService.of({
    durableWebhooks: ports.durableWebhooks ?? false,
    listWebhookGrants: () => wrapPort("listWebhookGrants", () => ports.listWebhookGrants()),
    getReceipt: (scope) => wrapPort("getReceipt", () => ports.getReceipt(scope)),
    reservePending: (scope, intentHash, opts) =>
      wrapPort("reservePending", () => ports.reservePending(scope, intentHash, opts)),
    markDispatchStarted: (scope, leaseToken, opts) =>
      wrapPort("markDispatchStarted", () => ports.markDispatchStarted(scope, leaseToken, opts)),
    finalizeReceipt: (scope, receipt, opts) =>
      wrapPort("finalizeReceipt", () => ports.finalizeReceipt(scope, receipt, opts)),
    commitAppliedMutation: (params) =>
      wrapPort("commitAppliedMutation", () => ports.commitAppliedMutation(params)),
    recordSelfWrite: (entry) => wrapPort("recordSelfWrite", () => ports.recordSelfWrite(entry)),
    hasSelfWrite: (entry) => wrapPort("hasSelfWrite", () => ports.hasSelfWrite(entry)),
    recordWriteAudit: (entry) => wrapPort("recordWriteAudit", () => ports.recordWriteAudit(entry)),
    listWriteAudits: (issuer, principalId, instanceUrl, bugId) =>
      wrapPort("listWriteAudits", () =>
        ports.listWriteAudits(issuer, principalId, instanceUrl, bugId),
      ),
    consumeCausalBudget: (params) =>
      wrapPort("consumeCausalBudget", () => ports.consumeCausalBudget(params)),
    refundCausalBudget: (params) =>
      wrapPort("refundCausalBudget", () => ports.refundCausalBudget(params)),
    saveInternalNote: (issuer, principalId, instanceUrl, bugId, text) =>
      wrapPort("saveInternalNote", () =>
        ports.saveInternalNote(issuer, principalId, instanceUrl, bugId, text),
      ),
    listInternalNotes: (issuer, principalId, instanceUrl, bugId) =>
      wrapPort("listInternalNotes", () =>
        ports.listInternalNotes(issuer, principalId, instanceUrl, bugId),
      ),
    saveProposal: (proposal) => wrapPort("saveProposal", () => ports.saveProposal(proposal)),
    getProposal: (issuer, principalId, instanceUrl, proposalId, revision) =>
      wrapPort("getProposal", () =>
        ports.getProposal(issuer, principalId, instanceUrl, proposalId, revision),
      ),
    listProposals: (issuer, principalId, instanceUrl, filter) =>
      wrapPort("listProposals", () =>
        ports.listProposals(issuer, principalId, instanceUrl, filter),
      ),
    transitionProposalCas: (params) =>
      wrapPort("transitionProposalCas", () => ports.transitionProposalCas(params)),
    saveDraft: (params) => wrapPort("saveDraft", () => ports.saveDraft(params)),
    getDraft: (params) => wrapPort("getDraft", () => ports.getDraft(params)),
    upsertWebhookSubscription: (sub) =>
      wrapPort("upsertWebhookSubscription", () => ports.upsertWebhookSubscription(sub)),
    getWebhookSubscription: (params) =>
      wrapPort("getWebhookSubscription", () => ports.getWebhookSubscription(params)),
    listWebhookSubscriptions: (scope) =>
      wrapPort("listWebhookSubscriptions", () => ports.listWebhookSubscriptions(scope)),
    deleteWebhookSubscription: (params) =>
      wrapPort("deleteWebhookSubscription", () => ports.deleteWebhookSubscription(params)),
    consumeApprovalJti: (jti, expiresAtMs, nowMs) =>
      wrapPort("consumeApprovalJti", () => ports.consumeApprovalJti(jti, expiresAtMs, nowMs)),
    saveBindingTicket: (ticket) =>
      wrapPort("saveBindingTicket", () => ports.saveBindingTicket(ticket)),
    getBindingTicket: (ticketId) =>
      wrapPort("getBindingTicket", () => ports.getBindingTicket(ticketId)),
    markBindingTicketCompleted: (ticketId, credentialGeneration, nowMs) =>
      wrapPort("markBindingTicketCompleted", () =>
        ports.markBindingTicketCompleted(ticketId, credentialGeneration, nowMs),
      ),
    consumeRetryState: (stateHash, expiresAtMs, nowMs) =>
      wrapPort("consumeRetryState", () => ports.consumeRetryState(stateHash, expiresAtMs, nowMs)),
    saveApprovalTicket: (ticket) =>
      wrapPort("saveApprovalTicket", () => ports.saveApprovalTicket(ticket)),
    getApprovalTicket: (ticketId) =>
      wrapPort("getApprovalTicket", () => ports.getApprovalTicket(ticketId)),
    consumeApprovalTicket: (ticketId, nowMs) =>
      wrapPort("consumeApprovalTicket", () => ports.consumeApprovalTicket(ticketId, nowMs)),
    saveBoundCredential: (entry) =>
      wrapPort("saveBoundCredential", () => ports.saveBoundCredential(entry)),
    getBoundCredential: (issuer, principalId, instanceUrl) =>
      wrapPort("getBoundCredential", () =>
        ports.getBoundCredential(issuer, principalId, instanceUrl),
      ),
    revokeBoundCredential: (issuer, principalId, instanceUrl) =>
      wrapPort("revokeBoundCredential", () =>
        ports.revokeBoundCredential(issuer, principalId, instanceUrl),
      ),
    upsertWebhookRetryItem: (item) =>
      wrapPort("upsertWebhookRetryItem", () => ports.upsertWebhookRetryItem(item)),
    listWebhookRetryItems: (subscriptionId) =>
      wrapPort("listWebhookRetryItems", () => ports.listWebhookRetryItems(subscriptionId)),
    deleteWebhookRetryItem: (subscriptionId, eventId) =>
      wrapPort("deleteWebhookRetryItem", () =>
        ports.deleteWebhookRetryItem(subscriptionId, eventId),
      ),
  });
}

export function makeStorageLayer(ports: StoragePorts): Layer.Layer<StorageService> {
  return Layer.succeed(StorageService, toEffectStorage(ports));
}

import { openSqliteStorage, withTransaction } from "./sqlite.js";

export { withTransaction };

export function createSqliteStorage(dbPath: string): StoragePorts {
  return openSqliteStorage(dbPath);
}

export function createSqliteStorageLayer(
  dbPath: string,
): Layer.Layer<StorageService, StorageError> {
  return Layer.effect(
    StorageService,
    Effect.try({
      try: () => toEffectStorage(openSqliteStorage(dbPath)),
      catch: (cause) => toStorageError("openSqliteStorage", cause),
    }),
  );
}
