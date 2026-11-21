import type {
  AttachmentMeta,
  BugDossier,
  BugId,
  BugSummary,
  BugzillaCreateBugInput,
  EventName,
  IsoTimestamp,
  ProposalDiff,
} from "@bugzilla-mcp/contracts";

export interface BugzillaClientConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly allowQueryFallback?: boolean;
}

export interface BugzillaInstanceCapabilities {
  readonly version: string;
  readonly supportsHeaderAuth: boolean;
  readonly authenticatedUser: string;
  readonly isInsider: boolean;
}

export interface UpstreamBugzillaOccurrence {
  readonly kind: EventName;
  readonly bugId: BugId;
  readonly commentId?: number;
  readonly changeKey: string;
  readonly timestamp: IsoTimestamp;
  readonly product: string;
  readonly component: string;
  readonly actor: string;
  readonly fieldsChanged?: readonly string[];
  readonly summaryText?: string;
  readonly commentText?: string;
}

export interface BugzillaClient {
  probeCapabilities(): Promise<BugzillaInstanceCapabilities>;
  searchBugs(params: {
    product?: string;
    component?: string;
    status?: string[];
    assignedTo?: string;
    updatedSince?: IsoTimestamp;
    query?: string;
    limit: number;
    offset: number;
  }): Promise<{ items: BugSummary[]; hasMore: boolean }>;
  getBugDossierData(
    bugId: BugId,
    opts: { maxComments: number; maxHistory: number },
  ): Promise<Omit<BugDossier, "internalNotes"> | null>;
  listAttachments(bugId: BugId): Promise<AttachmentMeta[]>;
  postPrivateComment(
    bugId: BugId,
    text: string,
  ): Promise<{ kind: "created"; commentId: number } | { kind: "private_rejected" }>;
  applyBugUpdate(
    bugId: BugId,
    diff: ProposalDiff,
  ): Promise<{ updatedLastChangeTime: IsoTimestamp; commentId?: number }>;
  createBug(input: Omit<BugzillaCreateBugInput, "idempotencyKey">): Promise<{ bugId: BugId }>;
  listChangesSince(params: {
    since: IsoTimestamp;
    limit: number;
    offset: number;
  }): Promise<{ occurrences: readonly UpstreamBugzillaOccurrence[]; scanComplete: boolean }>;
  checkVisibility(
    bugId: BugId,
    commentId?: number,
  ): Promise<"visible" | "restricted_or_missing" | "credential_revoked">;
}

export function createBugzillaClient(_config: BugzillaClientConfig): BugzillaClient {
  throw new Error("C0_CONTRACT_STUB");
}
