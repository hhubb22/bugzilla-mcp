import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  BugzillaClient,
  UpstreamBugzillaOccurrence,
} from "../packages/bugzilla-client/src/index.js";
import type {
  EventOccurrence,
  PollEventsParams,
  PollEventsResult,
  WebhookSubscribeParams,
} from "../packages/contracts/src/index.js";
import { PollEventsResultSchema } from "../packages/contracts/src/index.js";
import { createSyntheticEventsService } from "../packages/core/src/index.js";
import type {
  CoreDependencies,
  WebhookOutboundTransport,
  WebhookPinnedRequest,
} from "../packages/core/src/index.js";
import { createSqliteStorage } from "../packages/storage/src/index.js";
import fc from "fast-check";
import { expect, test } from "vite-plus/test";
import {
  bugzilla,
  comment,
  dependencies,
  epoch,
  iso,
  manualClock,
  memoryStorage,
  principal,
} from "./helpers/fakes.js";
import { readPersistedState } from "./helpers/read-persisted-state.js";

const name = "bugzilla.bug.commented" as const;
const lag = 2_000;
const args = { includeSelf: false };
const poll = (overrides: Partial<PollEventsParams> = {}): PollEventsParams => ({
  name,
  arguments: args,
  ...overrides,
});

function fixture(overrides: Partial<CoreDependencies> = {}) {
  const clock = manualClock();
  const rows: Array<{ occurrence: UpstreamBugzillaOccurrence; visibleAt: number }> = [];
  const visibility = new Map<number, Awaited<ReturnType<BugzillaClient["checkVisibility"]>>>();
  let complete = true;
  const { client } = bugzilla({
    async listChangesSince({ since, offset, limit }) {
      const available = rows.filter(
        ({ occurrence, visibleAt }) =>
          Date.parse(occurrence.timestamp) >= Date.parse(since) && visibleAt <= clock.now(),
      );
      return {
        occurrences: available.slice(offset, offset + limit).map(({ occurrence }) => occurrence),
        scanComplete: complete && offset + limit >= available.length,
      };
    },
    async checkVisibility(_, commentId) {
      return visibility.get(commentId ?? -1) ?? "visible";
    },
  });
  const deps = dependencies(client, {
    clock: clock.now,
    lagWindowMs: lag,
    storage: memoryStorage(clock.now),
    ...overrides,
  });
  return {
    clock,
    rows,
    visibility,
    deps,
    add: (occurrence: UpstreamBugzillaOccurrence, visibleAt = Date.parse(occurrence.timestamp)) =>
      rows.push({ occurrence, visibleAt }),
    setComplete: (value: boolean) => {
      complete = value;
    },
    create: () => createSyntheticEventsService(deps),
  };
}

function cursor(result: Pick<PollEventsResult, "cursor">) {
  expect(result.cursor).toEqual(expect.any(String));
  if (!result.cursor) throw new Error("Expected a resumable cursor");
  return result.cursor;
}

// EVIDENCE-OF: R-08abaf
// EVIDENCE-OF: R-d7d0a2
test.each([undefined, null])(
  "fresh cursor (%s) skips history and preserves commits that become visible inside the lag window",
  async (initial) => {
    const env = fixture();
    env.add(comment(1, iso(epoch - lag - 1_000)));
    env.add(comment(2, iso(epoch - 1_000)), epoch + 1_000);
    const service = env.create();
    const start = await service.poll(
      principal,
      initial === undefined ? poll() : poll({ cursor: initial }),
    );
    expect(start).toMatchObject({
      resultType: "complete",
      events: [],
      truncated: false,
      hasMore: false,
    });
    env.clock.advance(lag + 1_000);
    const page = await service.poll(principal, poll({ cursor: cursor(start) }));
    expect(page.events.map((event) => event.timestamp)).toEqual([iso(epoch - 1_000)]);
    expect(page).toMatchObject({ truncated: false, hasMore: false });
    env.clock.advance(lag);
    const quiet = await service.poll(principal, poll({ cursor: cursor(page) }));
    expect(quiet).toMatchObject({ events: [], truncated: false, hasMore: false });
    expect(quiet.cursor).not.toEqual(page.cursor);
    expect(quiet.nextPollMs).toBeGreaterThanOrEqual(1_000);
  },
);

