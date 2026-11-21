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

export class BugzillaCredentialRevokedError extends Error {
  constructor(message = "Bugzilla API key invalid or revoked") {
    super(message);
    this.name = "BugzillaCredentialRevokedError";
  }
}

export class BugzillaAccessDeniedError extends Error {
  constructor(message = "Bugzilla resource not found or inaccessible") {
    super(message);
    this.name = "BugzillaAccessDeniedError";
  }
}

export class BugzillaUnsupportedAttachmentError extends Error {
  constructor(message = "Attachment is non-text or exceeds safe excerpt size limit") {
    super(message);
    this.name = "BugzillaUnsupportedAttachmentError";
  }
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
  readonly requestee?: string;
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
  getAttachmentExcerpt?(params: {
    attachmentId: number;
    byteOffset: number;
    maxBytes: number;
  }): Promise<{
    attachmentId: number;
    bugId: BugId;
    fileName: string;
    contentType: string;
    totalBytes: number;
    byteOffset: number;
    excerptText: string;
    truncated: boolean;
    isPrivate: boolean;
  } | null>;
  postPrivateComment(
    bugId: BugId,
    text: string,
  ): Promise<{ kind: "created"; commentId: number } | { kind: "private_rejected" }>;
  applyBugUpdate(
    bugId: BugId,
    diff: ProposalDiff,
  ): Promise<{ updatedLastChangeTime: IsoTimestamp; commentId?: number }>;
  createBug(input: Omit<BugzillaCreateBugInput, "idempotencyKey">): Promise<{ bugId: BugId }>;
  listChangesSince(params: { since: IsoTimestamp; limit: number; offset: number }): Promise<{
    occurrences: readonly UpstreamBugzillaOccurrence[];
    scanComplete: boolean;
    nextOffset?: number;
  }>;
  checkVisibility(
    bugId: BugId,
    commentId?: number,
  ): Promise<"visible" | "restricted_or_missing" | "credential_revoked">;
}

import { createRestBugzillaClient } from "./rest-client.js";

export function createBugzillaClient(config: BugzillaClientConfig): BugzillaClient {
  return createRestBugzillaClient(config);
}
