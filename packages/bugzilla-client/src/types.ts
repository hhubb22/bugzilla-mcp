import type {
  AttachmentMeta,
  BugDossier,
  BugId,
  BugSummary,
  BugzillaCreateBugInput,
  EventName,
  FieldMetadata,
  IsoTimestamp,
  ProductMetadata,
  ProposalDiff,
} from "@bugzilla-mcp/contracts";
import type { Effect } from "effect";
import type { BugzillaClientError } from "./errors.js";

export type BugzillaAuthMode = "header" | "query_fallback";

export interface BugzillaClientConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly allowQueryFallback?: boolean;
  readonly insiderGroupNames?: readonly string[];
  readonly requestTimeoutMs?: number;
  readonly maxGetRetries?: number;
  readonly retryBaseDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly fetchImpl?: typeof fetch;
}

export interface BugzillaInstanceCapabilities {
  readonly version: string;
  readonly supportsHeaderAuth: boolean;
  readonly authMode: BugzillaAuthMode;
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
  readonly severity?: string;
  readonly confirmedHistoryKey?: string;
  readonly requestee?: string;
  readonly fieldsChanged?: readonly string[];
  readonly summaryText?: string;
  readonly commentText?: string;
}

export interface BugzillaSearchParams {
  readonly product?: string;
  readonly component?: string;
  readonly status?: readonly string[];
  readonly assignedTo?: string;
  readonly updatedSince?: IsoTimestamp;
  readonly query?: string;
  readonly limit: number;
  readonly offset: number;
}

export interface BugzillaSearchResult {
  readonly items: BugSummary[];
  readonly hasMore: boolean;
}

export interface AttachmentExcerptResult {
  readonly attachmentId: number;
  readonly bugId: BugId;
  readonly fileName: string;
  readonly contentType: string;
  readonly totalBytes: number;
  readonly byteOffset: number;
  readonly excerptText: string;
  readonly truncated: boolean;
  readonly isPrivate: boolean;
}

export type PostPrivateCommentResult =
  | { readonly kind: "created"; readonly commentId: number }
  | { readonly kind: "private_rejected" };

export interface PostPublicCommentResult {
  readonly commentId: number;
  readonly updatedLastChangeTime?: IsoTimestamp;
}

export interface ApplyBugUpdateResult {
  readonly updatedLastChangeTime?: IsoTimestamp;
  readonly commentId?: number;
  readonly confirmedHistoryKey?: string;
  readonly metadataDegraded?: boolean;
}

export interface ListChangesSinceResult {
  readonly occurrences: readonly UpstreamBugzillaOccurrence[];
  readonly scanComplete: boolean;
  readonly nextOffset?: number;
}

export type VisibilityStatus = "visible" | "restricted_or_missing" | "credential_revoked";

export interface EnterableProductSummary {
  readonly id?: number;
  readonly name: string;
  readonly isActive: boolean;
}

export interface BugzillaClientEffect {
  probeCapabilities(): Effect.Effect<BugzillaInstanceCapabilities, BugzillaClientError>;
  searchBugs(
    params: BugzillaSearchParams,
  ): Effect.Effect<BugzillaSearchResult, BugzillaClientError>;
  getBugDossierData(
    bugId: BugId,
    opts: { readonly maxComments: number; readonly maxHistory: number },
  ): Effect.Effect<Omit<BugDossier, "internalNotes"> | null, BugzillaClientError>;
  listAttachments(bugId: BugId): Effect.Effect<AttachmentMeta[] | null, BugzillaClientError>;
  getAttachmentExcerpt(params: {
    readonly attachmentId: number;
    readonly byteOffset: number;
    readonly maxBytes: number;
  }): Effect.Effect<AttachmentExcerptResult | null, BugzillaClientError>;
  postPrivateComment(
    bugId: BugId,
    text: string,
  ): Effect.Effect<PostPrivateCommentResult, BugzillaClientError>;
  postPublicComment(
    bugId: BugId,
    text: string,
  ): Effect.Effect<PostPublicCommentResult, BugzillaClientError>;
  applyBugUpdate(
    bugId: BugId,
    diff: ProposalDiff,
  ): Effect.Effect<ApplyBugUpdateResult, BugzillaClientError>;
  createBug(
    input: Omit<BugzillaCreateBugInput, "idempotencyKey">,
  ): Effect.Effect<{ readonly bugId: BugId }, BugzillaClientError>;
  listChangesSince(params: {
    readonly since: IsoTimestamp;
    readonly limit: number;
    readonly offset: number;
  }): Effect.Effect<ListChangesSinceResult, BugzillaClientError>;
  checkVisibility(
    bugId: BugId,
    commentId?: number,
  ): Effect.Effect<VisibilityStatus, BugzillaClientError>;
  listEnterableProducts(): Effect.Effect<readonly EnterableProductSummary[], BugzillaClientError>;
  getProductMetadata(
    productName: string,
  ): Effect.Effect<ProductMetadata | null, BugzillaClientError>;
  getBugFields(): Effect.Effect<readonly FieldMetadata[], BugzillaClientError>;
}

export type PromiseBugzillaCapabilities = Omit<BugzillaInstanceCapabilities, "authMode"> & {
  readonly authMode?: BugzillaAuthMode;
};

export interface BugzillaClient {
  probeCapabilities(): Promise<PromiseBugzillaCapabilities>;
  searchBugs(params: BugzillaSearchParams): Promise<BugzillaSearchResult>;
  getBugDossierData(
    bugId: BugId,
    opts: { readonly maxComments: number; readonly maxHistory: number },
  ): Promise<Omit<BugDossier, "internalNotes"> | null>;
  listAttachments(bugId: BugId): Promise<AttachmentMeta[] | null>;
  getAttachmentExcerpt?(params: {
    readonly attachmentId: number;
    readonly byteOffset: number;
    readonly maxBytes: number;
  }): Promise<AttachmentExcerptResult | null>;
  postPrivateComment(bugId: BugId, text: string): Promise<PostPrivateCommentResult>;
  postPublicComment?(bugId: BugId, text: string): Promise<PostPublicCommentResult>;
  applyBugUpdate(bugId: BugId, diff: ProposalDiff): Promise<ApplyBugUpdateResult>;
  createBug(
    input: Omit<BugzillaCreateBugInput, "idempotencyKey">,
  ): Promise<{ readonly bugId: BugId }>;
  listChangesSince(params: {
    readonly since: IsoTimestamp;
    readonly limit: number;
    readonly offset: number;
  }): Promise<ListChangesSinceResult>;
  checkVisibility(bugId: BugId, commentId?: number): Promise<VisibilityStatus>;
  listEnterableProducts?(): Promise<readonly EnterableProductSummary[]>;
  getProductMetadata?(productName: string): Promise<ProductMetadata | null>;
  getBugFields?(): Promise<readonly FieldMetadata[]>;
}
