import type {
  AttachmentMeta,
  BugDossier,
  BugId,
  BugSummary,
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
}

export function createBugzillaClient(_config: BugzillaClientConfig): BugzillaClient {
  throw new Error("C0_CONTRACT_STUB");
}
