import type { BugzillaClient, BugzillaClientEffect } from "@bugzilla-mcp/bugzilla-client";
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
import {
  makeStorageLayer,
  type StoragePorts,
  type StorageService,
  type StoredDraft,
} from "@bugzilla-mcp/storage";
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";
import { asEffectBugzillaClient, runCoreEffect } from "./canonical.js";
import { buildCloudApprovalTokenService } from "./approval.js";
import {
  buildSyntheticEventsService,
  createSyntheticEventsEngine,
  makeSyntheticEventsLayer,
  SyntheticEventsTag,
  type SyntheticEventsEngine,
} from "./events.js";
import {
  createMetadataCacheEffect,
  MetadataCacheTag,
  type MetadataCacheEffect,
  type MetadataCacheService,
} from "./metadata-cache.js";
import {
  createSqliteWebhookScheduler,
  WebhookSchedulerPort,
  type WebhookSchedulerService,
} from "./webhook-scheduler.js";
import {
  buildWriteGuardService,
  createGuardedMutationEngine,
  makeWriteGuardLayer,
  WriteGuardTag,
  type GuardedMutationEngine,
} from "./write-guard.js";

export {
  asEffectBugzillaClient,
  canonicalJson,
  domainErrorToMcpDomainError,
  McpDomainError,
  normalizeArgsForCanonical,
  runCoreEffect,
  sha256Hex,
  toMcpDomainError,
  type AnyBugzillaClient,
} from "./canonical.js";
export {
  createMetadataCache,
  createMetadataCacheEffect,
  DEFAULT_FIELD_METADATA_TTL_MS,
  DEFAULT_MAX_FIELD_HINT_ITEMS,
  DEFAULT_METADATA_MAX_ENTRIES,
  DEFAULT_PRODUCT_METADATA_TTL_MS,
  makeMetadataCacheLayer,
  MetadataCacheTag,
  type CreateBugPreflightResult,
  type MetadataCacheConfig,
  type MetadataCacheEffect,
  type MetadataCacheService,
} from "./metadata-cache.js";
export {
  createGuardedMutationEngine,
  makeWriteGuardLayer,
  WriteGuardTag,
  type GuardedMutationEngine,
  type WriteGuardError,
} from "./write-guard.js";
export {
  createSqliteWebhookScheduler,
  sqliteWebhookSchedulerLayer,
  WebhookSchedulerPort,
  type WebhookLoopParams,
  type WebhookSchedulerService,
} from "./webhook-scheduler.js";
export {
  createSyntheticEventsEngine,
  makeSyntheticEventsLayer,
  SyntheticEventsTag,
  type EventsEngineError,
  type SyntheticEventsEngine,
  type WebhookPostFailureReason,
  type WebhookPostResult,
} from "./events.js";

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
  readonly approverIssuer: string;
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

export type CloudApprovalFailureReason =
  | "invalid_signature"
  | "expired"
  | "replayed"
  | "binding_mismatch"
  | "visibility_mismatch";

export type CloudApprovalPrecheckResult =
  | { readonly valid: true; readonly jti: string; readonly expiresAtMs: number }
  | { readonly valid: false; readonly reason: CloudApprovalFailureReason };

export type CloudApprovalVerificationResult =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: CloudApprovalFailureReason };

