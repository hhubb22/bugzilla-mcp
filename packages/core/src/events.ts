import { randomBytes, timingSafeEqual } from "node:crypto";
import type { BugzillaClient, UpstreamBugzillaOccurrence } from "@bugzilla-mcp/bugzilla-client";
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
import type { StoredWebhookSubscription } from "@bugzilla-mcp/storage";
import {
  canonicalJson,
  McpDomainError,
  normalizeArgsForCanonical,
  sha256Hex,
} from "./canonical.js";
import type {
  CoreDependencies,
  EventStreamFrame,
  SyntheticEventsService,
  WebhookPinnedResponse,
  WebhookScanState,
} from "./index.js";
import { selectValidatedPublicIp, signStandardWebhook, validateWebhookUrl } from "./ssrf.js";

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
  // Avoid splitting a multi-byte UTF-8 character
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

const MAX_JS_DATE_MS = 8_640_000_000_000_000;

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

function scanIncomplete() {
  return new McpDomainError(McpErrorCode.INTERNAL_ERROR, "Upstream scan incomplete", {
    reason: "scan_incomplete",
  });
}

function eventAccessRevoked() {
  return new McpDomainError(McpErrorCode.SEP_EVENTS_FORBIDDEN, "Events access revoked");
}

function isRevoked(error: unknown) {
  return (
    (error instanceof McpDomainError && error.code === McpErrorCode.SEP_EVENTS_FORBIDDEN) ||
    (error instanceof Error && error.name === "BugzillaCredentialRevokedError")
  );
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
  if (watched && !occ.fieldsChanged?.some((field) => watched.includes(field))) {
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

export function buildSyntheticEventsService(deps: CoreDependencies): SyntheticEventsService {
  const clock = deps.clock ?? (() => Date.now());
  const schemaEpoch = deps.eventSchemaEpoch ?? 1;
  const maxRetries = deps.maxWebhookRetries ?? 3;
  const rotationGraceMs = deps.secretRotationGraceMs ?? 300_000;
  const replayMs = deps.maxReplayWindowMs ?? DEFAULT_REPLAY_MS;
  const verifiedPrefixes = new Map<string, number>();

  function rememberPrefix(scope: string, time: number) {
    const previous = verifiedPrefixes.get(scope) ?? -Infinity;
    if (time <= previous) return;
    // This cache is only an optimization. A miss performs the verified first scan.
    if (!verifiedPrefixes.has(scope) && verifiedPrefixes.size >= 1024) {
      const oldest = verifiedPrefixes.keys().next().value;
      if (oldest !== undefined) verifiedPrefixes.delete(oldest);
    }
    verifiedPrefixes.set(scope, time);
  }

  async function requireClient(ctx: PrincipalContext) {
    if (!ctx.scopes.includes("bz:events")) throw eventAccessRevoked();
    const client = await deps.resolveClient(ctx);
    if (!client) throw eventAccessRevoked();
    return client;
  }

  async function checkCredential(client: BugzillaClient) {
    try {
      return await client.probeCapabilities();
    } catch (error) {
      if (isRevoked(error)) throw eventAccessRevoked();
      throw scanIncomplete();
    }
  }

  const inMemoryQueues = new Map<string, Map<string, PendingWebhookItem>>();
  const scanStates = new Map<string, WebhookScanState>();
  const operations = new Map<string, Promise<void>>();

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

  async function serialize<T>(key: SubscriptionKey, task: () => Promise<T>): Promise<T> {
    const id = JSON.stringify([
      key.issuer,
      key.principalId,
      key.instanceUrl,
      key.url,
      key.name,
      key.canonicalArgsJson,
    ]);
    const previous = operations.get(id);
    const work = (previous ?? Promise.resolve()).then(task);
    const completion = work.then(
      () => {},
      () => {},
    );
    operations.set(id, completion);
    try {
      return await work;
    } finally {
      if (operations.get(id) === completion) operations.delete(id);
    }
  }

  function reportState(id: string, state: WebhookScanState) {
    if (scanStates.get(id) === state) return;
    scanStates.set(id, state);
    deps.onWebhookScanState?.(id, state);
  }

  async function saveItem(subscriptionId: string, item: PendingWebhookItem) {
    if (deps.storage.upsertWebhookRetryItem) {
      await deps.storage.upsertWebhookRetryItem({
        subscriptionId,
        eventId: item.eventId,
        payloadJson: JSON.stringify(item),
        attempts: item.attempts,
        nextAttemptAtMs: item.nextAttemptAtMs,
      });
      return;
    }
    const items = inMemoryQueues.get(subscriptionId) ?? new Map<string, PendingWebhookItem>();
    items.set(item.eventId, item);
    inMemoryQueues.set(subscriptionId, items);
  }

  async function loadItems(subscriptionId: string): Promise<PendingWebhookItem[]> {
    if (!deps.storage.listWebhookRetryItems)
      return [...(inMemoryQueues.get(subscriptionId)?.values() ?? [])];
    const rows = await deps.storage.listWebhookRetryItems(subscriptionId);
    return rows.map((row) => ({
      ...(JSON.parse(row.payloadJson) as PendingWebhookItem),
      attempts: row.attempts,
      nextAttemptAtMs: row.nextAttemptAtMs,
    }));
  }

  async function deleteItem(subscriptionId: string, eventId: string) {
    if (deps.storage.deleteWebhookRetryItem)
      return deps.storage.deleteWebhookRetryItem(subscriptionId, eventId);
    const remaining = inMemoryQueues.get(subscriptionId);
    remaining?.delete(eventId);
    if (remaining?.size === 0) inMemoryQueues.delete(subscriptionId);
  }

  function storedGrant(ctx: PrincipalContext): PrincipalContext {
    return {
      issuer: ctx.issuer,
      principalId: ctx.principalId,
      instanceUrl: ctx.instanceUrl,
      clientId: ctx.clientId,
      credentialGeneration: ctx.credentialGeneration,
      scopes: ctx.scopes,
      deploymentMode: ctx.deploymentMode,
    };
  }

  async function requireWebhookGrant(grant: PrincipalContext, fallback: PrincipalContext) {
    const current = deps.revalidateWebhookGrant
      ? await deps.revalidateWebhookGrant(grant)
      : fallback;
    if (
      !current ||
      current.issuer !== grant.issuer ||
      current.principalId !== grant.principalId ||
      current.instanceUrl !== grant.instanceUrl ||
      current.credentialGeneration !== grant.credentialGeneration ||
      !current.scopes.includes("bz:events")
    ) {
      throw eventAccessRevoked();
    }
    return current;
  }

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

  async function scanRange(
    ctx: PrincipalContext,
    name: EventName,
    args: EventFilterArgs | undefined,
    sinceMs: number,
    upperBoundMs: number,
    resolvedClient?: BugzillaClient,
  ): Promise<{
    scanComplete: boolean;
    items: Array<{
      occ: UpstreamBugzillaOccurrence;
      tsMs: number;
      tieKey: string;
      eventId: string;
    }>;
  }> {
    const client = resolvedClient ?? (await requireClient(ctx));
    const identity =
      args?.mentionMe || args?.requestee?.toLowerCase() === "me"
        ? (await checkCredential(client)).authenticatedUser
        : undefined;

    const dedup = new Map<
      string,
      { occ: UpstreamBugzillaOccurrence; tsMs: number; tieKey: string; eventId: string }
    >();
    let offset = 0;
    const pageSize = 100;
    let complete = false;

    for (let guard = 0; guard < 100; guard += 1) {
      let page: Awaited<ReturnType<typeof client.listChangesSince>>;
      try {
        page = await client.listChangesSince({
          since: new Date(sinceMs).toISOString(),
          limit: pageSize,
          offset,
        });
      } catch (err) {
        if (isRevoked(err)) throw eventAccessRevoked();
        return { scanComplete: false, items: [] };
      }
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

    if (!complete) return { scanComplete: false, items: [] };
    const items = [...dedup.values()].sort((a, b) => {
      if (a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
      return a.tieKey < b.tieKey ? -1 : a.tieKey > b.tieKey ? 1 : 0;
    });

    const includeSelf = args?.includeSelf ?? false;
    if (includeSelf) {
      return { scanComplete: complete, items };
    }

    const filtered: typeof items = [];
    for (const entry of items) {
      const isSelf = await deps.storage.hasSelfWrite({
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
  }

  async function sendSignedPinnedPost(params: {
    url: string;
    subscriptionId: string;
    webhookId: string;
    secrets: readonly string[];
    rawBody: string;
    nowMs: number;
  }): Promise<WebhookPinnedResponse | null> {
    if (!deps.webhookTransport) {
      throw new McpDomainError(McpErrorCode.INTERNAL_ERROR, "Webhook transport is not configured");
    }
    const parsedUrl = validateWebhookUrl(params.url);
    if (Buffer.byteLength(params.rawBody, "utf8") > MAX_WEBHOOK_BYTES) {
      throw new McpDomainError(
        McpErrorCode.INVALID_PARAMS,
        "Serialized webhook envelope exceeds 256 KiB",
      );
    }
    const addresses = await deps.webhookTransport.resolveHost(parsedUrl.hostname);
    const pinnedIp = selectValidatedPublicIp(addresses);
    if (!pinnedIp) {
      return null;
    }
    const timestampSec = String(Math.floor(params.nowMs / 1000));
    const signature = signStandardWebhook(
      params.secrets,
      params.webhookId,
      timestampSec,
      params.rawBody,
    );
    return deps.webhookTransport.postPinned({
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
    });
  }

  function callbackErrorCode(): number {
    return deps.eventsProfile === "chatgpt-events"
      ? McpErrorCode.CHATGPT_EVENTS_CALLBACK_ERROR
      : McpErrorCode.SEP_EVENTS_CALLBACK_ERROR;
  }

  function makePending(
    entry: Awaited<ReturnType<typeof scanRange>>["items"][number],
    nowMs: number,
  ): PendingWebhookItem {
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

  async function prepareSubscription(
    ctx: PrincipalContext,
    params: WebhookSubscribeParams,
    existing: StoredWebhookSubscription | null,
    nowMs: number,
  ) {
    const scopeHash = buildScopeHash(ctx, params.name, params.arguments);
    const requested =
      params.cursor == null ? undefined : decodeCursor(params.cursor, scopeHash, schemaEpoch);
    if (
      existing?.revoked ||
      (existing?.grant && existing.grant.credentialGeneration !== ctx.credentialGeneration)
    ) {
      throw eventAccessRevoked();
    }
    if (deps.revalidateWebhookGrant) await requireWebhookGrant(ctx, ctx);
    const client = await requireClient(ctx);
    if (
      existing?.verified &&
      existing.safeWatermark !== null &&
      (existing.refreshBefore === null || nowMs <= Date.parse(existing.refreshBefore))
    ) {
      await checkCredential(client);
      const gap = existing.lastGapCursor
        ? decodeCursor(existing.lastGapCursor, scopeHash, schemaEpoch)
        : undefined;
      return {
        live: existing,
        startCursor: existing.recoveryCursor ?? existing.safeWatermark,
        acquisitionCursor: existing.acquisitionCursor ?? existing.safeWatermark,
        truncated: gap && requested ? comparePosition(requested, gap) < 0 : existing.gapPending,
        acquired: [],
      };
    }

    const safePrefixMs = nowMs - deps.lagWindowMs;
    const known = verifiedPrefixes.get(scopeHash);
    const boundary: DecodedCursor = {
      v: schemaEpoch,
      scope: scopeHash,
      ts: safePrefixMs,
      tie: END_OF_TIMESTAMP,
    };
    if (!requested && known !== undefined) {
      await checkCredential(client);
      const cursor = encodeCursor({ ...boundary, ts: known });
      return {
        live: null,
        startCursor: cursor,
        acquisitionCursor: cursor,
        truncated: false,
        acquired: [],
      };
    }

    const floor = requested
      ? Math.max(requested.ts, nowMs - replayMs, nowMs - (params.maxAgeMs ?? Infinity))
      : Math.min(nowMs - replayMs, safePrefixMs);
    const truncated = requested !== undefined && floor > requested.ts;
    const scan = await scanRange(ctx, params.name, params.arguments, floor, safePrefixMs, client);
    if (!scan.scanComplete) throw scanIncomplete();
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
      acquired,
    };
  }

  function retryDelay(attempts: number): number {
    return Math.min(10_000, 1_000 * 2 ** (attempts - 1));
  }

  async function settleAttempt(
    sub: StoredWebhookSubscription,
    item: PendingWebhookItem,
    status?: number,
  ) {
    delete item.inFlight;
    if (status !== undefined && status >= 200 && status < 300) {
      item.outcome = "acknowledged";
    } else if (status === 410 || status === 413 || item.attempts >= maxRetries + 1) {
      item.outcome = "abandoned";
    } else {
      item.nextAttemptAtMs = clock() + retryDelay(item.attempts);
    }
    await saveItem(sub.id, item);
  }

  async function sendOccurrence(sub: StoredWebhookSubscription, item: PendingWebhookItem) {
    const nowMs = clock();
    const occurrence = buildOccurrencePayload(item.occurrence);
    // A normal envelope never claims that its own unacknowledged delivery, or
    // an earlier pending delivery or unannounced gap, can be skipped.
    const cursor = sub.safeWatermark;
    let body = JSON.stringify({ ...occurrence, cursor });
    if (Buffer.byteLength(body) > MAX_WEBHOOK_BYTES) {
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
    await saveItem(sub.id, item);
    const response = await sendSignedPinnedPost({
      url: sub.url,
      subscriptionId: sub.id,
      webhookId: item.webhookId,
      secrets: activeSecrets(sub, nowMs),
      rawBody: body,
      nowMs,
    }).catch(() => null);
    await settleAttempt(sub, item, response?.status);
  }

  async function revokeSubscription(sub: StoredWebhookSubscription, items: PendingWebhookItem[]) {
    // Persist the stop before any network or cleanup work so reopening SQLite
    // cannot resume a subscription whose authorization is known to be invalid.
    await deps.storage.upsertWebhookSubscription({ ...sub, revoked: true });
    reportState(sub.id, "authorization_revoked");
    for (const item of items) await deleteItem(sub.id, item.eventId);
    if (deps.eventsProfile !== "sep-3415") return;
    const nowMs = clock();
    await sendSignedPinnedPost({
      url: sub.url,
      subscriptionId: sub.id,
      webhookId: `msg_terminated_${randomBytes(16).toString("base64url")}`,
      secrets: activeSecrets(sub, nowMs),
      nowMs,
      rawBody: JSON.stringify({
        type: "terminated",
        error: { code: McpErrorCode.SEP_EVENTS_FORBIDDEN, message: "Events access revoked" },
      }),
    }).catch(() => null);
  }

  async function checkpoint(
    sub: StoredWebhookSubscription,
    ordered: PendingWebhookItem[],
    acquisition: DecodedCursor,
  ): Promise<StoredWebhookSubscription> {
    const recoveryBefore = sub.recoveryCursor ?? sub.safeWatermark;
    if (recoveryBefore === null) return sub;
    let recovery = decodeCursor(recoveryBefore, acquisition.scope, schemaEpoch);
    let latestGap = sub.lastGapCursor;
    let blocked = false;
    const settled: PendingWebhookItem[] = [];
    for (const item of ordered) {
      if (!item.outcome) {
        blocked = true;
        break;
      }
      settled.push(item);
      // A suppressed item is resolved for delivery, but its identifiers must
      // never become the tie-breaker of a cursor returned to the subscriber.
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
      await deps.storage.upsertWebhookSubscription(committed);
    }
    // Record the committed cursor and gap before forgetting settled items.
    for (const item of settled) await deleteItem(sub.id, item.eventId);
    return committed;
  }

  async function sendGap(sub: StoredWebhookSubscription) {
    if (deps.eventsProfile !== "sep-3415" || !sub.gapPending || !sub.recoveryCursor) return;
    const nowMs = clock();
    const prior = sub.gapAttempt;
    if (prior && (prior.attempts >= maxRetries + 1 || prior.nextAttemptAtMs > nowMs)) return;
    const gapMessageId = sub.gapMessageId ?? `msg_gap_${randomBytes(16).toString("base64url")}`;
    const attempts = (prior?.attempts ?? 0) + 1;
    const cursor = prior?.cursor ?? sub.recoveryCursor;
    const next = {
      ...sub,
      gapMessageId,
      gapAttempt: { cursor, attempts, nextAttemptAtMs: nowMs + retryDelay(attempts) },
    };
    await deps.storage.upsertWebhookSubscription(next);
    const response = await sendSignedPinnedPost({
      url: sub.url,
      subscriptionId: sub.id,
      webhookId: gapMessageId,
      nowMs,
      secrets: activeSecrets(sub, nowMs),
      rawBody: JSON.stringify({ type: "gap", cursor }),
    }).catch(() => null);
    if (response && response.status >= 200 && response.status < 300) {
      await deps.storage.upsertWebhookSubscription({
        ...next,
        gapPending: false,
        safeWatermark: cursor,
      });
    } else {
      await deps.storage.upsertWebhookSubscription({
        ...next,
        gapAttempt: {
          cursor,
          attempts:
            response?.status === 410 || response?.status === 413 ? maxRetries + 1 : attempts,
          nextAttemptAtMs: clock() + retryDelay(attempts),
        },
      });
    }
  }

  async function sweepSubscription(
    scope: PrincipalContext,
    snapshot: StoredWebhookSubscription,
    counters: { delivered: number; abandoned: number; terminated: number },
    tenantClient?: BugzillaClient | null,
  ) {
    let sub = await deps.storage.getWebhookSubscription(snapshot);
    const nowMs = clock();
    if (
      !sub?.verified ||
      sub.revoked ||
      sub.id !== snapshot.id ||
      (sub.refreshBefore !== null && nowMs > Date.parse(sub.refreshBefore))
    )
      return;
    const grant = sub.grant ?? scope;
    const scopeHash = buildScopeHash(grant, sub.name, sub.args);
    const acquisitionBefore = sub.acquisitionCursor ?? sub.safeWatermark;
    if (acquisitionBefore === null) return;
    let acquisition: DecodedCursor;
    try {
      // Invalid persisted cursors must not reach the network.
      acquisition = decodeCursor(acquisitionBefore, scopeHash, schemaEpoch);
      if (sub.safeWatermark !== null) decodeCursor(sub.safeWatermark, scopeHash, schemaEpoch);
      if (sub.recoveryCursor) decodeCursor(sub.recoveryCursor, scopeHash, schemaEpoch);
    } catch {
      return;
    }

    const items = await loadItems(sub.id);
    try {
      if (
        grant.issuer !== sub.issuer ||
        grant.principalId !== sub.principalId ||
        grant.instanceUrl !== sub.instanceUrl ||
        tenantClient === null
      ) {
        throw eventAccessRevoked();
      }
      const ctx = await requireWebhookGrant(grant, scope);
      const client = tenantClient ?? (await requireClient(ctx));
      const safePrefixMs = nowMs - deps.lagWindowMs;
      let scan: Awaited<ReturnType<typeof scanRange>>;
      try {
        scan = await scanRange(ctx, sub.name, sub.args, acquisition.ts, safePrefixMs, client);
      } catch (error) {
        if (isRevoked(error)) throw error;
        scan = { scanComplete: false, items: [] };
      }
      if (scan.scanComplete) {
        const existing = new Set(items.map((item) => item.eventId));
        for (const entry of scan.items) {
          if (
            existing.has(entry.eventId) ||
            comparePosition({ ts: entry.tsMs, tie: entry.tieKey }, acquisition) <= 0
          )
            continue;
          const item = makePending(entry, nowMs);
          await saveItem(sub.id, item);
          items.push(item);
        }
        const verified = { ...acquisition, ts: safePrefixMs, tie: END_OF_TIMESTAMP };
        if (comparePosition(verified, acquisition) > 0) {
          acquisition = verified;
          sub = { ...sub, acquisitionCursor: encodeCursor(acquisition) };
          await deps.storage.upsertWebhookSubscription(sub);
        }
        rememberPrefix(scopeHash, safePrefixMs);
      } else {
        reportState(sub.id, "scan_incomplete");
      }

      items.sort((a, b) =>
        comparePosition({ ts: a.tsMs, tie: a.tieKey }, { ts: b.tsMs, tie: b.tieKey }),
      );
      let active = false;
      for (const item of items) {
        if (item.outcome) continue;
        const due =
          item.inFlight || item.attempts >= maxRetries + 1 || item.nextAttemptAtMs <= clock();
        if (due && deps.revalidateWebhookGrant) await requireWebhookGrant(grant, scope);
        let visibility: Awaited<ReturnType<BugzillaClient["checkVisibility"]>>;
        try {
          visibility = await client.checkVisibility(
            item.occurrence.bugId,
            item.occurrence.commentId,
          );
        } catch (error) {
          if (isRevoked(error)) throw error;
          continue;
        }
        if (visibility === "credential_revoked") throw eventAccessRevoked();
        if (visibility === "restricted_or_missing") {
          item.outcome = "suppressed";
          await saveItem(sub.id, item);
          continue;
        }
        active = true;
        if (scan.scanComplete) reportState(sub.id, "active");
        if (item.inFlight || item.attempts >= maxRetries + 1) {
          await settleAttempt(sub, item);
        } else if (due) {
          await sendOccurrence(sub, item);
        }
        const outcome = (item as PendingWebhookItem).outcome;
        if (outcome === "acknowledged") counters.delivered += 1;
        if (outcome === "abandoned") counters.abandoned += 1;
      }
      if (!active && scan.scanComplete) reportState(sub.id, "idle");
      const committed = await checkpoint(sub, items, acquisition);
      if (scan.scanComplete && committed.gapPending && deps.eventsProfile === "sep-3415") {
        sub = committed;
        if (deps.revalidateWebhookGrant) await requireWebhookGrant(grant, scope);
        await sendGap(sub);
      }
    } catch (error) {
      if (!isRevoked(error)) throw error;
      await revokeSubscription(sub, items);
      counters.terminated += 1;
    }
  }

  return {
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

    async poll(ctx: PrincipalContext, params: PollEventsParams): Promise<PollEventsResult> {
      const nowMs = clock();
      const safePrefixMs = nowMs - deps.lagWindowMs;
      const scopeHash = buildScopeHash(ctx, params.name, params.arguments);

      if (params.cursor === undefined || params.cursor === null) {
        const known = verifiedPrefixes.get(scopeHash);
        const client = await requireClient(ctx);
        if (known === undefined) {
          const initial = await scanRange(
            ctx,
            params.name,
            params.arguments,
            Math.min(nowMs - replayMs, safePrefixMs),
            safePrefixMs,
            client,
          );
          if (!initial.scanComplete) throw scanIncomplete();
          rememberPrefix(scopeHash, safePrefixMs);
        } else {
          await checkCredential(client);
        }
        return {
          resultType: "complete",
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

      const decoded = decodeCursor(params.cursor, scopeHash, schemaEpoch);
      const replayFloorCandidates = [decoded.ts, nowMs - replayMs];
      if (params.maxAgeMs !== undefined) {
        replayFloorCandidates.push(nowMs - params.maxAgeMs);
      }
      const effectiveFloorMs = Math.max(...replayFloorCandidates);
      const truncated = effectiveFloorMs > decoded.ts;

      const client = await requireClient(ctx);
      const scan = await scanRange(
        ctx,
        params.name,
        params.arguments,
        effectiveFloorMs,
        safePrefixMs,
        client,
      );
      if (!scan.scanComplete) throw scanIncomplete();

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

        const vis = await client
          .checkVisibility(entry.occ.bugId, entry.occ.commentId)
          .catch((error: unknown) => {
            if (isRevoked(error)) throw eventAccessRevoked();
            throw scanIncomplete();
          });
        if (vis === "credential_revoked") throw eventAccessRevoked();
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
        resultType: "complete",
        events: pageItems.map((item) => item.event),
        cursor: encodeCursor(nextCursor),
        truncated,
        hasMore,
        nextPollMs: 5_000,
      };
    },

    async *stream(ctx, params, signal): AsyncIterable<EventStreamFrame> {
      const nowMs = clock();
      const safePrefixMs = nowMs - deps.lagWindowMs;
      const scopeHash = buildScopeHash(ctx, params.name, params.arguments);
      const heartbeatMs = params.heartbeatMs ?? 30_000;

      if (params.cursor === undefined || params.cursor === null) {
        yield {
          method: "notifications/events/active",
          cursor: encodeCursor({ v: schemaEpoch, scope: scopeHash, ts: safePrefixMs, tie: "" }),
          truncated: false,
          heartbeatMs,
        };
        if (!signal?.aborted) {
          yield {
            method: "notifications/events/heartbeat",
            cursor: encodeCursor({ v: schemaEpoch, scope: scopeHash, ts: safePrefixMs, tie: "" }),
          };
        }
        return;
      }

      const decoded = decodeCursor(params.cursor, scopeHash, schemaEpoch);
      const floorCandidates = [decoded.ts];
      if (params.maxAgeMs !== undefined) floorCandidates.push(nowMs - params.maxAgeMs);
      if (deps.maxReplayWindowMs !== undefined) {
        floorCandidates.push(nowMs - deps.maxReplayWindowMs);
      }
      const effectiveFloorMs = Math.max(...floorCandidates);
      const truncated = effectiveFloorMs > decoded.ts;

      const activeCursor = encodeCursor({
        v: schemaEpoch,
        scope: scopeHash,
        ts: truncated ? effectiveFloorMs : decoded.ts,
        tie: truncated ? "" : decoded.tie,
      });

      yield {
        method: "notifications/events/active",
        cursor: activeCursor,
        truncated,
        heartbeatMs,
      };

      if (signal?.aborted) return;

      const scan = await scanRange(
        ctx,
        params.name,
        params.arguments,
        effectiveFloorMs,
        safePrefixMs,
      );
      if (!scan.scanComplete) {
        yield { method: "notifications/events/error", message: "Upstream scan incomplete" };
        return;
      }

      const client = await deps.resolveClient(ctx);
      if (!client) {
        yield {
          method: "notifications/events/terminated",
          code: McpErrorCode.SEP_EVENTS_FORBIDDEN,
          reason: "credential_revoked",
        };
        return;
      }

      for (const entry of scan.items) {
        if (signal?.aborted) return;
        const afterCursor = truncated
          ? entry.tsMs >= effectiveFloorMs
          : entry.tsMs > decoded.ts || (entry.tsMs === decoded.ts && entry.tieKey > decoded.tie);
        if (!afterCursor) continue;

        const vis = await client.checkVisibility(entry.occ.bugId, entry.occ.commentId);
        if (vis === "credential_revoked") {
          yield {
            method: "notifications/events/terminated",
            code: McpErrorCode.SEP_EVENTS_FORBIDDEN,
            reason: "credential_revoked",
          };
          return;
        }
        if (vis !== "visible") continue;

        const occCursor = encodeCursor({
          v: schemaEpoch,
          scope: scopeHash,
          ts: entry.tsMs,
          tie: entry.tieKey,
        });
        yield {
          method: "notifications/events/event",
          occurrence: { ...buildOccurrencePayload(entry.occ), cursor: occCursor },
        };
      }
    },

    async subscribeWebhook(
      ctx: PrincipalContext,
      params: WebhookSubscribeParams,
    ): Promise<WebhookSubscribeResult> {
      try {
        validateWebhookUrl(params.delivery.url);
      } catch (err) {
        throw new McpDomainError(McpErrorCode.INVALID_PARAMS, (err as Error).message);
      }
      if (!WebhookSecretSchema.safeParse(params.delivery.secret).success) {
        throw new McpDomainError(McpErrorCode.INVALID_PARAMS, "Invalid webhook secret format");
      }
      const rawSecretB64 = params.delivery.secret.slice("whsec_".length);
      const decodedSecret = Buffer.from(rawSecretB64, "base64");
      if (
        decodedSecret.byteLength < 24 ||
        decodedSecret.byteLength > 64 ||
        decodedSecret.toString("base64") !== rawSecretB64
      ) {
        throw new McpDomainError(
          McpErrorCode.INVALID_PARAMS,
          "Webhook secret must be canonical base64 of 24-64 random bytes",
        );
      }

      const key = subscriptionKey(ctx, params.name, params.arguments, params.delivery.url);
      return serialize(key, async () => {
        const nowMs = clock();
        const existing = await deps.storage.getWebhookSubscription(key);
        const { live, startCursor, acquisitionCursor, truncated, acquired } =
          await prepareSubscription(ctx, params, existing, nowMs);
        const subId = live?.id ?? `sub_${randomBytes(16).toString("base64url")}`;

        if (!live) {
          const challenge = randomBytes(16).toString("base64url");
          const verifyWebhookId = `msg_verification_${randomBytes(12).toString("base64url")}`;
          const verifyBody = JSON.stringify({ type: "verification", challenge });
          let resp: WebhookPinnedResponse | null = null;
          try {
            resp = await sendSignedPinnedPost({
              url: params.delivery.url,
              subscriptionId: subId,
              webhookId: verifyWebhookId,
              secrets: [params.delivery.secret],
              rawBody: verifyBody,
              nowMs,
            });
          } catch {
            throw new McpDomainError(
              callbackErrorCode(),
              "Callback verification transport failure",
              {
                reason: "connection_refused",
              },
            );
          }
          if (!resp || resp.status < 200 || resp.status >= 300) {
            throw new McpDomainError(callbackErrorCode(), "Callback verification failed", {
              reason: !resp ? "connection_refused" : "http_5xx",
            });
          }
          let echoed: unknown;
          try {
            echoed = (JSON.parse(resp.body) as { challenge?: unknown }).challenge;
          } catch {
            echoed = undefined;
          }
          if (typeof echoed !== "string") {
            throw new McpDomainError(callbackErrorCode(), "Callback challenge failed", {
              reason: "challenge_failed",
            });
          }
          const a = Buffer.from(echoed, "utf8");
          const b = Buffer.from(challenge, "utf8");
          if (a.length !== b.length || !timingSafeEqual(a, b)) {
            throw new McpDomainError(callbackErrorCode(), "Callback challenge mismatch", {
              reason: "challenge_failed",
            });
          }
        }

        const refreshBefore =
          params.ttlMs === null
            ? null
            : params.ttlMs === undefined && live
              ? live.refreshBefore
              : new Date(nowMs + (params.ttlMs ?? DEFAULT_REPLAY_MS)).toISOString();
        const rotated = live && live.secret !== params.delivery.secret;
        const updatedSub: StoredWebhookSubscription = {
          ...live,
          ...key,
          id: subId,
          args: params.arguments,
          grant: storedGrant(ctx),
          secret: params.delivery.secret,
          ...(rotated
            ? { previousSecret: live.secret, secretRotatedAt: new Date(nowMs).toISOString() }
            : {}),
          refreshBefore,
          verified: true,
          safeWatermark: live?.safeWatermark ?? startCursor,
          recoveryCursor: startCursor,
          acquisitionCursor,
          gapPending: live?.gapPending ?? false,
        };
        // The verified replay is acquired once. Its original selection is not
        // re-evaluated against later mutable source fields during delivery.
        for (const entry of acquired) await saveItem(subId, makePending(entry, nowMs));
        await deps.storage.upsertWebhookSubscription(updatedSub);
        if (!live && existing) {
          for (const item of await loadItems(existing.id))
            await deleteItem(existing.id, item.eventId);
          scanStates.delete(existing.id);
        }
        return { resultType: "complete", id: subId, refreshBefore, cursor: startCursor, truncated };
      });
    },

    async unsubscribeWebhook(ctx, params) {
      const key = subscriptionKey(ctx, params.name, params.arguments, params.delivery.url);
      await serialize(key, async () => {
        const existing = await deps.storage.getWebhookSubscription(key);
        if (!existing) return;
        await deps.storage.deleteWebhookSubscription(key);
        scanStates.delete(existing.id);
        for (const item of await loadItems(existing.id))
          await deleteItem(existing.id, item.eventId);
      });
      return { resultType: "complete" };
    },

    async deliverPendingWebhooks(ctx) {
      const counters = { delivered: 0, abandoned: 0, terminated: 0 };
      const subscriptions = await deps.storage.listWebhookSubscriptions(ctx);
      // Embedded workers supply their own principal list. Keep resolver failures
      // visible to their per-principal error hook, even before a grant is stored.
      const client = deps.revalidateWebhookGrant ? undefined : await deps.resolveClient(ctx);
      for (const sub of subscriptions) {
        try {
          await serialize(sub, () => sweepSubscription(ctx, sub, counters, client));
        } catch {
          // A transient failure in one subscription must not starve another.
          reportState(sub.id, "scan_incomplete");
        }
      }
      return counters;
    },
  };
}
