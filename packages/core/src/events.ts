import { randomBytes, timingSafeEqual } from "node:crypto";
import type {
  BugzillaClientEffect,
  BugzillaClientError,
  UpstreamBugzillaOccurrence,
} from "@bugzilla-mcp/bugzilla-client";
import {
  eventFilterJsonSchema,
  McpErrorCode,
  WebhookSecretSchema,
  type EventFilterArgs,
  type EventName,
  type EventOccurrence,
  type PollEventsParams,
  type PollEventsResult,
  type PrincipalContext,
  type WebhookSubscribeParams,
  type WebhookSubscribeResult,
} from "@bugzilla-mcp/contracts";
import {
  toEffectStorage,
  type StorageError,
  type StoredWebhookSubscription,
} from "@bugzilla-mcp/storage";
import { Context, Effect, Layer, Result, Schema } from "effect";
import {
  asEffectBugzillaClient,
  canonicalJson,
  McpDomainError,
  normalizeArgsForCanonical,
  runCoreEffect,
  sha256Hex,
  type AnyBugzillaClient,
} from "./canonical.js";
import type {
  CoreDependencies,
  EventStreamFrame,
  SyntheticEventsService,
  WebhookPinnedResponse,
  WebhookScanState,
} from "./index.js";
import { selectValidatedPublicIp, signStandardWebhook, validateWebhookUrl } from "./ssrf.js";
import { createSqliteWebhookScheduler, type WebhookSchedulerService } from "./webhook-scheduler.js";

const ALL_EVENTS: readonly EventName[] = [
  "bugzilla.bug.created",
  "bugzilla.bug.updated",
  "bugzilla.bug.commented",
  "bugzilla.flag.needinfo",
];

const MAX_WEBHOOK_BYTES = 256 * 1024;
const MAX_EXCERPT_BYTES = 64 * 1024;
const DEFAULT_REPLAY_MS = 24 * 60 * 60 * 1000;
const END_OF_TIMESTAMP = "\uffff";
const MAX_JS_DATE_MS = 8_640_000_000_000_000;

export type WebhookPostFailureReason =
  | "ssrf_blocked"
  | "payload_too_large"
  | "transport_unconfigured"
  | "http_4xx"
  | "http_5xx"
  | "network_timeout";

export type WebhookPostResult =
  | { readonly ok: true; readonly response: WebhookPinnedResponse }
  | {
      readonly ok: false;
      readonly reason: WebhookPostFailureReason;
      readonly retryable: boolean;
      readonly status?: number;
      readonly message: string;
    };

export type EventsEngineError = McpDomainError | StorageError;

export interface SyntheticEventsEngine {
  listEvents(): ReturnType<SyntheticEventsService["listEvents"]>;
  poll(
    ctx: PrincipalContext,
    params: PollEventsParams,
  ): Effect.Effect<PollEventsResult, EventsEngineError>;
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
  ): Effect.Effect<WebhookSubscribeResult, EventsEngineError>;
  unsubscribeWebhook(
    ctx: PrincipalContext,
    params: {
      name: EventName;
      arguments: EventFilterArgs;
      delivery: { url: string; mode?: "webhook" };
    },
  ): Effect.Effect<{ resultType: "complete" }, EventsEngineError>;
  deliverPendingWebhooks(
    ctx: PrincipalContext,
  ): Effect.Effect<{ delivered: number; abandoned: number; terminated: number }, EventsEngineError>;
}

export class SyntheticEventsTag extends Context.Service<
  SyntheticEventsTag,
  SyntheticEventsEngine
>()("@bugzilla-mcp/core/SyntheticEventsTag") {}

interface DecodedCursor {
  readonly v: number;
  readonly scope: string;
  readonly ts: number;
  readonly tie: string;
}

interface PendingWebhookItem {
  readonly eventId: string;
  readonly webhookId: string;
  readonly occurrence: UpstreamBugzillaOccurrence;
  readonly tieKey: string;
  readonly tsMs: number;
  attempts: number;
  nextAttemptAtMs: number;
  inFlight?: boolean;
  outcome?: "acknowledged" | "suppressed" | "abandoned";
}

function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) {
    return { text, truncated: false };
  }
  let end = maxBytes;
  while (end > 0 && ((buf[end] ?? 0) & 0xc0) === 0x80) {
    end -= 1;
  }
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

function buildScopeHash(
  ctx: PrincipalContext,
  name: EventName,
  args: EventFilterArgs | undefined,
): string {
  return sha256Hex(
    canonicalJson({
      issuer: ctx.issuer,
      principalId: ctx.principalId,
      instanceUrl: ctx.instanceUrl,
      credentialGeneration: ctx.credentialGeneration,
      name,
      args: normalizeArgsForCanonical(args),
    }),
  );
}

function encodeCursor(cursor: DecodedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string, expectedScope: string, currentEpoch: number): DecodedCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new McpDomainError(McpErrorCode.INVALID_PARAMS, "Malformed cursor");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as DecodedCursor).v !== "number" ||
    typeof (parsed as DecodedCursor).scope !== "string" ||
    typeof (parsed as DecodedCursor).ts !== "number" ||
    !Number.isFinite((parsed as DecodedCursor).ts) ||
    Math.abs((parsed as DecodedCursor).ts) > MAX_JS_DATE_MS ||
    Number.isNaN(new Date((parsed as DecodedCursor).ts).getTime()) ||
    typeof (parsed as DecodedCursor).tie !== "string"
  ) {
    throw new McpDomainError(McpErrorCode.INVALID_PARAMS, "Malformed cursor fields");
  }
  const cursor = parsed as DecodedCursor;
  if (cursor.scope !== expectedScope) {
    throw new McpDomainError(McpErrorCode.INVALID_PARAMS, "Foreign cursor scope");
  }
  if (cursor.v !== currentEpoch) {
    throw new McpDomainError(McpErrorCode.SEP_EVENTS_UNSUPPORTED, "Event schema epoch changed", {
      feature: "payloadSchema",
      reason: "schema_changed",
    });
  }
  return cursor;
}

function decodeCursorEffect(
  raw: string,
  expectedScope: string,
  currentEpoch: number,
): Effect.Effect<DecodedCursor, McpDomainError> {
  return Effect.try({
    try: () => decodeCursor(raw, expectedScope, currentEpoch),
    catch: (err) =>
      err instanceof McpDomainError
        ? err
        : new McpDomainError(McpErrorCode.INVALID_PARAMS, String(err)),
  });
}

function occurrenceEventId(occ: UpstreamBugzillaOccurrence): string {
  return `bz:${occ.kind}:${occ.bugId}:${occ.commentId ?? occ.changeKey}`;
}

function occurrenceTieKey(occ: UpstreamBugzillaOccurrence): string {
  const cid = String(occ.commentId ?? 0).padStart(12, "0");
  const bid = String(occ.bugId).padStart(12, "0");
  return `${bid}:${cid}:${occ.changeKey}`;
}

function comparePosition(
  a: Pick<DecodedCursor, "ts" | "tie">,
  b: Pick<DecodedCursor, "ts" | "tie">,
) {
  return a.ts - b.ts || (a.tie < b.tie ? -1 : a.tie > b.tie ? 1 : 0);
}

function scanIncomplete(): McpDomainError {
  return new McpDomainError(McpErrorCode.INTERNAL_ERROR, "Upstream scan incomplete", {
    reason: "scan_incomplete",
  });
}

function eventAccessRevoked(): McpDomainError {
  return new McpDomainError(McpErrorCode.SEP_EVENTS_FORBIDDEN, "Events access revoked");
}

