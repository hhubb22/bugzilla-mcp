import { randomBytes, timingSafeEqual } from "node:crypto";
import type { UpstreamBugzillaOccurrence } from "@bugzilla-mcp/bugzilla-client";
import {
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
  if (args?.bugIds && args.bugIds.length > 0 && !args.bugIds.includes(occ.bugId)) {
    return false;
  }
  if (args?.watchedFields && args.watchedFields.length > 0) {
    const changed = occ.fieldsChanged ?? [];
    if (!changed.some((field) => args.watchedFields!.includes(field))) {
      return false;
    }
  }
  if (args?.mentionMe && principalId) {
    const hay = `${occ.commentText ?? ""} ${occ.summaryText ?? ""}`.toLowerCase();
    if (!hay.includes(principalId.toLowerCase())) {
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

  // In-memory retry & terminal tracking keyed by subscription ID
  const retryQueues = new Map<string, Map<string, PendingWebhookItem>>();
  const abandonedEventIds = new Map<string, Set<string>>();

  function subKey(sub: Pick<StoredWebhookSubscription, "id">): string {
    return sub.id;
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
  ): Promise<{
    scanComplete: boolean;
    items: Array<{
      occ: UpstreamBugzillaOccurrence;
      tsMs: number;
      tieKey: string;
      eventId: string;
    }>;
  }> {
    const client = await deps.resolveClient(ctx);
    if (!client) {
      throw new McpDomainError(McpErrorCode.INVALID_PARAMS, "CredentialBindingRequired");
    }

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
        if (err instanceof Error && err.name === "BugzillaCredentialRevokedError") {
          throw new McpDomainError(McpErrorCode.SEP_EVENTS_FORBIDDEN, "Credential revoked");
        }
        throw err;
      }
      for (const occ of page.occurrences) {
        if (!matchesFilter(occ, name, args, ctx.principalId)) continue;
        const tsMs = Date.parse(occ.timestamp);
        if (!Number.isFinite(tsMs) || tsMs > upperBoundMs) continue;
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
        instanceUrl: ctx.instanceUrl,
        bugId: entry.occ.bugId,
        ...(entry.occ.commentId !== undefined ? { commentId: entry.occ.commentId } : {}),
        diffKey: entry.occ.changeKey,
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

  return {
    listEvents() {
      const delivery =
        deps.eventsProfile === "chatgpt-events"
          ? (["webhook"] as const)
          : (["poll", "push", "webhook"] as const);
      const inputSchema = {
        type: "object",
        properties: {
          product: { type: "string", minLength: 1 },
          component: { type: "string", minLength: 1 },
          bugIds: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: 100 },
          watchedFields: { type: "array", items: { type: "string" } },
          mentionMe: { type: "boolean" },
          requestee: { type: "string" },
          includeSelf: { type: "boolean", default: false },
        },
        additionalProperties: false,
      };
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
        events: ALL_EVENTS.map((name) => ({ name, delivery, inputSchema, payloadSchema })),
      };
    },

    async poll(ctx: PrincipalContext, params: PollEventsParams): Promise<PollEventsResult> {
      const nowMs = clock();
      const safePrefixMs = nowMs - deps.lagWindowMs;
      const scopeHash = buildScopeHash(ctx, params.name, params.arguments);

      if (params.cursor === undefined || params.cursor === null) {
        return {
          resultType: "complete",
          events: [],
          cursor: encodeCursor({ v: schemaEpoch, scope: scopeHash, ts: safePrefixMs, tie: "" }),
          truncated: false,
          hasMore: false,
          nextPollMs: 5_000,
        };
      }

      const decoded = decodeCursor(params.cursor, scopeHash, schemaEpoch);
      const replayFloorCandidates = [decoded.ts];
      if (params.maxAgeMs !== undefined) {
        replayFloorCandidates.push(nowMs - params.maxAgeMs);
      }
      if (deps.maxReplayWindowMs !== undefined) {
        replayFloorCandidates.push(nowMs - deps.maxReplayWindowMs);
      }
      const effectiveFloorMs = Math.max(...replayFloorCandidates);
      const truncated = effectiveFloorMs > decoded.ts;

      const scan = await scanRange(
        ctx,
        params.name,
        params.arguments,
        effectiveFloorMs,
        safePrefixMs,
      );
      if (!scan.scanComplete) {
        return {
          resultType: "complete",
          events: [],
          cursor: params.cursor,
          truncated: false,
          hasMore: false,
          nextPollMs: 5_000,
        };
      }

      const client = await deps.resolveClient(ctx);
      if (!client) {
        throw new McpDomainError(McpErrorCode.INVALID_PARAMS, "CredentialBindingRequired");
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

        const vis = await client.checkVisibility(entry.occ.bugId, entry.occ.commentId);
        if (vis === "credential_revoked") {
          throw new McpDomainError(McpErrorCode.SEP_EVENTS_FORBIDDEN, "Credential revoked");
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
        const last = pageItems[pageItems.length - 1];
        const nextTs = Math.max(
          decoded.ts,
          effectiveFloorMs,
          safePrefixMs,
          last?.tsMs ?? -Infinity,
        );
        const nextTie = last && last.tsMs >= nextTs ? last.tieKey : "";
        nextCursor = { v: schemaEpoch, scope: scopeHash, ts: nextTs, tie: nextTie };
      }

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

      const nowMs = clock();
      const safePrefixMs = nowMs - deps.lagWindowMs;
      const normArgs = normalizeArgsForCanonical(params.arguments);
      const canonicalArgsJson = canonicalJson(normArgs);
      const scopeHash = buildScopeHash(ctx, params.name, params.arguments);

      const existing = await deps.storage.getWebhookSubscription({
        issuer: ctx.issuer,
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
        url: params.delivery.url,
        name: params.name,
        canonicalArgsJson,
      });

      const subId = existing?.id ?? `sub_${randomBytes(12).toString("base64url")}`;
      let truncated = false;
      let startCursor: string;

      if (params.cursor !== undefined && params.cursor !== null) {
        const decoded = decodeCursor(params.cursor, scopeHash, schemaEpoch);
        const floorCandidates = [decoded.ts];
        if (params.maxAgeMs !== undefined) floorCandidates.push(nowMs - params.maxAgeMs);
        if (deps.maxReplayWindowMs !== undefined) {
          floorCandidates.push(nowMs - deps.maxReplayWindowMs);
        }
        const floorMs = Math.max(...floorCandidates);
        if (floorMs > decoded.ts) {
          truncated = true;
          startCursor = encodeCursor({ v: schemaEpoch, scope: scopeHash, ts: floorMs, tie: "" });
        } else {
          startCursor = params.cursor;
        }
      } else {
        startCursor =
          existing?.safeWatermark ??
          encodeCursor({ v: schemaEpoch, scope: scopeHash, ts: safePrefixMs, tie: "" });
      }

      if (!existing?.verified) {
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
          throw new McpDomainError(callbackErrorCode(), "Callback verification transport failure", {
            reason: "connection_refused",
          });
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
          : new Date(nowMs + (params.ttlMs ?? 24 * 60 * 60 * 1000)).toISOString();

      const rotated = existing && existing.secret !== params.delivery.secret;
      const reportTruncated =
        truncated || (deps.eventsProfile === "chatgpt-events" && Boolean(existing?.gapPending));
      const updatedSub: StoredWebhookSubscription = {
        id: subId,
        issuer: ctx.issuer,
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
        name: params.name,
        canonicalArgsJson,
        args: params.arguments,
        url: params.delivery.url,
        secret: params.delivery.secret,
        ...(rotated
          ? { previousSecret: existing.secret, secretRotatedAt: new Date(nowMs).toISOString() }
          : existing?.previousSecret !== undefined
            ? {
                previousSecret: existing.previousSecret,
                ...(existing.secretRotatedAt !== undefined
                  ? { secretRotatedAt: existing.secretRotatedAt }
                  : {}),
              }
            : {}),
        refreshBefore,
        verified: true,
        safeWatermark: startCursor,
        // ChatGPT surfaces pending gap via truncated: true on refresh; SEP keeps gapPending until signed gap ACK
        gapPending:
          deps.eventsProfile === "chatgpt-events"
            ? false
            : truncated || Boolean(existing?.gapPending),
      };

      await deps.storage.upsertWebhookSubscription(updatedSub);

      return {
        resultType: "complete",
        id: subId,
        refreshBefore,
        cursor: startCursor,
        truncated: reportTruncated,
      };
    },

    async unsubscribeWebhook(ctx, params) {
      const canonicalArgsJson = canonicalJson(normalizeArgsForCanonical(params.arguments));
      const deleted = await deps.storage.deleteWebhookSubscription({
        issuer: ctx.issuer,
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
        url: params.delivery.url,
        name: params.name,
        canonicalArgsJson,
      });
      if (!deleted && deps.eventsProfile === "sep-3415") {
        throw new McpDomainError(McpErrorCode.SEP_EVENTS_NOT_FOUND, "Subscription not found", {
          kind: "subscription",
        });
      }
      return { resultType: "complete" };
    },

    async deliverPendingWebhooks(ctx) {
      const nowMs = clock();
      const safePrefixMs = nowMs - deps.lagWindowMs;
      const subs = await deps.storage.listWebhookSubscriptions({
        issuer: ctx.issuer,
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
      });
      const client = await deps.resolveClient(ctx);

      let delivered = 0;
      let abandoned = 0;
      let terminated = 0;

      for (const sub of subs) {
        if (!sub.verified) continue;
        // Isolate subscriptions strictly to the active Bugzilla instance (EVENT-09)
        if (sub.instanceUrl !== ctx.instanceUrl) continue;
        // Enforce finite grant expiry before any outbound attempt (EVENT-08)
        if (sub.refreshBefore !== null && nowMs > Date.parse(sub.refreshBefore)) {
          continue;
        }
        const secrets = activeSecrets(sub, nowMs);
        const scopeHash = buildScopeHash(ctx, sub.name, sub.args);
        // Validate stored watermark BEFORE emitting any gap envelope or scanning so one invalid
        // subscription can never emit corrupt cursors or starve healthy subscriptions (ISO-03)
        let wm: DecodedCursor;
        try {
          wm =
            sub.safeWatermark !== null
              ? decodeCursor(sub.safeWatermark, scopeHash, schemaEpoch)
              : { v: schemaEpoch, scope: scopeHash, ts: safePrefixMs, tie: "" };
        } catch {
          continue;
        }
        let liveGapPending = sub.gapPending;

        // Emit pending SEP-3415 gap control envelope before event delivery (EVENT-11)
        if (liveGapPending && deps.eventsProfile === "sep-3415") {
          const gapCursor =
            sub.safeWatermark ??
            encodeCursor({ v: schemaEpoch, scope: scopeHash, ts: safePrefixMs, tie: "" });
          const gapBody = JSON.stringify({ type: "gap", cursor: gapCursor });
          let gapResp: WebhookPinnedResponse | null = null;
          try {
            gapResp = await sendSignedPinnedPost({
              url: sub.url,
              subscriptionId: sub.id,
              webhookId: `msg_gap_${randomBytes(12).toString("base64url")}`,
              secrets,
              rawBody: gapBody,
              nowMs,
            });
          } catch {
            gapResp = null;
          }
          if (gapResp && gapResp.status >= 200 && gapResp.status < 300) {
            liveGapPending = false;
            const freshSub = await deps.storage.getWebhookSubscription({
              issuer: sub.issuer,
              principalId: sub.principalId,
              instanceUrl: sub.instanceUrl,
              url: sub.url,
              name: sub.name,
              canonicalArgsJson: sub.canonicalArgsJson,
            });
            if (freshSub && freshSub.id === sub.id) {
              await deps.storage.upsertWebhookSubscription({ ...freshSub, gapPending: false });
            }
          }
        }

        if (!client) continue;

        const key = subKey(sub);
        let queue = retryQueues.get(key);
        if (!queue) {
          queue = new Map();
          retryQueues.set(key, queue);
          // Rehydrate durable retry queue across process restarts (EVENT-02, EVENT-05, EVENT-06)
          if (deps.storage.listWebhookRetryItems) {
            const persisted = await deps.storage.listWebhookRetryItems(key);
            for (const row of persisted) {
              try {
                const parsed = JSON.parse(row.payloadJson) as PendingWebhookItem;
                queue.set(row.eventId, {
                  ...parsed,
                  attempts: row.attempts,
                  nextAttemptAtMs: row.nextAttemptAtMs,
                });
              } catch {
                await deps.storage.deleteWebhookRetryItem?.(key, row.eventId);
              }
            }
          }
        }
        let abandonedSet = abandonedEventIds.get(key);
        if (!abandonedSet) {
          abandonedSet = new Set();
          abandonedEventIds.set(key, abandonedSet);
        }

        // Scan newly available occurrences since safeWatermark (propagating revocation -> terminate: REST-03)
        let scan: Awaited<ReturnType<typeof scanRange>>;
        try {
          scan = await scanRange(ctx, sub.name, sub.args, wm.ts, safePrefixMs);
        } catch (err) {
          if (err instanceof McpDomainError && err.code === McpErrorCode.SEP_EVENTS_FORBIDDEN) {
            terminated += 1;
            queue.clear();
            if (deps.eventsProfile === "sep-3415") {
              const termBody = JSON.stringify({
                type: "terminated",
                error: { code: McpErrorCode.SEP_EVENTS_FORBIDDEN, message: "Credential revoked" },
              });
              try {
                await sendSignedPinnedPost({
                  url: sub.url,
                  subscriptionId: sub.id,
                  webhookId: `msg_terminated_${randomBytes(12).toString("base64url")}`,
                  secrets,
                  rawBody: termBody,
                  nowMs,
                });
              } catch {
                // Best-effort termination envelope
              }
            }
            await deps.storage.deleteWebhookSubscription({
              issuer: sub.issuer,
              principalId: sub.principalId,
              instanceUrl: sub.instanceUrl,
              url: sub.url,
              name: sub.name,
              canonicalArgsJson: sub.canonicalArgsJson,
            });
            continue;
          }
          throw err;
        }
        if (scan.scanComplete) {
          for (const entry of scan.items) {
            const afterWm = entry.tsMs > wm.ts || (entry.tsMs === wm.ts && entry.tieKey > wm.tie);
            if (!afterWm) continue;
            if (queue.has(entry.eventId) || abandonedSet.has(entry.eventId)) continue;
            const webhookId =
              deps.eventsProfile === "chatgpt-events"
                ? entry.eventId
                : `msg_evt_${randomBytes(12).toString("base64url")}`;
            const newItem: PendingWebhookItem = {
              eventId: entry.eventId,
              webhookId,
              occurrence: entry.occ,
              tieKey: entry.tieKey,
              tsMs: entry.tsMs,
              attempts: 0,
              nextAttemptAtMs: nowMs,
            };
            queue.set(entry.eventId, newItem);
            // Persist stable delivery webhookId BEFORE the first outbound attempt (EVENT-03)
            await deps.storage.upsertWebhookRetryItem?.({
              subscriptionId: key,
              eventId: newItem.eventId,
              payloadJson: JSON.stringify(newItem),
              attempts: 0,
              nextAttemptAtMs: nowMs,
            });
          }
        }

        let subTerminated = false;
        let hasUnresolved = false;
        let contiguousCursorStr =
          sub.safeWatermark ??
          encodeCursor({ v: schemaEpoch, scope: scopeHash, ts: safePrefixMs, tie: "" });
        let highestProcessed: { ts: number; tie: string } | null = null;

        // Always iterate in canonical (tsMs, tieKey) event order so cursor never skips earlier retries (EVENT-02)
        const orderedQueue = Array.from(queue.values()).sort((a, b) => {
          if (a.tsMs !== b.tsMs) return a.tsMs - b.tsMs;
          return a.tieKey < b.tieKey ? -1 : a.tieKey > b.tieKey ? 1 : 0;
        });

        for (const item of orderedQueue) {
          // Enforce retry backoff while blocking cursor advancement past unresolved earlier item (EVENT-05)
          if (nowMs < item.nextAttemptAtMs) {
            hasUnresolved = true;
            continue;
          }
          // Re-verify per-occurrence visibility BEFORE every send or retry
          let vis: "visible" | "restricted_or_missing" | "credential_revoked";
          try {
            vis = await client.checkVisibility(item.occurrence.bugId, item.occurrence.commentId);
          } catch {
            hasUnresolved = true;
            continue;
          }
          if (vis === "credential_revoked") {
            subTerminated = true;
            terminated += 1;
            queue.clear();
            if (deps.eventsProfile === "sep-3415") {
              const termBody = JSON.stringify({
                type: "terminated",
                error: { code: McpErrorCode.SEP_EVENTS_FORBIDDEN, message: "Credential revoked" },
              });
              try {
                await sendSignedPinnedPost({
                  url: sub.url,
                  subscriptionId: sub.id,
                  webhookId: `msg_terminated_${randomBytes(12).toString("base64url")}`,
                  secrets,
                  rawBody: termBody,
                  nowMs,
                });
              } catch {
                // Best-effort termination envelope
              }
            }
            await deps.storage.deleteWebhookSubscription({
              issuer: sub.issuer,
              principalId: sub.principalId,
              instanceUrl: sub.instanceUrl,
              url: sub.url,
              name: sub.name,
              canonicalArgsJson: sub.canonicalArgsJson,
            });
            break;
          }
          if (vis !== "visible") {
            queue.delete(item.eventId);
            await deps.storage.deleteWebhookRetryItem?.(key, item.eventId);
            continue;
          }

          // Publish contiguous safe cursor ONLY when no earlier event is unresolved (EVENT-05)
          const itemCursor = encodeCursor({
            v: schemaEpoch,
            scope: scopeHash,
            ts: item.tsMs,
            tie: item.tieKey,
          });
          const bodyObj = {
            ...buildOccurrencePayload(item.occurrence),
            cursor: hasUnresolved ? contiguousCursorStr : itemCursor,
          };
          let rawBody = JSON.stringify(bodyObj);
          if (Buffer.byteLength(rawBody, "utf8") > MAX_WEBHOOK_BYTES) {
            // Re-trim data excerpt to guarantee final escaped JSON fits strictly <= 256 KiB (EVENT-15)
            const minimalObj = {
              eventId: bodyObj.eventId,
              name: bodyObj.name,
              timestamp: bodyObj.timestamp,
              data: {
                bugId: item.occurrence.bugId,
                product: item.occurrence.product,
                component: item.occurrence.component,
                excerptTruncated: true,
                untrustedUserContent: true,
              },
              cursor: bodyObj.cursor,
            };
            rawBody = JSON.stringify(minimalObj);
          }

          let resp: WebhookPinnedResponse | null = null;
          try {
            resp = await sendSignedPinnedPost({
              url: sub.url,
              subscriptionId: sub.id,
              webhookId: item.webhookId,
              secrets,
              rawBody,
              nowMs,
            });
          } catch {
            resp = null;
          }

          if (!resp) {
            // SSRF / DNS check or transport blocked — keep unresolved, do not advance watermark
            hasUnresolved = true;
            continue;
          }

          if (resp.status >= 200 && resp.status < 300) {
            queue.delete(item.eventId);
            await deps.storage.deleteWebhookRetryItem?.(key, item.eventId);
            delivered += 1;
            if (!hasUnresolved) {
              contiguousCursorStr = itemCursor;
              highestProcessed = { ts: item.tsMs, tie: item.tieKey };
            }
          } else if (resp.status === 410 || resp.status === 413) {
            // Terminal for this delivery: NEVER retry; immediately persist durable gapPending (EVENT-06)
            queue.delete(item.eventId);
            await deps.storage.deleteWebhookRetryItem?.(key, item.eventId);
            abandonedSet.add(item.eventId);
            abandoned += 1;
            liveGapPending = true;
            if (!hasUnresolved) {
              contiguousCursorStr = itemCursor;
              highestProcessed = { ts: item.tsMs, tie: item.tieKey };
            }
            const freshSub = await deps.storage.getWebhookSubscription({
              issuer: sub.issuer,
              principalId: sub.principalId,
              instanceUrl: sub.instanceUrl,
              url: sub.url,
              name: sub.name,
              canonicalArgsJson: sub.canonicalArgsJson,
            });
            if (freshSub && freshSub.id === sub.id) {
              await deps.storage.upsertWebhookSubscription({
                ...freshSub,
                safeWatermark: hasUnresolved ? freshSub.safeWatermark : contiguousCursorStr,
                gapPending: true,
              });
            }
          } else {
            item.attempts += 1;
            if (item.attempts >= maxRetries) {
              queue.delete(item.eventId);
              await deps.storage.deleteWebhookRetryItem?.(key, item.eventId);
              abandonedSet.add(item.eventId);
              abandoned += 1;
              liveGapPending = true;
              if (!hasUnresolved) {
                contiguousCursorStr = itemCursor;
                highestProcessed = { ts: item.tsMs, tie: item.tieKey };
              }
              const freshSub = await deps.storage.getWebhookSubscription({
                issuer: sub.issuer,
                principalId: sub.principalId,
                instanceUrl: sub.instanceUrl,
                url: sub.url,
                name: sub.name,
                canonicalArgsJson: sub.canonicalArgsJson,
              });
              if (freshSub && freshSub.id === sub.id) {
                await deps.storage.upsertWebhookSubscription({
                  ...freshSub,
                  safeWatermark: hasUnresolved ? freshSub.safeWatermark : contiguousCursorStr,
                  gapPending: true,
                });
              }
            } else {
              const backoffMs = Math.min(10_000, 1_000 * 2 ** (item.attempts - 1));
              item.nextAttemptAtMs = nowMs + backoffMs;
              await deps.storage.upsertWebhookRetryItem?.({
                subscriptionId: key,
                eventId: item.eventId,
                payloadJson: JSON.stringify(item),
                attempts: item.attempts,
                nextAttemptAtMs: item.nextAttemptAtMs,
              });
              hasUnresolved = true;
            }
          }
        }

        // Only advance watermark if scan was complete, no unresolved items remain, AND live subscription still exists (EVENT-07, EVENT-08)
        if (
          !subTerminated &&
          scan.scanComplete &&
          !hasUnresolved &&
          queue.size === 0 &&
          highestProcessed
        ) {
          const freshSub = await deps.storage.getWebhookSubscription({
            issuer: sub.issuer,
            principalId: sub.principalId,
            instanceUrl: sub.instanceUrl,
            url: sub.url,
            name: sub.name,
            canonicalArgsJson: sub.canonicalArgsJson,
          });
          if (freshSub && freshSub.id === sub.id) {
            const newWm = encodeCursor({
              v: schemaEpoch,
              scope: scopeHash,
              ts: Math.max(highestProcessed.ts, safePrefixMs),
              tie: highestProcessed.ts >= safePrefixMs ? highestProcessed.tie : "",
            });
            await deps.storage.upsertWebhookSubscription({
              ...freshSub,
              safeWatermark: newWm,
              gapPending: freshSub.gapPending || liveGapPending,
            });
          }
        }
      }

      return { delivered, abandoned, terminated };
    },
  };
}