// EVIDENCE-OF: R-d7d0a2
test("an incomplete scan cannot skip a subsequently visible occurrence at its resume boundary", async () => {
  const env = fixture();
  const service = env.create();
  const start = cursor(await service.poll(principal, poll()));
  env.clock.advance(10_000);
  env.setComplete(false);
  const partial = await service.poll(principal, poll({ cursor: start })).catch((error: unknown) => {
    if (String(error).includes("C0_CONTRACT_STUB")) throw error;
    return null;
  });
  const safe = partial ? cursor(partial) : start;
  expect(safe).toBe(start);
  env.add(comment(3, iso(epoch + 1_000)));
  env.setComplete(true);
  expect(
    (await service.poll(principal, poll({ cursor: safe }))).events.map((event) => event.timestamp),
  ).toEqual([iso(epoch + 1_000)]);
});

// EVIDENCE-OF: R-d7d0a2
test("generated timestamp buckets page exactly once and agree under reversed scans with overlap", async () => {
  const generated = fc.uniqueArray(
    fc.record({
      id: fc.integer({ min: 11, max: 9_999 }),
      second: fc.integer({ min: 1, max: 4 }),
    }),
    { selector: ({ id }) => id, minLength: 5, maxLength: 14 },
  );
  await fc.assert(
    fc.asyncProperty(generated, fc.integer({ min: 1, max: 4 }), async (rows, maxEvents) => {
      const env = fixture();
      const service = env.create();
      const start = cursor(await service.poll(principal, poll()));
      const occurrences = rows.map(({ id, second }) => comment(id, iso(epoch + second * 1_000)));
      for (const occurrence of [...occurrences, ...occurrences.slice(0, 2)]) env.add(occurrence);
      env.clock.advance(10_000);

      const expectedTimes = occurrences.map(({ timestamp }) => timestamp).sort();
      const actual: EventOccurrence[] = [];
      let resume = start;
      while (actual.length < expectedTimes.length) {
        const page = await service.poll(principal, poll({ cursor: resume, maxEvents }));
        expect(PollEventsResultSchema.safeParse(page).success).toBe(true);
        expect(page.events.map((event) => event.timestamp)).toEqual(
          expectedTimes.slice(actual.length, actual.length + maxEvents),
        );
        for (const occurrence of page.events) expect(occurrence).not.toHaveProperty("cursor");
        actual.push(...page.events);
        expect(page).toMatchObject({
          hasMore: actual.length < expectedTimes.length,
          truncated: false,
        });
        resume = cursor(page);
      }
      expect(new Set(actual.map((event) => event.eventId)).size).toBe(rows.length);
      expect((await service.poll(principal, poll({ cursor: resume }))).events).toEqual([]);
      env.rows.reverse();
      const replay = await env.create().poll(principal, poll({ cursor: start, maxEvents: 100 }));
      expect(replay.events).toEqual(actual);
      expect(replay).toMatchObject({ hasMore: false, truncated: false });
    }),
    { seed: 7202, numRuns: 30 },
  );
});

// EVIDENCE-OF: R-d7d0a2
test.each(["maxAgeMs", "configured replay window"])(
  "old cursors report truncation at the %s boundary",
  async (boundary) => {
    const env = fixture(
      boundary === "configured replay window" ? { maxReplayWindowMs: 10_000 } : {},
    );
    const service = env.create();
    const start = cursor(await service.poll(principal, poll()));
    env.add(comment(20, iso(epoch + 1_000)));
    env.add(comment(21, iso(epoch + 55_000)));
    env.clock.advance(60_000);
    const response = await service.poll(
      principal,
      poll({ cursor: start, ...(boundary === "maxAgeMs" ? { maxAgeMs: 10_000 } : {}) }),
    );
    expect(response).toMatchObject({ truncated: true, hasMore: false });
    expect(response.events.map((event) => event.timestamp)).toEqual([iso(epoch + 55_000)]);
    expect(cursor(response)).not.toEqual(start);
  },
);