function isRevoked(error: unknown): boolean {
  if (error instanceof McpDomainError && error.code === McpErrorCode.SEP_EVENTS_FORBIDDEN) {
    return true;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    (error as { _tag?: unknown })._tag === "BugzillaCredentialRevokedError"
  ) {
    return true;
  }
  return error instanceof Error && error.name === "BugzillaCredentialRevokedError";
}

function isSchemaEpochMismatch(error: unknown): boolean {
  return error instanceof McpDomainError && error.code === McpErrorCode.SEP_EVENTS_UNSUPPORTED;
}

function buildOccurrencePayload(occ: UpstreamBugzillaOccurrence): EventOccurrence {
  const data: Record<string, unknown> = {
    bugId: occ.bugId,
    product: occ.product,
    component: occ.component,
    actor: occ.actor,
    untrustedUserContent: true,
  };
  if (occ.commentId !== undefined) data.commentId = occ.commentId;
  if (occ.fieldsChanged !== undefined) data.fieldsChanged = occ.fieldsChanged;
  if (occ.summaryText !== undefined) {
    const cut = truncateUtf8(occ.summaryText, 4096);
    data.summaryText = cut.text;
    if (cut.truncated) data.summaryTruncated = true;
  }
  if (occ.commentText !== undefined) {
    const cut = truncateUtf8(occ.commentText, MAX_EXCERPT_BYTES);
    data.commentText = cut.text;
    if (cut.truncated) data.excerptTruncated = true;
  }
  return {
    eventId: occurrenceEventId(occ),
    name: occ.kind,
    timestamp: occ.timestamp,
    data,
  };
}

function matchesFilter(
  occ: UpstreamBugzillaOccurrence,
  name: EventName,
  args: EventFilterArgs | undefined,
  principalId?: string,
): boolean {
  if (occ.kind !== name) return false;
  if (args?.product && occ.product !== args.product) return false;
  if (args?.component && occ.component !== args.component) return false;
  if (args?.severity && occ.severity !== args.severity) return false;
  if (args?.bugIds && !args.bugIds.includes(occ.bugId)) {
    return false;
  }
  const watched = args?.watchedFields;
  if (
    watched &&
    !occ.fieldsChanged?.some((field) => (watched as readonly string[]).includes(field))
  ) {
    return false;
  }
  if (args?.mentionMe && principalId) {
    const words = (occ.commentText ?? "")
      .toLowerCase()
      .match(/[\p{L}\p{N}_+.-]+(?:@[\p{L}\p{N}_.-]+)?/gu);
    if (!words?.some((word) => word.replace(/[.]$/, "") === principalId.toLowerCase())) {
      return false;
    }
  }
  if (args?.requestee) {
    const expectedRequestee =
      args.requestee.toLowerCase() === "me" && principalId ? principalId : args.requestee;
    if (!occ.requestee || occ.requestee.toLowerCase() !== expectedRequestee.toLowerCase()) {
      return false;
    }
  }
  return true;
}

