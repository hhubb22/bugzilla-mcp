import type {
  BugId,
  DraftKind,
  DraftSaveResult,
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

export interface StoragePorts {
  getReceipt(scope: IdempotencyScope): Promise<StoredReceipt | null>;
  reservePending(scope: IdempotencyScope, intentHash: string): Promise<"reserved" | StoredReceipt>;
  finalizeReceipt(scope: IdempotencyScope, receipt: StoredReceipt): Promise<void>;
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
}

export function createSqliteStorage(_dbPath: string): StoragePorts {
  throw new Error("C0_CONTRACT_STUB");
}