export interface CloudApprovalTokenService {
  issue(params: {
    readonly approverIssuer: string;
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
  /** Stage 1 non-consuming verification of HMAC signature, TTL, visibility, and payload binding. */
  verifySignatureAndBinding?(
    token: string,
    expected: CloudApprovalExpected,
  ): Promise<CloudApprovalPrecheckResult>;
  /** Stage 3 commit-threshold DB-first single-use JTI consumption. */
  consumeVerifiedJti?(jti: string, expiresAtMs: number, nowMs: number): Promise<boolean>;
  verifyAndConsume(
    token: string,
    expected: CloudApprovalExpected,
  ): Promise<CloudApprovalVerificationResult>;
}

export interface CoreDependencies {
  readonly storage: StoragePorts;
  readonly resolveClient: (
    ctx: PrincipalContext,
  ) => Promise<BugzillaClient | BugzillaClientEffect | null>;
  readonly eventsProfile: EventsProfile;
  readonly eventSchemaEpoch?: number;
  readonly causalBudgetPerBug: number;
  readonly causalBudgetWindowMs?: number;
  readonly receiptLeaseMs?: number;
  readonly lagWindowMs: number;
  readonly maxReplayWindowMs?: number;
  readonly maxWebhookRetries?: number;
  readonly secretRotationGraceMs?: number;
  readonly clock?: () => number;
  readonly metadataCache?: MetadataCacheEffect;
  readonly webhookScheduler?: WebhookSchedulerService;
  readonly webhookTransport?: WebhookOutboundTransport;
  readonly webhookEnabled?: boolean;
  readonly revalidateWebhookGrant?: (grant: PrincipalContext) => Promise<PrincipalContext | null>;
  readonly onWebhookScanState?: (subscriptionId: string, state: WebhookScanState) => void;
  readonly cloudApprovalService?: CloudApprovalTokenService;
  readonly isPolicyGranted?: (
    ctx: PrincipalContext,
    input: BugzillaProposeUpdateInput,
  ) => Promise<boolean>;
}

export type WebhookScanState =
  | "idle"
  | "active"
  | "scan_incomplete"
  | "authorization_revoked"
  | "gap_delivery_stalled"
  | "schema_epoch_mismatch";

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

export type CoreServices =
  | StorageService
  | MetadataCacheTag
  | WebhookSchedulerPort
  | WriteGuardTag
  | SyntheticEventsTag;

export interface CoreRuntime {
  readonly runtime: ManagedRuntime.ManagedRuntime<CoreServices, never>;
  readonly writeGuardEffect: GuardedMutationEngine;
  readonly eventsEffect: SyntheticEventsEngine;
  readonly metadataCacheEffect: MetadataCacheEffect;
  readonly webhookScheduler: WebhookSchedulerService;
  readonly writeGuard: WriteGuardService;
  readonly events: SyntheticEventsService;
  readonly metadataCache: MetadataCacheService;
  dispose(): Promise<void>;
}

export function createCoreLayer(deps: CoreDependencies): Layer.Layer<CoreServices> {
  const metadataCache =
    deps.metadataCache ?? createMetadataCacheEffect(deps.clock ? { clock: deps.clock } : {});
  const webhookScheduler = deps.webhookScheduler ?? createSqliteWebhookScheduler();
  const normalizedDeps: CoreDependencies = {
    ...deps,
    metadataCache,
    webhookScheduler,
  };
  return Layer.mergeAll(
    makeStorageLayer(normalizedDeps.storage),
    Layer.succeed(MetadataCacheTag, metadataCache),
    Layer.succeed(WebhookSchedulerPort, webhookScheduler),
    makeWriteGuardLayer(normalizedDeps),
    makeSyntheticEventsLayer(normalizedDeps),
  );
}

export function createCoreRuntime(deps: CoreDependencies): CoreRuntime {
  const metadataCacheEffect =
    deps.metadataCache ?? createMetadataCacheEffect(deps.clock ? { clock: deps.clock } : {});
  const webhookScheduler = deps.webhookScheduler ?? createSqliteWebhookScheduler();
  const normalizedDeps: CoreDependencies = {
    ...deps,
    metadataCache: metadataCacheEffect,
    webhookScheduler,
  };
  const writeGuardEffect = createGuardedMutationEngine(normalizedDeps);
  const eventsEffect = createSyntheticEventsEngine(normalizedDeps);
  const layer: Layer.Layer<CoreServices> = Layer.mergeAll(
    makeStorageLayer(normalizedDeps.storage),
    Layer.succeed(MetadataCacheTag, metadataCacheEffect),
    Layer.succeed(WebhookSchedulerPort, webhookScheduler),
    Layer.succeed(WriteGuardTag, writeGuardEffect),
    Layer.succeed(SyntheticEventsTag, eventsEffect),
  );
  const runtime = ManagedRuntime.make(layer);
  const writeGuard: WriteGuardService = {
    postAnalysis: (ctx, input) => runCoreEffect(writeGuardEffect.postAnalysis(ctx, input)),
    proposeUpdate: (ctx, input) => runCoreEffect(writeGuardEffect.proposeUpdate(ctx, input)),
    createBug: (ctx, input) => runCoreEffect(writeGuardEffect.createBug(ctx, input)),
    resolveProposal: (ctx, input) => runCoreEffect(writeGuardEffect.resolveProposal(ctx, input)),
    saveDraft: (ctx, input) => runCoreEffect(writeGuardEffect.saveDraft(ctx, input)),
    getDraft: (ctx, params) => runCoreEffect(writeGuardEffect.getDraft(ctx, params)),
  };
  const events: SyntheticEventsService = {
    listEvents: () => eventsEffect.listEvents(),
    poll: (ctx, params) => runCoreEffect(eventsEffect.poll(ctx, params)),
    stream: (ctx, params, signal) => eventsEffect.stream(ctx, params, signal),
    subscribeWebhook: (ctx, params) => runCoreEffect(eventsEffect.subscribeWebhook(ctx, params)),
    unsubscribeWebhook: (ctx, params) =>
      runCoreEffect(eventsEffect.unsubscribeWebhook(ctx, params)),
    deliverPendingWebhooks: (ctx) => runCoreEffect(eventsEffect.deliverPendingWebhooks(ctx)),
  };
  const metadataCache: MetadataCacheService = {
    listEnterableProducts: (ctx, client) =>
      runCoreEffect(metadataCacheEffect.listEnterableProducts(ctx, asEffectBugzillaClient(client))),
    getProductMetadata: (ctx, client, productName) =>
      runCoreEffect(
        metadataCacheEffect.getProductMetadata(ctx, asEffectBugzillaClient(client), productName),
      ),
    getBugFields: (ctx, client) =>
      runCoreEffect(metadataCacheEffect.getBugFields(ctx, asEffectBugzillaClient(client))),
    preflightCreateBug: (ctx, client, input) =>
      runCoreEffect(
        metadataCacheEffect.preflightCreateBug(ctx, asEffectBugzillaClient(client), input),
      ),
    invalidateTenant: (ctx) => metadataCacheEffect.invalidateTenant(ctx),
  };
  return {
    runtime,
    writeGuardEffect,
    eventsEffect,
    metadataCacheEffect,
    webhookScheduler,
    writeGuard,
    events,
    metadataCache,
    dispose: () => runtime.dispose(),
  };
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
  scheduler?: WebhookSchedulerService;
}): { stop(): Promise<void> } {
  const scheduler = params.scheduler ?? createSqliteWebhookScheduler();
  const scope = Effect.runSync(Scope.make());
  let stopped = false;

  const tick = () =>
    Effect.gen(function* () {
      const principals = yield* Effect.tryPromise({
        try: () => params.listPrincipals(),
        catch: (err) => err,
      });
      for (const ctx of principals) {
        if (stopped) break;
        yield* Effect.tryPromise({
          try: () => params.events.deliverPendingWebhooks(ctx),
          catch: (err) => err,
        }).pipe(
          Effect.catch((err) =>
            Effect.sync(() => {
              params.onError?.(err);
            }),
          ),
        );
      }
    });

  Effect.runSync(
    scheduler
      .startLoop({
        intervalMs: params.intervalMs,
        tick,
        ...(params.onError !== undefined ? { onError: params.onError } : {}),
      })
      .pipe(Effect.provideService(Scope.Scope, scope)),
  );

  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}