export function createSyntheticEventsEngine(deps: CoreDependencies): SyntheticEventsEngine {
  const clock = deps.clock ?? (() => Date.now());
  const schemaEpoch = deps.eventSchemaEpoch ?? 1;
  const maxRetries = deps.maxWebhookRetries ?? 3;
  const rotationGraceMs = deps.secretRotationGraceMs ?? 300_000;
  const replayMs = deps.maxReplayWindowMs ?? DEFAULT_REPLAY_MS;
  const storage = toEffectStorage(deps.storage);
  const scheduler: WebhookSchedulerService =
    deps.webhookScheduler ?? createSqliteWebhookScheduler();
  const verifiedPrefixes = new Map<string, number>();
  const scanStates = new Map<string, WebhookScanState>();

  function rememberPrefix(scope: string, time: number): void {
    const previous = verifiedPrefixes.get(scope) ?? -Infinity;
    if (time <= previous) return;
    if (!verifiedPrefixes.has(scope) && verifiedPrefixes.size >= 1024) {
      const oldest = verifiedPrefixes.keys().next().value;
      if (oldest !== undefined) verifiedPrefixes.delete(oldest);
    }
    verifiedPrefixes.set(scope, time);
  }

  function reportState(id: string, state: WebhookScanState): void {
    if (scanStates.get(id) === state) return;
    scanStates.set(id, state);
    deps.onWebhookScanState?.(id, state);
  }

  const requireClient = Effect.fnUntraced(function* (
    ctx: PrincipalContext,
  ): Effect.fn.Return<BugzillaClientEffect, McpDomainError> {
    if (!ctx.scopes.includes("bz:events")) {
      return yield* Effect.fail(eventAccessRevoked());
    }
    const raw: AnyBugzillaClient | null = yield* Effect.tryPromise({
      try: () => deps.resolveClient(ctx),
      catch: (err) =>
        isRevoked(err)
          ? eventAccessRevoked()
          : new McpDomainError(
              McpErrorCode.INTERNAL_ERROR,
              err instanceof Error ? err.message : String(err),
            ),
    });
    if (!raw) {
      return yield* Effect.fail(eventAccessRevoked());
    }
    return asEffectBugzillaClient(raw);
  });

  const checkCredential = Effect.fnUntraced(function* (client: BugzillaClientEffect) {
    return yield* client
      .probeCapabilities()
      .pipe(
        Effect.mapError((err: BugzillaClientError) =>
          isRevoked(err) ? eventAccessRevoked() : scanIncomplete(),
        ),
      );
  });

  type SubscriptionKey = Pick<
    StoredWebhookSubscription,
    "issuer" | "principalId" | "instanceUrl" | "url" | "name" | "canonicalArgsJson"
  >;

  function subscriptionKey(
    ctx: PrincipalContext,
    name: EventName,
    args: EventFilterArgs,
    url: string,
  ): SubscriptionKey {
    return {
      issuer: ctx.issuer,
      principalId: ctx.principalId,
      instanceUrl: ctx.instanceUrl,
      url,
      name,
      canonicalArgsJson: canonicalJson(normalizeArgsForCanonical(args)),
    };
  }

  function serializationKey(key: SubscriptionKey): string {
    return JSON.stringify([
      key.issuer,
      key.principalId,
      key.instanceUrl,
      key.url,
      key.name,
      key.canonicalArgsJson,
    ]);
  }

  const saveItem = (subscriptionId: string, item: PendingWebhookItem) =>
    storage.upsertWebhookRetryItem({
      subscriptionId,
      eventId: item.eventId,
      payloadJson: JSON.stringify(item),
      attempts: item.attempts,
      nextAttemptAtMs: item.nextAttemptAtMs,
    });

  const loadItems = (subscriptionId: string): Effect.Effect<PendingWebhookItem[], StorageError> =>
    storage.listWebhookRetryItems(subscriptionId).pipe(
      Effect.map((rows) => {
        const items: PendingWebhookItem[] = [];
        for (const row of rows) {
          try {
            const parsed = JSON.parse(row.payloadJson) as PendingWebhookItem;
            items.push({
              ...parsed,
              attempts: row.attempts,
              nextAttemptAtMs: row.nextAttemptAtMs,
            });
          } catch {
            // Quarantine malformed retry row without crashing the sweep loop.
          }
        }
        return items;
      }),
    );

  const deleteItem = (subscriptionId: string, eventId: string) =>
    storage.deleteWebhookRetryItem(subscriptionId, eventId);

  function storedGrant(ctx: PrincipalContext): PrincipalContext {
    return {
      issuer: ctx.issuer,
      principalId: ctx.principalId,
      instanceUrl: ctx.instanceUrl,
      clientId: ctx.clientId,
      credentialGeneration: ctx.credentialGeneration,
      scopes: [...ctx.scopes],
      deploymentMode: ctx.deploymentMode,
    };
  }

  const requireWebhookGrant = Effect.fnUntraced(function* (
    grant: PrincipalContext,
    fallback: PrincipalContext,
  ): Effect.fn.Return<PrincipalContext, McpDomainError> {
    const current = deps.revalidateWebhookGrant
      ? yield* Effect.tryPromise({
          try: () => deps.revalidateWebhookGrant!(grant),
          catch: () => eventAccessRevoked(),
        })
      : fallback;
    if (
      !current ||
      current.issuer !== grant.issuer ||
      current.principalId !== grant.principalId ||
      current.instanceUrl !== grant.instanceUrl ||
      current.credentialGeneration !== grant.credentialGeneration ||
      !current.scopes.includes("bz:events")
    ) {
      return yield* Effect.fail(eventAccessRevoked());
    }
    return current;
  });

  function activeSecrets(sub: StoredWebhookSubscription, nowMs: number): string[] {
    if (
      sub.previousSecret &&
      sub.secretRotatedAt &&
      nowMs - Date.parse(sub.secretRotatedAt) <= rotationGraceMs
    ) {
      return [sub.secret, sub.previousSecret];
    }
    return [sub.secret];
  }

  type ScanEntry = {
    readonly occ: UpstreamBugzillaOccurrence;
    readonly tsMs: number;
    readonly tieKey: string;
    readonly eventId: string;
  };

  const scanRange = Effect.fnUntraced(function* (
    ctx: PrincipalContext,
    name: EventName,
    args: EventFilterArgs | undefined,
    sinceMs: number,
    upperBoundMs: number,
    resolvedClient?: BugzillaClientEffect,
  ): Effect.fn.Return<{ scanComplete: boolean; items: ScanEntry[] }, EventsEngineError> {
    const client = resolvedClient ?? (yield* requireClient(ctx));
    const identity =
      args?.mentionMe || args?.requestee?.toLowerCase() === "me"
        ? (yield* checkCredential(client)).authenticatedUser
        : undefined;

    const dedup = new Map<string, ScanEntry>();
    let offset = 0;
    const pageSize = 100;
    let complete = false;

    for (let guard = 0; guard < 100; guard += 1) {
      const pageResult = yield* client
        .listChangesSince({
          since: new Date(sinceMs).toISOString(),
          limit: pageSize,
          offset,
        })
        .pipe(
          Effect.map((page) => ({ ok: true as const, page })),
          Effect.catch((err: BugzillaClientError) => {
            if (isRevoked(err)) {
              return Effect.fail(eventAccessRevoked());
            }
            return Effect.succeed({ ok: false as const });
          }),
        );
      if (!pageResult.ok) {
        return { scanComplete: false, items: [] };
      }
      const { page } = pageResult;
      for (const occ of page.occurrences) {
        if (!matchesFilter(occ, name, args, identity)) continue;
        const tsMs = Date.parse(occ.timestamp);
        if (!Number.isFinite(tsMs) || tsMs < sinceMs || tsMs > upperBoundMs) continue;
        const eventId = occurrenceEventId(occ);
        if (!dedup.has(eventId)) {
          dedup.set(eventId, { occ, tsMs, tieKey: occurrenceTieKey(occ), eventId });
        }
      }
      if (page.scanComplete) {
        complete = true;
        break;
      }
      const nextOffset = page.nextOffset ?? offset + page.occurrences.length;
      if (nextOffset <= offset) {
        complete = false;
        break;
      }
      offset = nextOffset;
    }

    if (!complete) {
      return { scanComplete: false, items: [] };
    }

    const items = [...dedup.values()].sort((a, b) => {
      if (a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
      return a.tieKey < b.tieKey ? -1 : a.tieKey > b.tieKey ? 1 : 0;
    });

    const includeSelf = args?.includeSelf ?? false;
    if (includeSelf) {
      return { scanComplete: complete, items };
    }

    const filtered: ScanEntry[] = [];
    for (const entry of items) {
      const isSelf = yield* storage.hasSelfWrite({
        issuer: ctx.issuer,
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
        bugId: entry.occ.bugId,
        ...(entry.occ.commentId !== undefined ? { commentId: entry.occ.commentId } : {}),
        ...(entry.occ.kind === "bugzilla.bug.created"
          ? { diffKey: entry.occ.changeKey }
          : entry.occ.confirmedHistoryKey
            ? { diffKey: entry.occ.confirmedHistoryKey }
            : {}),
      });
      if (!isSelf) {
        filtered.push(entry);
      }
    }
    return { scanComplete: complete, items: filtered };
  });

  const sendSignedPinnedPost = Effect.fnUntraced(function* (params: {
    readonly url: string;
    readonly subscriptionId: string;
    readonly webhookId: string;
    readonly secrets: readonly string[];
    readonly rawBody: string;
    readonly nowMs: number;
  }): Effect.fn.Return<WebhookPostResult, never> {
    if (!deps.webhookTransport) {
      return {
        ok: false,
        reason: "transport_unconfigured",
        retryable: false,
        message: "Webhook transport is not configured",
      };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = validateWebhookUrl(params.url);
    } catch (err) {
      return {
        ok: false,
        reason: "ssrf_blocked",
        retryable: false,
        message: err instanceof Error ? err.message : "Invalid callback URL",
      };
    }

    if (Buffer.byteLength(params.rawBody, "utf8") > MAX_WEBHOOK_BYTES) {
      return {
        ok: false,
        reason: "payload_too_large",
        retryable: false,
        message: "Serialized webhook envelope exceeds 256 KiB",
      };
    }

    const addressesResult = yield* Effect.tryPromise({
      try: () => deps.webhookTransport!.resolveHost(parsedUrl.hostname),
      catch: (err) => err,
    }).pipe(
      Effect.map((addresses) => ({ ok: true as const, addresses })),
      Effect.catch((err) =>
        Effect.succeed({
          ok: false as const,
          message: err instanceof Error ? err.message : String(err),
        }),
      ),
    );
    if (!addressesResult.ok) {
      return {
        ok: false,
        reason: "network_timeout",
        retryable: true,
        message: `DNS resolution failed: ${addressesResult.message}`,
      };
    }

    const pinnedIp = selectValidatedPublicIp(addressesResult.addresses);
    if (!pinnedIp) {
      return {
        ok: false,
        reason: "ssrf_blocked",
        retryable: false,
        message: "Webhook callback host resolved to a non-public or empty IP address",
      };
    }

    const timestampSec = String(Math.floor(params.nowMs / 1000));
    const signature = signStandardWebhook(
      params.secrets,
      params.webhookId,
      timestampSec,
      params.rawBody,
    );

    const postResult = yield* Effect.tryPromise({
      try: () =>
        deps.webhookTransport!.postPinned({
          resolvedIp: pinnedIp,
          hostHeader: parsedUrl.host,
          tlsSni: parsedUrl.hostname,
          url: params.url,
          headers: {
            "Content-Type": "application/json",
            "webhook-id": params.webhookId,
            "webhook-timestamp": timestampSec,
            "webhook-signature": signature,
            "X-MCP-Subscription-Id": params.subscriptionId,
          },
          rawBody: params.rawBody,
          followRedirects: false,
        }),
      catch: (err) => err,
    }).pipe(
      Effect.map((response) => ({ ok: true as const, response })),
      Effect.catch((err) =>
        Effect.succeed({
          ok: false as const,
          message: err instanceof Error ? err.message : String(err),
        }),
      ),
    );

    if (!postResult.ok) {
      return {
        ok: false,
        reason: "network_timeout",
        retryable: true,
        message: postResult.message,
      };
    }

    const { response } = postResult;
    if (response.status >= 200 && response.status < 300) {
      return { ok: true, response };
    }
    if (response.status >= 400 && response.status < 500) {
      const terminal4xx = response.status === 410 || response.status === 413;
      return {
        ok: false,
        reason: "http_4xx",
        retryable: !terminal4xx,
        status: response.status,
        message: `Webhook callback returned HTTP ${response.status}`,
      };
    }
    return {
      ok: false,
      reason: "http_5xx",
      retryable: true,
      status: response.status,
      message: `Webhook callback returned HTTP ${response.status}`,
    };
  });

  function callbackErrorCode(): number {
    return deps.eventsProfile === "chatgpt-events"
      ? McpErrorCode.CHATGPT_EVENTS_CALLBACK_ERROR
      : McpErrorCode.SEP_EVENTS_CALLBACK_ERROR;
  }

  function makePending(entry: ScanEntry, nowMs: number): PendingWebhookItem {
    return {
      eventId: entry.eventId,
      webhookId:
        deps.eventsProfile === "chatgpt-events"
          ? entry.eventId
          : `msg_evt_${randomBytes(16).toString("base64url")}`,
      occurrence: entry.occ,
      tieKey: entry.tieKey,
      tsMs: entry.tsMs,
      attempts: 0,
      nextAttemptAtMs: nowMs,
    };
  }

  function retryDelay(attempts: number): number {
    return Math.min(10_000, 1_000 * 2 ** (attempts - 1));
  }

  /** Narrow initial probe floor (`#13` #6): `[safePrefixMs - lagWindowMs, safePrefixMs]`. */
  function initialProbeFloorMs(safePrefixMs: number): number {
    return Math.max(0, safePrefixMs - Math.max(1, deps.lagWindowMs));
  }

  const prepareSubscription = Effect.fnUntraced(function* (
    ctx: PrincipalContext,
    params: WebhookSubscribeParams,
    existing: StoredWebhookSubscription | null,
    nowMs: number,
  ) {
    const scopeHash = buildScopeHash(ctx, params.name, params.arguments);
    const requested =
      params.cursor == null
        ? undefined
        : yield* decodeCursorEffect(params.cursor, scopeHash, schemaEpoch);

    // Allow a principal with a newly bound valid credential (strictly higher credentialGeneration)
    // to take over their own revoked or older-generation subscription.
    // Still reject stale generations or un-rebound revoked subscriptions.
    const existingGen = existing?.grant?.credentialGeneration;
    let isGenerationTakeover = false;
    if (existing) {
      if (existingGen !== undefined && ctx.credentialGeneration < existingGen) {
        return yield* Effect.fail(eventAccessRevoked());
      }
      if (existing.revoked) {
        if (existingGen === undefined || ctx.credentialGeneration <= existingGen) {
          return yield* Effect.fail(eventAccessRevoked());
        }
        isGenerationTakeover = true;
      } else if (existingGen !== undefined && ctx.credentialGeneration > existingGen) {
        isGenerationTakeover = true;
      }
    }

    if (deps.revalidateWebhookGrant) {
      yield* requireWebhookGrant(ctx, ctx);
    }
    const client = yield* requireClient(ctx);

    if (
      !isGenerationTakeover &&
      existing?.verified &&
      existing.safeWatermark !== null &&
      (existing.refreshBefore === null || nowMs <= Date.parse(existing.refreshBefore))
    ) {
      yield* checkCredential(client);
      const gap = existing.lastGapCursor
        ? yield* decodeCursorEffect(existing.lastGapCursor, scopeHash, schemaEpoch)
        : undefined;
      const startCursor = existing.recoveryCursor ?? existing.safeWatermark;
      const truncated =
        existing.gapPending ||
        (gap !== undefined && requested !== undefined && comparePosition(requested, gap) < 0);
      return {
        live: existing,
        startCursor,
        acquisitionCursor: existing.acquisitionCursor ?? existing.safeWatermark,
        truncated,
        clearedGapOnRefresh: existing.gapPending && truncated,
        acquired: [] as ScanEntry[],
      };
    }

    // For generation takeover or new/expired subscriptions, verify credential & perform fresh anchor/scan.
    const safePrefixMs = nowMs - deps.lagWindowMs;
    const known = verifiedPrefixes.get(scopeHash);
    const boundary: DecodedCursor = {
      v: schemaEpoch,
      scope: scopeHash,
      ts: safePrefixMs,
      tie: END_OF_TIMESTAMP,
    };
    if (!requested && known !== undefined) {
      yield* checkCredential(client);
      const cursor = encodeCursor({ ...boundary, ts: known });
      return {
        live: null,
        startCursor: cursor,
        acquisitionCursor: cursor,
        truncated: false,
        clearedGapOnRefresh: false,
        acquired: [] as ScanEntry[],
      };
    }

    const floor = requested
      ? Math.max(requested.ts, nowMs - replayMs, nowMs - (params.maxAgeMs ?? Infinity))
      : initialProbeFloorMs(safePrefixMs);
    const truncated = requested !== undefined && floor > requested.ts;
    const scan = yield* scanRange(ctx, params.name, params.arguments, floor, safePrefixMs, client);
    if (!scan.scanComplete) {
      return yield* Effect.fail(scanIncomplete());
    }
    rememberPrefix(scopeHash, safePrefixMs);
    const start = requested
      ? { ...requested, ts: floor, tie: truncated ? "" : requested.tie }
      : boundary;
    const acquired = requested
      ? scan.items.filter(
          (entry) => comparePosition({ ts: entry.tsMs, tie: entry.tieKey }, start) > 0,
        )
      : [];
    return {
      live: null,
      startCursor: encodeCursor(start),
      acquisitionCursor: encodeCursor(comparePosition(boundary, start) > 0 ? boundary : start),
      truncated,
      clearedGapOnRefresh: false,
      acquired,
    };
  });

  const settleAttempt = Effect.fnUntraced(function* (
    sub: StoredWebhookSubscription,
    item: PendingWebhookItem,
    result?: WebhookPostResult,
  ) {
    delete item.inFlight;
    if (result?.ok) {
      item.outcome = "acknowledged";
    } else if ((result && !result.retryable) || item.attempts >= maxRetries + 1) {
      item.outcome = "abandoned";
    } else {
      item.nextAttemptAtMs = clock() + retryDelay(item.attempts);
    }
    yield* saveItem(sub.id, item);
  });

  const sendOccurrence = Effect.fnUntraced(function* (
    sub: StoredWebhookSubscription,
    item: PendingWebhookItem,
  ) {
    const nowMs = clock();
    const occurrence = buildOccurrencePayload(item.occurrence);
    // [R-836a57]: A normal envelope NEVER carries a cursor past an unacknowledged item
    // or an uncommunicated gap.
    const cursor = sub.safeWatermark;
    let body = JSON.stringify({ ...occurrence, cursor });
    if (Buffer.byteLength(body, "utf8") > MAX_WEBHOOK_BYTES) {
      const { summaryText: _summary, commentText: _excerpt, ...fields } = occurrence.data;
      body = JSON.stringify({
        ...occurrence,
        cursor,
        data: { ...fields, excerptTruncated: true },
      });
    }
    item.attempts += 1;
    item.inFlight = true;
    item.nextAttemptAtMs = nowMs + retryDelay(item.attempts);
    yield* saveItem(sub.id, item);
    const result = yield* sendSignedPinnedPost({
      url: sub.url,
      subscriptionId: sub.id,
      webhookId: item.webhookId,
      secrets: activeSecrets(sub, nowMs),
      rawBody: body,
      nowMs,
    });
    yield* settleAttempt(sub, item, result);
  });

  const terminateSubscription = Effect.fnUntraced(function* (
    sub: StoredWebhookSubscription,
    items: readonly PendingWebhookItem[],
    params: {
      readonly state: WebhookScanState;
      readonly errorCode: number;
      readonly message: string;
      readonly data?: unknown;
    },
  ) {
    yield* storage.upsertWebhookSubscription({ ...sub, revoked: true });
    reportState(sub.id, params.state);
    for (const item of items) {
      yield* deleteItem(sub.id, item.eventId);
    }
    yield* scheduler.cancelSubscription(sub.id);
    if (deps.eventsProfile !== "sep-3415") return;
    const nowMs = clock();
    yield* sendSignedPinnedPost({
      url: sub.url,
      subscriptionId: sub.id,
      webhookId: `msg_terminated_${randomBytes(16).toString("base64url")}`,
      secrets: activeSecrets(sub, nowMs),
      nowMs,
      rawBody: JSON.stringify({
        type: "terminated",
        error: {
          code: params.errorCode,
          message: params.message,
          ...(params.data !== undefined ? { data: params.data } : {}),
        },
      }),
    });
  });

  const checkpoint = Effect.fnUntraced(function* (
    sub: StoredWebhookSubscription,
    ordered: readonly PendingWebhookItem[],
    acquisition: DecodedCursor,
  ): Effect.fn.Return<StoredWebhookSubscription, EventsEngineError> {
    const recoveryBefore = sub.recoveryCursor ?? sub.safeWatermark;
    if (recoveryBefore === null) return sub;
    let recovery = yield* decodeCursorEffect(recoveryBefore, acquisition.scope, schemaEpoch);
    let latestGap = sub.lastGapCursor;
    let blocked = false;
    const settled: PendingWebhookItem[] = [];
    for (const item of ordered) {
      if (!item.outcome) {
        blocked = true;
        break;
      }
      settled.push(item);
      if (item.outcome === "suppressed") continue;
      const position = { ...recovery, ts: item.tsMs, tie: item.tieKey };
      if (comparePosition(position, recovery) <= 0) continue;
      recovery = position;
      if (item.outcome === "abandoned") latestGap = encodeCursor(position);
    }
    if (!blocked && comparePosition(acquisition, recovery) > 0) recovery = acquisition;
    const recoveryCursor = encodeCursor(recovery);
    const newGap = latestGap !== sub.lastGapCursor;
    const { gapAttempt, ...rest } = sub;
    const committed: StoredWebhookSubscription = {
      ...rest,
      recoveryCursor,
      gapPending: sub.gapPending || newGap,
      // [R-836a57]: safeWatermark NEVER advances while gapPending is true!
      safeWatermark: sub.gapPending || newGap ? sub.safeWatermark : recoveryCursor,
      ...(latestGap ? { lastGapCursor: latestGap } : {}),
      ...(newGap ? { gapMessageId: `msg_gap_${randomBytes(16).toString("base64url")}` } : {}),
      ...(!newGap && gapAttempt ? { gapAttempt } : {}),
    };
    if (
      recoveryCursor !== recoveryBefore ||
      committed.safeWatermark !== sub.safeWatermark ||
      newGap
    ) {
      yield* storage.upsertWebhookSubscription(committed);
    }
    for (const item of settled) {
      yield* deleteItem(sub.id, item.eventId);
    }
    return committed;
  });

  const sendGap = Effect.fnUntraced(function* (sub: StoredWebhookSubscription) {
    if (deps.eventsProfile !== "sep-3415" || !sub.gapPending || !sub.recoveryCursor) return;
    const nowMs = clock();
    const prior = sub.gapAttempt;
    if (prior && prior.attempts >= maxRetries + 1) {
      // [R-836a57]: Retry exhaustion NEVER advances safeWatermark; surface degraded state
      // until the subscriber calls subscribeWebhook refresh to receive truncated: true.
      reportState(sub.id, "gap_delivery_stalled");
      return;
    }
    if (prior && prior.nextAttemptAtMs > nowMs) return;

    const gapMessageId = sub.gapMessageId ?? `msg_gap_${randomBytes(16).toString("base64url")}`;
    const attempts = (prior?.attempts ?? 0) + 1;
    const cursor = prior?.cursor ?? sub.recoveryCursor;
    const next: StoredWebhookSubscription = {
      ...sub,
      gapMessageId,
      gapAttempt: { cursor, attempts, nextAttemptAtMs: nowMs + retryDelay(attempts) },
    };
    yield* storage.upsertWebhookSubscription(next);

    const postResult = yield* sendSignedPinnedPost({
      url: sub.url,
      subscriptionId: sub.id,
      webhookId: gapMessageId,
      nowMs,
      secrets: activeSecrets(sub, nowMs),
      rawBody: JSON.stringify({ type: "gap", cursor }),
    });

    if (postResult.ok) {
      const { gapAttempt: _clearedAttempt, gapMessageId: _clearedId, ...withoutGapAttempt } = next;
      yield* storage.upsertWebhookSubscription({
        ...withoutGapAttempt,
        gapPending: false,
        safeWatermark: cursor,
      });
    } else {
      const exhausted = !postResult.retryable || attempts >= maxRetries + 1;
      yield* storage.upsertWebhookSubscription({
        ...next,
        // [R-836a57]: safeWatermark remains frozen and gapPending remains true!
        gapAttempt: {
          cursor,
          attempts: exhausted ? maxRetries + 1 : attempts,
          nextAttemptAtMs: clock() + retryDelay(attempts),
        },
      });
      if (exhausted) {
        reportState(sub.id, "gap_delivery_stalled");
      }
    }
  });

  const sweepSubscription = Effect.fnUntraced(function* (
    scope: PrincipalContext,
    snapshot: StoredWebhookSubscription,
    counters: { delivered: number; abandoned: number; terminated: number },
    tenantClient?: BugzillaClientEffect | null,
  ) {
    let sub = yield* storage.getWebhookSubscription(snapshot);
    const nowMs = clock();
    if (
      !sub?.verified ||
      sub.revoked ||
      sub.id !== snapshot.id ||
      (sub.refreshBefore !== null && nowMs > Date.parse(sub.refreshBefore))
    ) {
      return;
    }

    const grant = sub.grant ?? scope;
    const scopeHash = buildScopeHash(grant, sub.name, sub.args);
    const acquisitionBefore = sub.acquisitionCursor ?? sub.safeWatermark;
    if (acquisitionBefore === null) return;

    const items = yield* loadItems(sub.id);

    // Explicit cursor & schemaEpoch validation (no silent zombies!).
    const cursorCheck = yield* Effect.gen(function* () {
      const acq = yield* decodeCursorEffect(acquisitionBefore, scopeHash, schemaEpoch);
      if (sub!.safeWatermark !== null) {
        yield* decodeCursorEffect(sub!.safeWatermark, scopeHash, schemaEpoch);
      }
      if (sub!.recoveryCursor) {
        yield* decodeCursorEffect(sub!.recoveryCursor, scopeHash, schemaEpoch);
      }
      return acq;
    }).pipe(
      Effect.map((acq) => ({ ok: true as const, acq })),
      Effect.catch((err: McpDomainError) => Effect.succeed({ ok: false as const, err })),
    );

    if (!cursorCheck.ok) {
      if (isSchemaEpochMismatch(cursorCheck.err)) {
        yield* terminateSubscription(sub, items, {
          state: "schema_epoch_mismatch",
          errorCode: McpErrorCode.SEP_EVENTS_UNSUPPORTED,
          message: "Event schema epoch changed",
          data: { feature: "payloadSchema", reason: "schema_changed" },
        });
        counters.terminated += 1;
      } else {
        reportState(sub.id, "scan_incomplete");
      }
      return;
    }

    let acquisition = cursorCheck.acq;

    const runSweepBody = Effect.gen(function* () {
      if (
        grant.issuer !== sub!.issuer ||
        grant.principalId !== sub!.principalId ||
        grant.instanceUrl !== sub!.instanceUrl ||
        tenantClient === null
      ) {
        return yield* Effect.fail(eventAccessRevoked());
      }
      const ctx = yield* requireWebhookGrant(grant, scope);
      const client = tenantClient ?? (yield* requireClient(ctx));
      const safePrefixMs = nowMs - deps.lagWindowMs;
      const scan = yield* scanRange(
        ctx,
        sub!.name,
        sub!.args,
        acquisition.ts,
        safePrefixMs,
        client,
      ).pipe(
        Effect.catch((err) => {
          if (isRevoked(err)) return Effect.fail(err);
          return Effect.succeed({ scanComplete: false, items: [] as ScanEntry[] });
        }),
      );

      if (scan.scanComplete) {
        const existingIds = new Set(items.map((item) => item.eventId));
        for (const entry of scan.items) {
          if (
            existingIds.has(entry.eventId) ||
            comparePosition({ ts: entry.tsMs, tie: entry.tieKey }, acquisition) <= 0
          ) {
            continue;
          }
          const item = makePending(entry, nowMs);
          yield* saveItem(sub!.id, item);
          items.push(item);
        }
        const verified = { ...acquisition, ts: safePrefixMs, tie: END_OF_TIMESTAMP };
        if (comparePosition(verified, acquisition) > 0) {
          acquisition = verified;
          sub = { ...sub!, acquisitionCursor: encodeCursor(acquisition) };
          yield* storage.upsertWebhookSubscription(sub);
        }
        rememberPrefix(scopeHash, safePrefixMs);
      } else {
        reportState(sub!.id, "scan_incomplete");
      }

      items.sort((a, b) =>
        comparePosition({ ts: a.tsMs, tie: a.tieKey }, { ts: b.tsMs, tie: b.tieKey }),
      );
      let active = false;
      let visibilityIncomplete = false;

      for (const item of items) {
        if (item.outcome) continue;
        const due =
          item.inFlight || item.attempts >= maxRetries + 1 || item.nextAttemptAtMs <= clock();
        if (due && deps.revalidateWebhookGrant) {
          yield* requireWebhookGrant(grant, scope);
        }

        const visResult = yield* client
          .checkVisibility(item.occurrence.bugId, item.occurrence.commentId)
          .pipe(
            Effect.map((visibility) => ({ ok: true as const, visibility })),
            Effect.catch((err: BugzillaClientError) => {
              if (isRevoked(err)) {
                return Effect.fail(eventAccessRevoked());
              }
              return Effect.succeed({ ok: false as const });
            }),
          );

        if (!visResult.ok) {
          // Transient checkVisibility error -> scan_incomplete (never silent "idle").
          visibilityIncomplete = true;
          reportState(sub!.id, "scan_incomplete");
          continue;
        }
        if (visResult.visibility === "credential_revoked") {
          return yield* Effect.fail(eventAccessRevoked());
        }
        if (visResult.visibility === "restricted_or_missing") {
          item.outcome = "suppressed";
          yield* saveItem(sub!.id, item);
          continue;
        }

        active = true;
        if (scan.scanComplete && !visibilityIncomplete) {
          reportState(sub!.id, "active");
        }
        if (item.inFlight || item.attempts >= maxRetries + 1) {
          yield* settleAttempt(sub!, item);
        } else if (due) {
          yield* sendOccurrence(sub!, item);
        }
        const outcome = (item as PendingWebhookItem).outcome;
        if (outcome === "acknowledged") counters.delivered += 1;
        if (outcome === "abandoned") counters.abandoned += 1;
      }

      if (!active && scan.scanComplete && !visibilityIncomplete) {
        reportState(sub!.id, "idle");
      }

      const committed = yield* checkpoint(sub!, items, acquisition);
      if (
        scan.scanComplete &&
        !visibilityIncomplete &&
        committed.gapPending &&
        deps.eventsProfile === "sep-3415"
      ) {
        sub = committed;
        if (deps.revalidateWebhookGrant) {
          yield* requireWebhookGrant(grant, scope);
        }
        yield* sendGap(sub);
      }
    });

    yield* runSweepBody.pipe(
      Effect.catch((err) => {
        if (!isRevoked(err)) {
          return Effect.fail(err);
        }
        return terminateSubscription(sub!, items, {
          state: "authorization_revoked",
          errorCode: McpErrorCode.SEP_EVENTS_FORBIDDEN,
          message: "Events access revoked",
        }).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              counters.terminated += 1;
            }),
          ),
        );
      }),
    );
  });

  const poll: SyntheticEventsEngine["poll"] = Effect.fn("Events.poll")(function* (
    ctx: PrincipalContext,
    params: PollEventsParams,
  ): Effect.fn.Return<PollEventsResult, EventsEngineError> {
    const nowMs = clock();
    const safePrefixMs = nowMs - deps.lagWindowMs;
    const scopeHash = buildScopeHash(ctx, params.name, params.arguments);

    if (params.cursor === undefined || params.cursor === null) {
      const known = verifiedPrefixes.get(scopeHash);
      const client = yield* requireClient(ctx);
      if (known === undefined) {
        const initial = yield* scanRange(
          ctx,
          params.name,
          params.arguments,
          initialProbeFloorMs(safePrefixMs),
          safePrefixMs,
          client,
        );
        if (!initial.scanComplete) {
          return yield* Effect.fail(scanIncomplete());
        }
        rememberPrefix(scopeHash, safePrefixMs);
      } else {
        yield* checkCredential(client);
      }
      return {
        resultType: "complete" as const,
        events: [],
        cursor: encodeCursor({
          v: schemaEpoch,
          scope: scopeHash,
          ts: known ?? safePrefixMs,
          tie: END_OF_TIMESTAMP,
        }),
        truncated: false,
        hasMore: false,
        nextPollMs: 5_000,
      };
    }

    const decoded = yield* decodeCursorEffect(params.cursor, scopeHash, schemaEpoch);
    const replayFloorCandidates = [decoded.ts, nowMs - replayMs];
    if (params.maxAgeMs !== undefined) {
      replayFloorCandidates.push(nowMs - params.maxAgeMs);
    }
    const effectiveFloorMs = Math.max(...replayFloorCandidates);
    const truncated = effectiveFloorMs > decoded.ts;

    const client = yield* requireClient(ctx);
    const scan = yield* scanRange(
      ctx,
      params.name,
      params.arguments,
      effectiveFloorMs,
      safePrefixMs,
      client,
    );
    if (!scan.scanComplete) {
      return yield* Effect.fail(scanIncomplete());
    }

    const eligible: Array<{
      event: Omit<EventOccurrence, "cursor">;
      tsMs: number;
      tieKey: string;
    }> = [];

    for (const entry of scan.items) {
      const afterCursor = truncated
        ? entry.tsMs >= effectiveFloorMs
        : entry.tsMs > decoded.ts || (entry.tsMs === decoded.ts && entry.tieKey > decoded.tie);
      if (!afterCursor) continue;

      const vis = yield* client
        .checkVisibility(entry.occ.bugId, entry.occ.commentId)
        .pipe(
          Effect.mapError((err: BugzillaClientError) =>
            isRevoked(err) ? eventAccessRevoked() : scanIncomplete(),
          ),
        );
      if (vis === "credential_revoked") {
        return yield* Effect.fail(eventAccessRevoked());
      }
      if (vis !== "visible") continue;

      eligible.push({
        event: buildOccurrencePayload(entry.occ),
        tsMs: entry.tsMs,
        tieKey: entry.tieKey,
      });
    }

    const maxEvents = params.maxEvents ?? 50;
    const pageItems = eligible.slice(0, maxEvents);
    const hasMore = eligible.length > pageItems.length;

    let nextCursor: DecodedCursor;
    if (hasMore) {
      const last = pageItems[pageItems.length - 1];
      nextCursor = last
        ? { v: schemaEpoch, scope: scopeHash, ts: last.tsMs, tie: last.tieKey }
        : decoded;
    } else {
      nextCursor =
        safePrefixMs >= decoded.ts
          ? { v: schemaEpoch, scope: scopeHash, ts: safePrefixMs, tie: END_OF_TIMESTAMP }
          : decoded;
    }

    rememberPrefix(scopeHash, safePrefixMs);
    return {
      resultType: "complete" as const,
      events: pageItems.map((item) => item.event),
      cursor: encodeCursor(nextCursor),
      truncated,
      hasMore,
      nextPollMs: 5_000,
    };
  });

  const subscribeWebhook: SyntheticEventsEngine["subscribeWebhook"] = Effect.fn(
    "Events.subscribeWebhook",
  )(function* (
    ctx: PrincipalContext,
    params: WebhookSubscribeParams,
  ): Effect.fn.Return<WebhookSubscribeResult, EventsEngineError> {
    try {
      validateWebhookUrl(params.delivery.url);
    } catch (err) {
      return yield* Effect.fail(
        new McpDomainError(McpErrorCode.INVALID_PARAMS, (err as Error).message),
      );
    }
    const secretCheck = Schema.decodeUnknownResult(WebhookSecretSchema)(params.delivery.secret);
    if (Result.isFailure(secretCheck)) {
      return yield* Effect.fail(
        new McpDomainError(McpErrorCode.INVALID_PARAMS, "Invalid webhook secret format"),
      );
    }
    const rawSecretB64 = params.delivery.secret.slice("whsec_".length);
    const decodedSecret = Buffer.from(rawSecretB64, "base64");
    if (
      decodedSecret.byteLength < 24 ||
      decodedSecret.byteLength > 64 ||
      decodedSecret.toString("base64") !== rawSecretB64
    ) {
      return yield* Effect.fail(
        new McpDomainError(
          McpErrorCode.INVALID_PARAMS,
          "Webhook secret must be canonical base64 of 24-64 random bytes",
        ),
      );
    }

    const key = subscriptionKey(ctx, params.name, params.arguments, params.delivery.url);
    return yield* scheduler.serialize(
      serializationKey(key),
      Effect.gen(function* () {
        const nowMs = clock();
        const existing = yield* storage.getWebhookSubscription(key);
        const { live, startCursor, acquisitionCursor, truncated, clearedGapOnRefresh, acquired } =
          yield* prepareSubscription(ctx, params, existing, nowMs);
        const subId = live?.id ?? `sub_${randomBytes(16).toString("base64url")}`;

        if (!live) {
          const challenge = randomBytes(16).toString("base64url");
          const verifyWebhookId = `msg_verification_${randomBytes(12).toString("base64url")}`;
          const verifyBody = JSON.stringify({ type: "verification", challenge });
          const postResult = yield* sendSignedPinnedPost({
            url: params.delivery.url,
            subscriptionId: subId,
            webhookId: verifyWebhookId,
            secrets: [params.delivery.secret],
            rawBody: verifyBody,
            nowMs,
          });
          if (!postResult.ok) {
            return yield* Effect.fail(
              new McpDomainError(callbackErrorCode(), postResult.message, {
                reason: postResult.reason,
                ...(postResult.status !== undefined ? { status: postResult.status } : {}),
              }),
            );
          }
          let echoed: unknown;
          try {
            echoed = (JSON.parse(postResult.response.body) as { challenge?: unknown }).challenge;
          } catch {
            echoed = undefined;
          }
          if (typeof echoed !== "string") {
            return yield* Effect.fail(
              new McpDomainError(callbackErrorCode(), "Callback challenge failed", {
                reason: "challenge_failed",
              }),
            );
          }
          const a = Buffer.from(echoed, "utf8");
          const b = Buffer.from(challenge, "utf8");
          if (a.length !== b.length || !timingSafeEqual(a, b)) {
            return yield* Effect.fail(
              new McpDomainError(callbackErrorCode(), "Callback challenge mismatch", {
                reason: "challenge_failed",
              }),
            );
          }
        }

        const refreshBefore =
          params.ttlMs === null
            ? null
            : params.ttlMs === undefined && live
              ? live.refreshBefore
              : new Date(nowMs + (params.ttlMs ?? DEFAULT_REPLAY_MS)).toISOString();
        const rotated = live !== null && live.secret !== params.delivery.secret;

        // Blocker #1 ([R-836a57]): When a live refresh communicates a pending gap via
        // `{ cursor: recoveryCursor, truncated: true }`, advance safeWatermark = recoveryCursor
        // and clear gapPending = false (preserving lastGapCursor for older-cursor refreshes).
        const nextSafeWatermark = clearedGapOnRefresh
          ? startCursor
          : (live?.safeWatermark ?? startCursor);
        const nextGapPending = clearedGapOnRefresh ? false : (live?.gapPending ?? false);

        const baseLive = live ? { ...live } : undefined;
        if (baseLive && clearedGapOnRefresh) {
          delete (baseLive as { gapAttempt?: unknown }).gapAttempt;
          delete (baseLive as { gapMessageId?: unknown }).gapMessageId;
        }

        const updatedSub: StoredWebhookSubscription = {
          ...baseLive,
          ...key,
          id: subId,
          args: params.arguments,
          grant: storedGrant(ctx),
          secret: params.delivery.secret,
          ...(rotated
            ? { previousSecret: live!.secret, secretRotatedAt: new Date(nowMs).toISOString() }
            : {}),
          refreshBefore,
          verified: true,
          revoked: false,
          safeWatermark: nextSafeWatermark,
          recoveryCursor: startCursor,
          acquisitionCursor,
          gapPending: nextGapPending,
        };

        for (const entry of acquired) {
          yield* saveItem(subId, makePending(entry, nowMs));
        }
        yield* storage.upsertWebhookSubscription(updatedSub);

        if (!live && existing) {
          const staleItems = yield* loadItems(existing.id);
          for (const item of staleItems) {
            yield* deleteItem(existing.id, item.eventId);
          }
          scanStates.delete(existing.id);
          yield* scheduler.cancelSubscription(existing.id);
        }

        yield* scheduler.scheduleSweep(subId);
        return {
          resultType: "complete" as const,
          id: subId,
          refreshBefore,
          cursor: startCursor,
          truncated,
        };
      }),
    );
  });

  const unsubscribeWebhook: SyntheticEventsEngine["unsubscribeWebhook"] = Effect.fn(
    "Events.unsubscribeWebhook",
  )(function* (ctx, params) {
    const key = subscriptionKey(ctx, params.name, params.arguments, params.delivery.url);
    yield* scheduler.serialize(
      serializationKey(key),
      Effect.gen(function* () {
        const existing = yield* storage.getWebhookSubscription(key);
        if (!existing) return;
        yield* storage.deleteWebhookSubscription(key);
        scanStates.delete(existing.id);
        const items = yield* loadItems(existing.id);
        for (const item of items) {
          yield* deleteItem(existing.id, item.eventId);
        }
        yield* scheduler.cancelSubscription(existing.id);
      }),
    );
    return { resultType: "complete" as const };
  });

  const deliverPendingWebhooks: SyntheticEventsEngine["deliverPendingWebhooks"] = Effect.fn(
    "Events.deliverPendingWebhooks",
  )(function* (ctx) {
    const counters = { delivered: 0, abandoned: 0, terminated: 0 };
    const subscriptions = yield* storage.listWebhookSubscriptions(ctx);
    let tenantClient: BugzillaClientEffect | null | undefined;
    if (!deps.revalidateWebhookGrant) {
      const raw = yield* Effect.tryPromise({
        try: () => deps.resolveClient(ctx),
        catch: (err) =>
          new McpDomainError(
            McpErrorCode.INTERNAL_ERROR,
            err instanceof Error ? err.message : String(err),
          ),
      });
      tenantClient = raw ? asEffectBugzillaClient(raw) : null;
    }
    for (const sub of subscriptions) {
      yield* scheduler
        .serialize(serializationKey(sub), sweepSubscription(ctx, sub, counters, tenantClient))
        .pipe(
          Effect.catch(() =>
            Effect.sync(() => {
              reportState(sub.id, "scan_incomplete");
            }),
          ),
        );
    }
    return counters;
  });

  return SyntheticEventsTag.of({
    listEvents() {
      const delivery: ("poll" | "webhook")[] = [];
      if (deps.eventsProfile === "sep-3415") delivery.push("poll");
      if (deps.webhookEnabled ?? Boolean(deps.webhookTransport)) delivery.push("webhook");
      const payloadSchema = {
        type: "object",
        required: ["bugId", "product", "component", "actor", "untrustedUserContent"],
        properties: {
          bugId: { type: "integer", minimum: 1 },
          product: { type: "string" },
          component: { type: "string" },
          actor: { type: "string" },
          commentId: { type: "integer" },
          fieldsChanged: { type: "array", items: { type: "string" } },
          summaryText: { type: "string" },
          commentText: { type: "string" },
          untrustedUserContent: { const: true },
        },
      };
      return {
        profile: deps.eventsProfile,
        events: ALL_EVENTS.map((name) => ({
          name,
          delivery,
          inputSchema: eventFilterJsonSchema(name),
          payloadSchema,
        })),
      };
    },

    poll,

    // Unified stream() built on the same hardened poll() / auth / visibility pipeline.
    async *stream(ctx, params, signal): AsyncIterable<EventStreamFrame> {
      const heartbeatMs = params.heartbeatMs ?? 30_000;
      const pollParams = {
        name: params.name,
        arguments: params.arguments ?? { includeSelf: false },
        ...(params.cursor !== undefined ? { cursor: params.cursor } : {}),
        ...(params.maxAgeMs !== undefined ? { maxAgeMs: params.maxAgeMs } : {}),
      } as PollEventsParams;

      let activeEmitted = false;
      if (params.cursor !== undefined && params.cursor !== null) {
        const nowMs = clock();
        const scopeHash = buildScopeHash(ctx, params.name, pollParams.arguments);
        let decoded: Parameters<typeof encodeCursor>[0];
        try {
          decoded = await runCoreEffect(decodeCursorEffect(params.cursor, scopeHash, schemaEpoch));
        } catch (err) {
          if (isSchemaEpochMismatch(err)) {
            yield {
              method: "notifications/events/terminated",
              code: McpErrorCode.SEP_EVENTS_UNSUPPORTED,
              reason: "schema_changed",
            };
            return;
          }
          throw err;
        }
        const floorCandidates = [decoded.ts, nowMs - replayMs];
        if (params.maxAgeMs !== undefined) floorCandidates.push(nowMs - params.maxAgeMs);
        const effectiveFloorMs = Math.max(...floorCandidates);
        const truncated = effectiveFloorMs > decoded.ts;
        const activeCursor = encodeCursor({
          v: schemaEpoch,
          scope: scopeHash,
          ts: truncated ? effectiveFloorMs : decoded.ts,
          tie: truncated ? "" : decoded.tie,
        });
        if (signal?.aborted) return;
        yield {
          method: "notifications/events/active",
          cursor: activeCursor,
          truncated,
          heartbeatMs,
        };
        activeEmitted = true;
        if (signal?.aborted) return;
      }

      let result: PollEventsResult;
      try {
        result = await runCoreEffect(poll(ctx, pollParams));
      } catch (err) {
        if (isRevoked(err)) {
          yield {
            method: "notifications/events/terminated",
            code: McpErrorCode.SEP_EVENTS_FORBIDDEN,
            reason: "credential_revoked",
          };
          return;
        }
        if (isSchemaEpochMismatch(err)) {
          yield {
            method: "notifications/events/terminated",
            code: McpErrorCode.SEP_EVENTS_UNSUPPORTED,
            reason: "schema_changed",
          };
          return;
        }
        if (err instanceof McpDomainError && err.code === McpErrorCode.INVALID_PARAMS) {
          throw err;
        }
        yield {
          method: "notifications/events/error",
          message: err instanceof Error ? err.message : "Upstream scan incomplete",
        };
        return;
      }

      if (signal?.aborted) return;

      if (!activeEmitted) {
        yield {
          method: "notifications/events/active",
          cursor: params.cursor == null ? result.cursor : params.cursor,
          truncated: result.truncated,
          heartbeatMs,
        };
      }

      if (signal?.aborted) return;

      if (result.events.length === 0) {
        yield {
          method: "notifications/events/heartbeat",
          cursor: result.cursor,
        };
        return;
      }

      for (const evt of result.events) {
        if (signal?.aborted) return;
        yield {
          method: "notifications/events/event",
          occurrence: { ...evt, cursor: result.cursor },
        };
      }
    },

    subscribeWebhook,
    unsubscribeWebhook,
    deliverPendingWebhooks,
  });
}

export function makeSyntheticEventsLayer(deps: CoreDependencies): Layer.Layer<SyntheticEventsTag> {
  return Layer.succeed(SyntheticEventsTag, createSyntheticEventsEngine(deps));
}

export function buildSyntheticEventsService(deps: CoreDependencies): SyntheticEventsService {
  const engine = createSyntheticEventsEngine(deps);
  return {
    listEvents: () => engine.listEvents(),
    poll: (ctx, params) => runCoreEffect(engine.poll(ctx, params)),
    stream: (ctx, params, signal) => engine.stream(ctx, params, signal),
    subscribeWebhook: (ctx, params) => runCoreEffect(engine.subscribeWebhook(ctx, params)),
    unsubscribeWebhook: (ctx, params) => runCoreEffect(engine.unsubscribeWebhook(ctx, params)),
    deliverPendingWebhooks: (ctx) => runCoreEffect(engine.deliverPendingWebhooks(ctx)),
  };
}