// EVIDENCE-OF: R-f03918
// EVIDENCE-OF: R-006bf9
test("only trusted self provenance and current per-comment visibility suppress same-second poll occurrences", async () => {
  const env = fixture();
  const service = env.create();
  const normal = cursor(await service.poll(principal, poll()));
  const includeSelf = { includeSelf: true };
  const all = cursor(await service.poll(principal, poll({ arguments: includeSelf })));
  const timestamp = iso(epoch + 1_000);
  const identicalText = "Human quotation of the automated analysis footer";
  await env.deps.storage.recordSelfWrite({
    instanceUrl: principal.instanceUrl,
    bugId: 41,
    commentId: 91,
  });
  await env.deps.storage.recordSelfWrite({
    instanceUrl: "https://another.example",
    bugId: 41,
    commentId: 92,
  });
  for (const id of [91, 92, 93])
    env.add(
      comment(id, timestamp, {
        actor: "alice@example.test",
        commentText: id === 93 ? "restricted-comment-marker" : identicalText,
      }),
    );
  env.visibility.set(93, "restricted_or_missing");
  env.clock.advance(8_000);
  const visible = await service.poll(principal, poll({ cursor: normal, maxEvents: 1 }));
  const selfIncluded = await service.poll(principal, poll({ cursor: all, arguments: includeSelf }));
  expect(visible.events).toHaveLength(1);
  expect(visible.hasMore).toBe(false);
  expect(selfIncluded.events).toHaveLength(2);
  expect(selfIncluded.events).toEqual(expect.arrayContaining(visible.events));
  expect(JSON.stringify(selfIncluded)).not.toContain("restricted-comment-marker");
  env.visibility.set(92, "restricted_or_missing");
  const revokedVisibility = await service.poll(principal, poll({ cursor: normal }));
  expect(revokedVisibility).toMatchObject({ events: [], hasMore: false });
});

// EVIDENCE-OF: R-08abaf
test("a new stream emits an active frame with a safe starting cursor before historical data", async () => {
  const env = fixture();
  env.add(comment(1, iso(epoch - 60_000)));
  const abort = new AbortController();
  const stream = env
    .create()
    .stream(principal, { name, cursor: null, heartbeatMs: 1_000 }, abort.signal)
    [Symbol.asyncIterator]();
  try {
    expect((await stream.next()).value).toMatchObject({
      method: "notifications/events/active",
      cursor: expect.any(String),
      truncated: false,
      heartbeatMs: expect.any(Number),
    });
  } finally {
    abort.abort();
    await stream.return?.();
  }
});

// EVIDENCE-OF: R-d7d0a2
// EVIDENCE-OF: R-f03918
test("a stream declares a truncated resume before terminating on revoked visibility", async () => {
  const env = fixture({ maxReplayWindowMs: 10_000 });
  const service = env.create();
  const start = cursor(await service.poll(principal, poll()));
  env.add(comment(85, iso(epoch + 55_000), { commentText: "revoked-stream-marker" }));
  env.visibility.set(85, "credential_revoked");
  env.clock.advance(60_000);
  const abort = new AbortController();
  const stream = service
    .stream(principal, { name, cursor: start, maxAgeMs: 10_000, heartbeatMs: 1_000 }, abort.signal)
    [Symbol.asyncIterator]();
  try {
    expect((await stream.next()).value).toMatchObject({
      method: "notifications/events/active",
      truncated: true,
      cursor: expect.any(String),
    });
    const next = await stream.next();
    expect(next.value).toMatchObject({
      method: "notifications/events/terminated",
      code: expect.any(Number),
    });
    expect(JSON.stringify(next)).not.toContain("revoked-stream-marker");
  } finally {
    abort.abort();
    await stream.return?.();
  }
});

