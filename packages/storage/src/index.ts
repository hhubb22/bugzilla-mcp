import type {
  BugId,
  DraftKind,
  DraftSaveResult,
  EventFilterArgs,
  EventName,
  IdempotencyKey,
  InternalNote,
  IsoTimestamp,
  ProposalDiff,
} from "@bugzilla-mcp/contracts";

export interface IdempotencyScope {
  readonly principalId: string;
  readonly instanceUrl: string;
  readonly operation: string;
  readonly key: IdempotencyKey;
}

export type StoredReceipt =
  | { readonly status: "pending"; readonly intentHash: string; readonly createdAt: IsoTimestamp }
  | { readonly status: "applied"; readonly intentHash: string; readonly artifactId: string }
  | { readonly status: "failed"; readonly intentHash: string; readonly errorCode: string }
  | {
      readonly status: "indeterminate";
      readonly intentHash: string;
      readonly recordedAt: IsoTimestamp;
    };

export interface StoredProposal {
  readonly proposalId: string;
  readonly revision: number;
  readonly principalId: string;
  readonly instanceUrl: string;
  readonly bugId: BugId;
  readonly baseVersion: IsoTimestamp;
  readonly diff: ProposalDiff;
  readonly rationale: string;
  readonly state: "pending" | "approved" | "rejected" | "applied" | "stale" | "indeterminate";
}

export interface StoredDraft {
  readonly bugId: BugId;
  readonly draftKind: DraftKind;
  readonly draftRevision: number;
  readonly content: string;
  readonly savedAt: IsoTimestamp;
}

export interface SelfWriteProvenance {
  readonly instanceUrl: string;
  readonly bugId: BugId;
  readonly commentId?: number;
  readonly diffKey?: string;
}

export interface WriteAuditEntry {
  readonly auditId: string;
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

export interface StoragePorts {
  getReceipt(scope: IdempotencyScope): Promise<StoredReceipt | null>;
  reservePending(scope: IdempotencyScope, intentHash: string): Promise<"reserved" | StoredReceipt>;
  finalizeReceipt(scope: IdempotencyScope, receipt: StoredReceipt): Promise<void>;
  recordSelfWrite(entry: SelfWriteProvenance): Promise<void>;
  hasSelfWrite(entry: SelfWriteProvenance): Promise<boolean>;
  recordWriteAudit(entry: WriteAuditEntry): Promise<void>;
  listWriteAudits(
    principalId: string,
    instanceUrl: string,
    bugId: BugId,
  ): Promise<WriteAuditEntry[]>;
  consumeCausalBudget(params: {
    instanceUrl: string;
    bugId: BugId;
    maxWrites: number;
    windowMs: number;
    nowMs: number;
  }): Promise<{ allowed: boolean; retryAfterMs?: number }>;
  saveInternalNote(
    principalId: string,
    instanceUrl: string,
    bugId: BugId,
    text: string,
  ): Promise<InternalNote>;
  listInternalNotes(
    principalId: string,
    instanceUrl: string,
    bugId: BugId,
  ): Promise<InternalNote[]>;
  saveProposal(proposal: StoredProposal): Promise<void>;
  getProposal(
    principalId: string,
    instanceUrl: string,
    proposalId: string,
    revision: number,
  ): Promise<StoredProposal | null>;
  saveDraft(params: {
    principalId: string;
    instanceUrl: string;
    bugId: BugId;
    draftKind: DraftKind;
    draftRevision: number;
    content: string;
  }): Promise<DraftSaveResult>;
  getDraft(params: {
    principalId: string;
    instanceUrl: string;
    bugId: BugId;
    draftKind: DraftKind;
  }): Promise<StoredDraft | null>;
  upsertWebhookSubscription(sub: StoredWebhookSubscription): Promise<void>;
  getWebhookSubscription(params: {
    principalId: string;
    url: string;
    name: EventName;
    canonicalArgsJson: string;
  }): Promise<StoredWebhookSubscription | null>;
  listWebhookSubscriptions(principalId?: string): Promise<StoredWebhookSubscription[]>;
  deleteWebhookSubscription(params: {
    principalId: string;
    url: string;
    name: EventName;
    canonicalArgsJson: string;
  }): Promise<boolean>;

  // Additive Slice-2 durable persistence hooks (optional for minimal in-memory test doubles)
  listProposals?(
    principalId: string,
    instanceUrl: string,
    filter?: { bugId?: BugId; state?: StoredProposal["state"] },
  ): Promise<StoredProposal[]>;
  claimProposalTransition?(params: {
    principalId: string;
    instanceUrl: string;
    proposalId: string;
    revision: number;
    fromState: StoredProposal["state"];
    toState: StoredProposal["state"];
  }): Promise<boolean>;
  consumeApprovalJti?(jti: string, expiresAtMs: number, nowMs?: number): Promise<boolean>;
  saveBindingTicket?(ticket: StoredBindingTicket): Promise<void>;
  getBindingTicket?(ticketId: string): Promise<StoredBindingTicket | null>;
  markBindingTicketCompleted?(
    ticketId: string,
    credentialGeneration: number,
    nowMs?: number,
  ): Promise<boolean>;
  consumeRetryState?(stateHash: string, expiresAtMs: number, nowMs?: number): Promise<boolean>;
  saveApprovalTicket?(ticket: StoredApprovalTicket): Promise<void>;
  getApprovalTicket?(ticketId: string): Promise<StoredApprovalTicket | null>;
  consumeApprovalTicket?(ticketId: string, nowMs: number): Promise<boolean>;
  saveBoundCredential?(
    entry: Omit<StoredBoundCredential, "credentialGeneration" | "updatedAt">,
  ): Promise<{ credentialGeneration: number }>;
  getBoundCredential?(
    issuer: string,
    principalId: string,
    instanceUrl: string,
  ): Promise<StoredBoundCredential | null>;
  revokeBoundCredential?(
    issuer: string,
    principalId: string,
    instanceUrl: string,
  ): Promise<boolean>;
  upsertWebhookRetryItem?(item: StoredWebhookRetryItem): Promise<void>;
  listWebhookRetryItems?(subscriptionId?: string): Promise<StoredWebhookRetryItem[]>;
  deleteWebhookRetryItem?(subscriptionId: string, eventId: string): Promise<void>;
}

import { openSqliteStorage } from "./sqlite.js";

export function createSqliteStorage(dbPath: string): StoragePorts {
  return openSqliteStorage(dbPath);
}
