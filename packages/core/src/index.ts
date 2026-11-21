import type { BugzillaClient } from "@bugzilla-mcp/bugzilla-client";
import { buildCloudApprovalTokenService } from "./approval.js";
import { buildSyntheticEventsService } from "./events.js";
import { buildWriteGuardService } from "./write-guard.js";
export { McpDomainError, canonicalJson, sha256Hex } from "./canonical.js";
import type {
  AppResolveProposalInput,
  AppSaveDraftInput,
  BugId,
  BugzillaCreateBugInput,
  BugzillaPostAnalysisInput,
  BugzillaProposeUpdateInput,
  DraftSaveResult,
  EventFilterArgs,
  EventName,
  EventOccurrence,
  EventsProfile,
  IsoTimestamp,
  PollEventsParams,
  PollEventsResult,
  PrincipalContext,
  ProposalDiff,
  WebhookSubscribeParams,
  WebhookSubscribeResult,
  WriteGuardOutcome,
} from "@bugzilla-mcp/contracts";
import type { StoragePorts, StoredDraft } from "@bugzilla-mcp/storage";

export interface WebhookPinnedRequest {
  readonly resolvedIp: string;
  readonly hostHeader: string;
  readonly tlsSni: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
  readonly followRedirects: false;
}

export interface WebhookPinnedResponse {
  readonly status: number;
  readonly body: string;
}

/** External network & DNS boundary port for SSRF-safe outbound webhooks */
export interface WebhookOutboundTransport {
  resolveHost(hostname: string): Promise<readonly string[]>;
  postPinned(req: WebhookPinnedRequest): Promise<WebhookPinnedResponse>;
}

export interface CloudApprovalExpected {
  readonly approverPrincipalId: string;
  readonly instanceUrl: string;
  readonly proposalId: string;
  readonly revision: number;
  readonly bugId: BugId;
  readonly baseVersion: IsoTimestamp;
  readonly diff: ProposalDiff;
  readonly visibility: "public" | "private";
  readonly nowMs: number;
}

export type CloudApprovalVerificationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason:
        | "invalid_signature"
        | "expired"
        | "replayed"
        | "binding_mismatch"
        | "visibility_mismatch";
    };

export interface CloudApprovalTokenService {
  issue(params: {
    readonly approverPrincipalId: string;
    readonly instanceUrl: string;
    readonly proposalId: string;
    readonly revision: number;
    readonly bugId: BugId;
    readonly baseVersion: IsoTimestamp;
    readonly diff: ProposalDiff;
    readonly visibility: "public" | "private";
    readonly ttlMs: number;
    readonly nowMs: number;
  }): Promise<{ readonly token: string; readonly expiresAt: IsoTimestamp }>;
  verifyAndConsume(
    token: string,
    expected: CloudApprovalExpected,
  ): Promise<CloudApprovalVerificationResult>;
}

export interface CoreDependencies {
  readonly storage: StoragePorts;
  readonly resolveClient: (ctx: PrincipalContext) => Promise<BugzillaClient | null>;
  readonly eventsProfile: EventsProfile;
  readonly eventSchemaEpoch?: number;
  readonly causalBudgetPerBug: number;
  readonly causalBudgetWindowMs?: number;
  readonly lagWindowMs: number;
  readonly maxReplayWindowMs?: number;
  readonly maxWebhookRetries?: number;
  readonly secretRotationGraceMs?: number;
  readonly clock?: () => number;
  readonly webhookTransport?: WebhookOutboundTransport;
  readonly cloudApprovalService?: CloudApprovalTokenService;
  readonly isPolicyGranted?: (
    ctx: PrincipalContext,
    input: BugzillaProposeUpdateInput,
  ) => Promise<boolean>;
}

export interface WriteGuardService {
  postAnalysis(ctx: PrincipalContext, input: BugzillaPostAnalysisInput): Promise<WriteGuardOutcome>;
  proposeUpdate(
    ctx: PrincipalContext,
    input: BugzillaProposeUpdateInput,
  ): Promise<WriteGuardOutcome>;
  createBug(ctx: PrincipalContext, input: BugzillaCreateBugInput): Promise<WriteGuardOutcome>;
  resolveProposal(
    ctx: PrincipalContext,
    input: AppResolveProposalInput,
  ): Promise<WriteGuardOutcome>;
  saveDraft(ctx: PrincipalContext, input: AppSaveDraftInput): Promise<DraftSaveResult>;
  getDraft(
    ctx: PrincipalContext,
    params: { bugId: BugId; draftKind: AppSaveDraftInput["draftKind"] },
  ): Promise<StoredDraft | null>;
}

export type EventStreamFrame =
  | {
      readonly method: "notifications/events/active";
      readonly cursor: string | null;
      readonly truncated: boolean;
      readonly heartbeatMs: number;
    }
  | { readonly method: "notifications/events/event"; readonly occurrence: EventOccurrence }
  | { readonly method: "notifications/events/heartbeat"; readonly cursor: string | null }
  | { readonly method: "notifications/events/error"; readonly message: string }
  | {
      readonly method: "notifications/events/terminated";
      readonly code: number;
      readonly reason: string;
    };

export interface SyntheticEventsService {
  listEvents(): {
    readonly profile: EventsProfile;
    readonly events: readonly {
      readonly name: EventName;
      readonly delivery: readonly ("poll" | "push" | "webhook")[];
      readonly inputSchema?: Readonly<Record<string, unknown>>;
      readonly payloadSchema?: Readonly<Record<string, unknown>>;
    }[];
  };
  poll(ctx: PrincipalContext, params: PollEventsParams): Promise<PollEventsResult>;
  stream(
    ctx: PrincipalContext,
    params: {
      name: EventName;
      arguments?: EventFilterArgs;
      cursor?: string | null;
      maxAgeMs?: number;
      heartbeatMs?: number;
    },
    signal?: AbortSignal,
  ): AsyncIterable<EventStreamFrame>;
  subscribeWebhook(
    ctx: PrincipalContext,
    params: WebhookSubscribeParams,
  ): Promise<WebhookSubscribeResult>;
  unsubscribeWebhook(
    ctx: PrincipalContext,
    params: {
      name: EventName;
      arguments: EventFilterArgs;
      delivery: { url: string; mode?: "webhook" };
    },
  ): Promise<{ resultType: "complete" }>;
  deliverPendingWebhooks(
    ctx: PrincipalContext,
  ): Promise<{ delivered: number; abandoned: number; terminated: number }>;
}

export function createWriteGuardService(deps: CoreDependencies): WriteGuardService {
  return buildWriteGuardService(deps);
}

export function createSyntheticEventsService(deps: CoreDependencies): SyntheticEventsService {
  return buildSyntheticEventsService(deps);
}

export function createCloudApprovalTokenService(
  signingSecret: string,
  storage?: StoragePorts,
): CloudApprovalTokenService {
  return buildCloudApprovalTokenService(signingSecret, storage);
}

export function startWebhookDeliveryLoop(params: {
  events: SyntheticEventsService;
  listPrincipals: () => Promise<readonly PrincipalContext[]>;
  intervalMs: number;
  onError?: (err: unknown) => void;
}): { stop(): void } {
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    void (async () => {
      try {
        const principals = await params.listPrincipals();
        for (const ctx of principals) {
          if (stopped) break;
          await params.events.deliverPendingWebhooks(ctx);
        }
      } catch (err) {
        params.onError?.(err);
      } finally {
        running = false;
      }
    })();
  }, params.intervalMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