const callback = "https://callback.example/bugzilla";
const secret = `whsec_${Buffer.alloc(32, 31).toString("base64")}`;
const rotatedSecret = `whsec_${Buffer.alloc(32, 97).toString("base64")}`;
const publicAddress = "1.1.1.1";
const subscribe = (overrides: Partial<WebhookSubscribeParams> = {}): WebhookSubscribeParams => ({
  name,
  arguments: args,
  delivery: { mode: "webhook", url: callback, secret },
  ttlMs: null,
  ...overrides,
});
const header = (request: WebhookPinnedRequest, name: string) =>
  Object.entries(request.headers).find(([key]) => key.toLowerCase() === name)?.[1];

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  const fields = Object.entries(value);
  const match = fields.find(([name]) => name === key);
  if (match) return match[1];
  for (const [, child] of fields) {
    const found = field(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function callbackSpy() {
  const requests: WebhookPinnedRequest[] = [];
  const outcomes: number[] = [];
  let addresses: readonly string[] = [publicAddress];
  const transport: WebhookOutboundTransport = {
    async resolveHost() {
      return addresses;
    },
    async postPinned(request) {
      requests.push(request);
      const challenge = field(JSON.parse(request.rawBody), "challenge");
      if (challenge !== undefined) return { status: 200, body: JSON.stringify({ challenge }) };
      return { status: outcomes.shift() ?? 204, body: "" };
    },
  };
  return {
    requests,
    outcomes,
    transport,
    setAddresses: (...values: string[]) => {
      addresses = values;
    },
    events: () =>
      requests.filter(
        (request) => typeof field(JSON.parse(request.rawBody), "eventId") === "string",
      ),
  };
}

function expectPinned(request: WebhookPinnedRequest) {
  expect(request).toMatchObject({
    url: callback,
    resolvedIp: publicAddress,
    hostHeader: "callback.example",
    tlsSni: "callback.example",
    followRedirects: false,
  });
}

function expectSignature(request: WebhookPinnedRequest, signingKey: string) {
  const id = header(request, "webhook-id");
  const timestamp = header(request, "webhook-timestamp");
  expect(id).toBeTruthy();
  expect(timestamp).toMatch(/^\d+$/);
  const digest = createHmac("sha256", Buffer.from(signingKey.slice("whsec_".length), "base64"))
    .update(`${id}.${timestamp}.${request.rawBody}`)
    .digest("base64");
  expect(header(request, "webhook-signature")?.split(/\s+/)).toContain(`v1,${digest}`);
}

// EVIDENCE-OF: R-81d5f2
test.each([null, 90 * 24 * 60 * 60 * 1000])(
  "a verified grant with ttlMs=%s survives in a fresh Bun process",
  async (ttlMs) => {
    const directory = await mkdtemp(join(tmpdir(), "bugzilla-webhooks-"));
    try {
      const dbPath = join(directory, "state.db");
      const receiver = callbackSpy();
      const env = fixture({
        webhookTransport: receiver.transport,
        storage: createSqliteStorage(dbPath),
      });
      const result = await env.create().subscribeWebhook(principal, subscribe({ ttlMs }));
      expect(result.refreshBefore).toEqual(ttlMs === null ? null : expect.any(String));
      expect(await readPersistedState("webhooks", dbPath)).toEqual([
        expect.objectContaining({
          id: result.id,
          verified: true,
          refreshBefore: result.refreshBefore,
        }),
      ]);
      const reopened = createSyntheticEventsService({
        ...env.deps,
        storage: createSqliteStorage(dbPath),
      });
      const refresh = await reopened.subscribeWebhook(
        principal,
        subscribe({ ttlMs, cursor: cursor(result) }),
      );
      expect(refresh.id).toBe(result.id);
      expect(await readPersistedState("webhooks", dbPath)).toEqual([
        expect.objectContaining({
          id: result.id,
          verified: true,
          refreshBefore: refresh.refreshBefore,
        }),
      ]);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);

// EVIDENCE-OF: R-08abaf
// EVIDENCE-OF: R-28f5c2
test("webhook challenge uses a pinned HTTPS connection and a fresh subscription starts after history", async () => {
  const receiver = callbackSpy();
  const env = fixture({ webhookTransport: receiver.transport });
  env.add(comment(1, iso(epoch - 60_000)));
  env.add(comment(2, iso(epoch - 1_000)), epoch + 1_000);
  const service = env.create();
  const sub = await service.subscribeWebhook(principal, subscribe({ cursor: null }));
  expect(sub).toMatchObject({ resultType: "complete", truncated: false, refreshBefore: null });
  cursor(sub);
  expect(receiver.requests).toHaveLength(1);
  const [challenge] = receiver.requests;
  if (!challenge) throw new Error("Expected initial verification");
  expectPinned(challenge);
  await service.deliverPendingWebhooks(principal);
  expect(receiver.events()).toEqual([]);
  env.clock.advance(5_000);
  await service.deliverPendingWebhooks(principal);
  expect(receiver.events()).toHaveLength(1);
  expect(field(JSON.parse(receiver.events()[0]?.rawBody ?? ""), "timestamp")).toBe(
    iso(epoch - 1_000),
  );
});

// EVIDENCE-OF: R-28f5c2
test.each([
  { label: "HTTP", url: "http://callback.example/bugzilla", addresses: [publicAddress] },
  { label: "mixed public and loopback", url: callback, addresses: [publicAddress, "127.0.0.1"] },
  { label: "IPv4-mapped nonpublic", url: callback, addresses: ["::ffff:192.168.0.20"] },
  { label: "IPv6 local", url: callback, addresses: ["::1"] },
])(
  "refuses $label before opening the synthetic callback connection",
  async ({ url, addresses }) => {
    const receiver = callbackSpy();
    receiver.setAddresses(...addresses);
    const service = fixture({ webhookTransport: receiver.transport }).create();
    await expect(
      service.subscribeWebhook(
        principal,
        subscribe({ delivery: { mode: "webhook", url, secret } }),
      ),
    ).rejects.toBeDefined();
    expect(receiver.requests).toEqual([]);
  },
);

// EVIDENCE-OF: R-28f5c2
test("a stale resume never sends a control callback to newly nonpublic DNS answers", async () => {
  const receiver = callbackSpy();
  const env = fixture({ webhookTransport: receiver.transport, maxReplayWindowMs: 10_000 });
  const service = env.create();
  const sub = await service.subscribeWebhook(principal, subscribe());
  const opened = receiver.requests.length;
  expect(opened).toBeGreaterThan(0);
  env.clock.advance(60_000);
  receiver.setAddresses(publicAddress, "::1");
  await service
    .subscribeWebhook(principal, subscribe({ cursor: cursor(sub) }))
    .catch((error: unknown) => {
      if (String(error).includes("C0_CONTRACT_STUB")) throw error;
    });
  await service.deliverPendingWebhooks(principal);
  expect(receiver.requests).toHaveLength(opened);
});

// EVIDENCE-OF: R-28f5c2
test.each([false, true])(
  "rechecks DNS after verification before the next connection (retry %s)",
  async (retry) => {
    const receiver = callbackSpy();
    const env = fixture({ webhookTransport: receiver.transport });
    const service = env.create();
    await service.subscribeWebhook(principal, subscribe());
    env.add(comment(19, iso(epoch + 1_000)));
    env.clock.advance(5_000);
    if (retry) {
      receiver.outcomes.push(503);
      await service.deliverPendingWebhooks(principal);
      expect(receiver.events()).toHaveLength(1);
      env.clock.advance(30_000);
    }
    const opened = receiver.requests.length;
    receiver.setAddresses(publicAddress, "::ffff:7f00:1");
    await service.deliverPendingWebhooks(principal);
    expect(receiver.requests).toHaveLength(opened);
  },
);

// EVIDENCE-OF: R-28f5c2
// EVIDENCE-OF: R-82de80
test("retries pin the current DNS answer and sign the exact bytes with stable delivery IDs", async () => {
  const receiver = callbackSpy();
  const env = fixture({ webhookTransport: receiver.transport, maxWebhookRetries: 5 });
  const service = env.create();
  const sub = await service.subscribeWebhook(principal, subscribe());
  env.add(comment(20, iso(epoch + 1_000), { commentText: "Byte-level fixture ✓" }));
  env.clock.advance(5_000);
  receiver.outcomes.push(503);
  await service.deliverPendingWebhooks(principal);
  expect(receiver.events()).toHaveLength(1);
  const newAddress = "8.8.8.8";
  receiver.setAddresses(newAddress);
  env.clock.advance(30_000);
  await service.deliverPendingWebhooks(principal);
  const [first, retry] = receiver.events();
  expect(receiver.events()).toHaveLength(2);
  if (!first || !retry) throw new Error("Expected a first attempt and one retry");
  const eventId = field(JSON.parse(first.rawBody), "eventId");
  const deliveryId = header(first, "webhook-id");
  expect(deliveryId).not.toEqual(eventId);
  expect(header(retry, "webhook-id")).toBe(deliveryId);
  expect(field(JSON.parse(retry.rawBody), "eventId")).toBe(eventId);
  expect(Number(header(retry, "webhook-timestamp"))).toBeGreaterThan(
    Number(header(first, "webhook-timestamp")),
  );
  expectPinned(first);
  expect(retry).toMatchObject({
    url: callback,
    resolvedIp: newAddress,
    hostHeader: "callback.example",
    tlsSni: "callback.example",
    followRedirects: false,
  });
  for (const attempt of [first, retry]) {
    expectSignature(attempt, secret);
    expect(header(attempt, "x-mcp-subscription-id")).toBe(sub.id);
  }
});

// EVIDENCE-OF: R-82de80
test.each([410, 413])(
  "terminal callback %s never retries or silently advances past undelivered history",
  async (status) => {
    const receiver = callbackSpy();
    const env = fixture({ webhookTransport: receiver.transport });
    const service = env.create();
    await service.subscribeWebhook(principal, subscribe());
    const missed = iso(epoch + 1_000);
    env.add(comment(30, missed));
    env.clock.advance(5_000);
    receiver.outcomes.push(status);
    await service.deliverPendingWebhooks(principal);
    expect(receiver.events()).toHaveLength(1);
    env.clock.advance(30_000);
    const restarted = env.create();
    await restarted.deliverPendingWebhooks(principal);
    expect(receiver.events()).toHaveLength(1);
    const persisted = await env.deps.storage.listWebhookSubscriptions({
      issuer: principal.issuer,
      principalId: principal.principalId,
      instanceUrl: principal.instanceUrl,
    });
    const gap = receiver.requests.find((request) => request.rawBody.includes('"gap"'));
    if (gap) expectSignature(gap, secret);
    if (status === 413) expect(persisted).toHaveLength(1);
    for (const current of persisted) {
      if (!current.gapPending && !gap) {
        const resume = cursor({ cursor: current.safeWatermark });
        const retained = await restarted.poll(principal, poll({ cursor: resume }));
        expect(retained.events.map((event) => event.timestamp)).toContain(missed);
      }
    }
  },
);

// EVIDENCE-OF: R-82de80
test("SEP envelopes are byte-bounded and delivery identifiers are independent across occurrences and subscriptions", async () => {
  const receiver = callbackSpy();
  const env = fixture({ webhookTransport: receiver.transport });
  const service = env.create();
  await service.subscribeWebhook(principal, subscribe());
  await service.subscribeWebhook(
    principal,
    subscribe({ arguments: { includeSelf: false, bugIds: [41] } }),
  );
  env.add(comment(40, iso(epoch + 1_000)));
  env.add(comment(41, iso(epoch + 2_000), { commentText: "界".repeat(100_000) }));
  env.clock.advance(8_000);
  await service.deliverPendingWebhooks(principal);
  const events = receiver.events();
  expect(events.length).toBeGreaterThanOrEqual(2);
  const identifiers = events.map((request) => header(request, "webhook-id"));
  expect(new Set(identifiers).size).toBe(events.length);
  for (const request of events) {
    const id = header(request, "webhook-id");
    expect(id).not.toBe(field(JSON.parse(request.rawBody), "eventId"));
    expect(Buffer.byteLength(request.rawBody, "utf8")).toBeLessThanOrEqual(256 * 1024);
    expectSignature(request, secret);
  }
});

// EVIDENCE-OF: R-f03918
test.each(["sep-3415", "chatgpt-events"] as const)(
  "rechecks restricted comments at retry and terminates revoked %s subscriptions",
  async (eventsProfile) => {
    const receiver = callbackSpy();
    const env = fixture({ webhookTransport: receiver.transport, eventsProfile });
    const service = env.create();
    await service.subscribeWebhook(principal, subscribe());
    env.add(comment(50, iso(epoch + 1_000)));
    env.add(comment(51, iso(epoch + 2_000), { commentText: "restricted-before-first-send" }));
    env.visibility.set(51, "restricted_or_missing");
    receiver.outcomes.push(503);
    env.clock.advance(6_000);
    await service.deliverPendingWebhooks(principal);
    expect(
      receiver.events().map((request) => field(JSON.parse(request.rawBody), "timestamp")),
    ).toEqual([iso(epoch + 1_000)]);
    env.visibility.set(50, "restricted_or_missing");
    env.clock.advance(30_000);
    await service.deliverPendingWebhooks(principal);
    expect(receiver.events()).toHaveLength(1);
    env.add(comment(52, iso(env.clock.now() + 1_000)));
    env.visibility.set(52, "credential_revoked");
    env.clock.advance(6_000);
    await service.deliverPendingWebhooks(principal);
    expect(receiver.events()).toHaveLength(1);
    const terminated = receiver.requests.filter((request) =>
      request.rawBody.includes('"terminated"'),
    );
    if (eventsProfile === "sep-3415") {
      expect(terminated).toHaveLength(1);
      for (const request of terminated) {
        expectPinned(request);
        expectSignature(request, secret);
      }
    } else {
      expect(terminated).toEqual([]);
    }
  },
);

// EVIDENCE-OF: R-cd4f75
// EVIDENCE-OF: R-82de80
// EVIDENCE-OF: R-28f5c2
test.each(["sep-3415", "chatgpt-events"] as const)(
  "%s exposes callback history loss through its own dialect",
  async (eventsProfile) => {
    const receiver = callbackSpy();
    const env = fixture({
      webhookTransport: receiver.transport,
      eventsProfile,
      maxReplayWindowMs: 10_000,
    });
    const service = env.create();
    expect(service.listEvents()).toMatchObject({ profile: eventsProfile });
    expect(
      service
        .listEvents()
        .events.map((event) => event.name)
        .sort(),
    ).toEqual([
      "bugzilla.bug.commented",
      "bugzilla.bug.created",
      "bugzilla.bug.updated",
      "bugzilla.flag.needinfo",
    ]);
    for (const event of service.listEvents().events) {
      expect([...event.delivery].sort()).toEqual(
        eventsProfile === "sep-3415" ? ["poll", "push", "webhook"] : ["webhook"],
      );
    }
    const sub = await service.subscribeWebhook(principal, subscribe());
    env.add(comment(60, iso(epoch + 1_000)));
    env.clock.advance(6_000);
    await service.deliverPendingWebhooks(principal);
    const [event] = receiver.events();
    if (!event) throw new Error("Expected a callback for the retained occurrence");
    if (eventsProfile === "chatgpt-events") {
      expect(header(event, "webhook-id")).toBe(field(JSON.parse(event.rawBody), "eventId"));
    }
    env.clock.advance(60_000);
    const refreshed = await service.subscribeWebhook(
      principal,
      subscribe({ cursor: cursor(sub), maxAgeMs: 10_000 }),
    );
    expect(refreshed).toMatchObject({ id: sub.id, truncated: true });
    await service.deliverPendingWebhooks(principal);
    const gaps = receiver.requests.filter((request) => request.rawBody.includes('"gap"'));
    if (eventsProfile === "sep-3415") {
      expect(gaps.length).toBeGreaterThan(0);
      for (const gap of gaps) {
        expectPinned(gap);
        expectSignature(gap, secret);
      }
    } else {
      expect(gaps).toEqual([]);
      expect(receiver.requests.some((request) => request.rawBody.includes('"terminated"'))).toBe(
        false,
      );
    }
  },
);

// EVIDENCE-OF: R-81d5f2
test("canonical refresh preserves identity and no-expiry verification and dual-signs during rotation", async () => {
  const receiver = callbackSpy();
  const env = fixture({ webhookTransport: receiver.transport, secretRotationGraceMs: 20_000 });
  const service = env.create();
  const filter = { product: "Browser", bugIds: [41], includeSelf: false };
  const sub = await service.subscribeWebhook(principal, subscribe({ arguments: filter }));
  const restarted = env.create();
  const refresh = await restarted.subscribeWebhook(
    principal,
    subscribe({
      arguments: { bugIds: [41], includeSelf: false, product: "Browser" },
      delivery: { mode: "webhook", url: callback, secret: rotatedSecret },
      cursor: cursor(sub),
    }),
  );
  expect(refresh).toMatchObject({ id: sub.id, refreshBefore: null });
  expect(
    await env.deps.storage.listWebhookSubscriptions({
      issuer: principal.issuer,
      principalId: principal.principalId,
      instanceUrl: principal.instanceUrl,
    }),
  ).toEqual([expect.objectContaining({ id: sub.id, verified: true, refreshBefore: null })]);
  env.add(comment(70, iso(epoch + 1_000)));
  env.clock.advance(5_000);
  await restarted.deliverPendingWebhooks(principal);
  const [duringGrace] = receiver.events();
  if (!duringGrace) throw new Error("Expected a delivery inside the rotation window");
  expectSignature(duringGrace, secret);
  expectSignature(duringGrace, rotatedSecret);
  env.add(comment(71, iso(epoch + 21_000)));
  env.clock.advance(25_000);
  await env.create().deliverPendingWebhooks(principal);
  const [, afterGrace] = receiver.events();
  if (!afterGrace) throw new Error("Expected a delivery after the rotation window");
  expectSignature(afterGrace, rotatedSecret);
  expect(header(afterGrace, "webhook-signature")?.split(/\s+/)).toHaveLength(1);
});
