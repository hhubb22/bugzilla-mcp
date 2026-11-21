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
}

export function createSqliteStorage(_dbPath: string): StoragePorts {
  throw new Error("C0_CONTRACT_STUB");
}
