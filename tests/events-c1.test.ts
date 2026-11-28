import { afterEach, expect, test } from "vite-plus/test";
import { createHmac, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createSqliteStorage } from "../packages/storage/src/index.js";
import { actor, apiKey, component, iso, product } from "./events-c1-bugzilla.js";
import {
  callback,
  commented,
  created,
  failure,
  needinfo,
  newSecret,
  obj,
  occurrence,
  Rig,
  rows,
  secret,
  str,
  subscribe,
  success,
  until,
  updated,
  type Caller,
  type Obj,
  type Send,
} from "./events-c1-harness.js";
import type { FixtureOptions } from "./events-c1-server.js";

let current: Rig | undefined;
async function setup(options: FixtureOptions, start = true) {
  const rig = new Rig(options);
  current = rig;
  await rig.open();
  if (start) await rig.start();
  return rig;
}
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});
const sep = "sep-3415";
const chat = "chatgpt-events";
const profiles = [sep, chat] as const;
const argsFor: Record<string, string[]> = {
  [created]: ["product", "component", "severity"],
  [updated]: ["product", "bugIds", "watchedFields"],
  [commented]: ["product", "bugIds", "mentionMe"],
  [needinfo]: ["product", "requestee"],
};
const scope = (r: Rig, tenant = "alice") => ({
  issuer: `https://${tenant}.example.test`,
  principalId: "operator",
  instanceUrl: r.bugzilla,
});
const store = (r: Rig) => createSqliteStorage(join(r.dir, "events.db"));
const ids = (poll: Obj) => rows(poll.events).map((e) => str(e.eventId));
const times = (poll: Obj) => rows(poll.events).map((e) => Date.parse(str(e.timestamp)));
const sendId = (s: Send) => str(s.headers.get("webhook-id"));
const eventId = (s: Send) => str(occurrence(s)?.eventId);
const sendTime = (s: Send) => Date.parse(str(occurrence(s)?.timestamp));

function deliveriesFor(r: Rig, id: unknown) {
  return r.events().filter((s) => s.headers.get("x-mcp-subscription-id") === id);
}

// scanRecoveryTest. Observe Incomplete at the failing Bugzilla detail read and
// the result of Complete -> Acked at the receiver and via cursor replay.
// EVIDENCE-OF: R-39bcf8, R-1006f2
test("a failed Webhook scan preserves the verified prefix and resumes without a gap", async () => {
  const r = await setup({ profile: sep, webhookEnabled: true });
  const bug = r.bz.addBug("critical", r.now - 6000);
  const params = subscribe(commented);
  const start = await sub(r, params);
  const id = str(start.id);
  const changeAt = r.now;
  r.bz.addComment(bug, "Comment recovered after the scan failure");
  r.bz.unreadableDetailsFor.add(bug.id);
  r.tick(2000);
  await until(
    () => expect(r.bz.failedDetails).toContain(bug.id),
    "Bugzilla rejected the required detail read",
  );
  const refresh = await sub(r, params, { cursor: start.cursor });
  expect(refresh).toMatchObject({ id, truncated: false });
  expect(r.events()).toEqual([]);
  r.bz.unreadableDetailsFor.clear();
  r.tick(1000);
  const [delivery] = await r.sent(1);
  expect(sendTime(delivery!)).toBe(changeAt);
  expect(ids(await r.poll(commented, {}, str(refresh.cursor)))).toEqual([eventId(delivery!)]);
  r.tick(1000);
  expect((await sub(r, params, { cursor: start.cursor })).truncated).toBe(false);
  expect(r.sends.some((s) => s.body.type === "gap")).toBe(false);
}, 90_000);

// EVIDENCE-OF: R-b9935c
test("HTTP stderr reports Webhook scan and authorization changes for the subscription", async () => {
  const r = await setup({ profile: sep, webhookEnabled: true });
  const url = callback + "/operator-log-canary";
  const subscription = await sub(r, subscribe(commented, {}, url), { ttlMs: 300_000 });
  const subscriptionId = str(subscription.id);

  function scanRecords() {
    const records: Obj[] = [];
    for (const line of r.stderr.split("\n").slice(0, -1)) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = obj(value);
      if (record.event === "mcp.events.scan" && record.subscriptionId === subscriptionId) {
        records.push(record);
      }
    }
    return records;
  }

  let observedRecords = 0;
  async function waitForState(state: string) {
    await advanceUntil(
      r,
      () => scanRecords().length > observedRecords,
      `stderr scan record for ${state}`,
    );
    expect(scanRecords()[observedRecords]?.state).toBe(state);
    observedRecords++;
  }

  await waitForState("idle");
  const bug = r.bz.addBug("normal", r.now - 6000);
  bug.summary = "operator-log-private-summary-canary";
  const comment = r.bz.addComment(bug, "operator-log-private-comment-canary");
  r.bz.unreadableDetailsFor.add(bug.id);
  await waitForState("scan_incomplete");
  expect(r.bz.failedDetails).toContain(bug.id);

  r.bz.unreadableDetailsFor.clear();
  await waitForState("active");
  await waitForState("idle");

  r.bz.revokedKeys.add(apiKey("alice"));
  await waitForState("authorization_revoked");
  await r.stop();

  const records = scanRecords();
  expect(records).toHaveLength(observedRecords);
  const canaries = [
    apiKey("alice"),
    apiKey("bob"),
    "fixture-token-alice",
    "fixture-token-bob",
    "only-for-c1-synthetic-fixtures-0123456789",
    "only-for-c1-binding-tickets-0123456789",
    secret,
    secret.slice("whsec_".length),
    url,
    new URL(url).host,
    "operator-log-canary",
    bug.summary,
    comment.text,
  ];
  for (const canary of canaries) expect(r.stderr).not.toContain(canary);
  for (const { subscriptionId: _opaqueId, ...fields } of records) {
    const decodedFields = JSON.stringify(fields);
    for (const canary of canaries) expect(decodedFields).not.toContain(canary);
    for (const id of [bug.id, comment.id]) {
      expect(decodedFields).not.toMatch(new RegExp(`(?<!\\d)${id}(?!\\d)`));
    }
  }
}, 120_000);

// EVIDENCE-OF: R-cad0d6
test("poll revalidates a previously returned page before computing maxEvents and hasMore", async () => {
  const r = await setup({ profile: sep });
  const a = r.bz.addBug("normal", r.now - 6000);
  const b = r.bz.addBug("normal", r.now - 6000);
  const from = await anchor(r, commented);
  const hidden = r.bz.addComment(a, "restricted comment marker");
  r.tick(1000);
  const visible = r.bz.addComment(b, "still visible");
  r.tick(2000);
  const before = await r.poll(commented, {}, from);
  expect(ids(before)).toHaveLength(2);
  r.bz.hiddenComments.add(hidden.id);
  const page = await r.poll(commented, {}, from, { maxEvents: 1 });
  expect(page).toMatchObject({ hasMore: false, truncated: false });
  expect(ids(page)).toEqual(ids(before).slice(1));
  expect(times(page)).toEqual([Date.parse(visible.time)]);
  expect(JSON.stringify(page)).not.toContain(hidden.text);
  r.bz.bugs.delete(b.id);
  expect(await r.poll(commented, {}, from)).toMatchObject({
    events: [],
    hasMore: false,
    truncated: false,
  });
  r.bz.revokedKeys.add(apiKey("alice"));
  failure(await r.rpc("events/poll", { name: commented, cursor: from }), -32024);
}, 45_000);

// revocationBeforeRetryTest. A later successful delivery witnesses continued
// progress after a single restriction. Loss of the binding/scope stops all sends.
// EVIDENCE-OF: R-cad0d6, R-3be334, R-79300a
for (const profile of profiles) {
  test.each(["credential", "scope"])(
    `${profile} suppresses restricted retries and stops on %s revocation`,
    async (revoke) => {
      const r = await setup({ profile, webhookEnabled: true, local: revoke === "scope" });
      const bug = r.bz.addBug("normal", r.now - 10_000);
      const params = subscribe(commented);
      const initial = await sub(r, params);
      const id = str(initial.id);
      const restrictedAt = r.now;
      const hidden = r.bz.addComment(bug, "comment hidden before retry");
      let reject = true;
      r.onSend = (s) => ({ status: occurrence(s) && reject ? 503 : 200 });
      r.tick(2000);
      await r.sent(1);
      r.bz.hiddenComments.add(hidden.id);
      reject = false;
      r.tick(3000);
      const visibleAt = r.now;
      r.bz.addComment(bug, "permitted witness");
      r.tick(2000);
      await until(
        () => expect(r.events().some((s) => sendTime(s) === visibleAt)).toBe(true),
        "visible witness after restriction",
      );
      expect(r.events().filter((s) => sendTime(s) === restrictedAt)).toHaveLength(1);
      expect((await sub(r, params, { cursor: initial.cursor })).truncated).toBe(false);
      expect(r.sends.some((s) => s.body.type === "gap")).toBe(false);

      reject = true;
      const pendingAt = r.now;
      r.bz.addComment(bug, "credential lost before retry");
      r.tick(2000);
      await until(
        () => expect(r.events().some((s) => sendTime(s) === pendingAt)).toBe(true),
        "attempt before revocation",
      );
      await r.stop();
      if (revoke === "scope") r.options = { ...r.options, eventsScope: false };
      else r.bz.revokedKeys.add(apiKey("alice"));
      r.tick(15_000);
      await r.start();
      failure(await r.rpc("events/subscribe", params), -32024);
      if (profile === sep) {
        failure(await r.rpc("events/poll", { name: commented, cursor: initial.cursor }), -32024);
        await until(
          () => expect(r.sends.some((s) => s.body.type === "terminated")).toBe(true),
          "SEP termination notice",
        );
        for (const s of r.sends.filter((s) => s.body.type === "terminated")) {
          signed(s, id);
          expect(s.request.rawBody).not.toContain(hidden.text);
          expect(s.request.rawBody).not.toContain("credential lost before retry");
        }
      }
      await r.stop();
      expect(r.events().map(sendTime)).toEqual([restrictedAt, visibleAt, pendingAt]);
      if (profile === chat)
        expect(r.sends.filter((s) => ["gap", "terminated"].includes(String(s.body.type)))).toEqual(
          [],
        );
    },
    75_000,
  );
}

// EVIDENCE-OF: R-9b9b89, R-9f1561, R-48f15c
test.each(["legacy", "modern"])(
  "ChatGPT %s subscription is isolated from a second issuer on the same callback",
  async (era) => {
    const r = await setup({ profile: chat, webhookEnabled: true });
    const negotiated = await r.legacy();
    const alice = era === "legacy" ? negotiated.caller : ({ tenant: "alice" } as const);
    envelope(success(await r.rpc("events/list", {}, alice)), alice);
    const a = await sub(r, subscribe(), {}, alice);
    envelope(a, alice);
    const bob = { tenant: "bob" } as const;
    const b = await sub(r, subscribe(created, {}, callback, newSecret), {}, bob);
    expect(r.sends.filter((s) => s.body.type === "verification")).toHaveLength(2);
    r.bz.addBug();
    r.tick(2000);
    await r.sent(2);
    for (const [id, key] of [
      [str(a.id), secret],
      [str(b.id), newSecret],
    ] as const) {
      const send = deliveriesFor(r, id).find((s) => {
        const stamp = s.headers.get("webhook-timestamp");
        const mac = createHmac("sha256", Buffer.from(key.slice(6), "base64"))
          .update(`${sendId(s)}.${stamp}.${s.request.rawBody}`)
          .digest("base64");
        return s.headers.get("webhook-signature")?.includes(`v1,${mac}`);
      });
      expect(send).toBeDefined();
    }
    for (let i = 0; i < 2; i++) {
      const result = success(
        await r.rpc(
          "events/unsubscribe",
          unsubscription(chat, created, { includeSelf: false }),
          alice,
        ),
      );
      expect(result).toEqual(era === "legacy" ? {} : { resultType: "complete" });
    }
    const db = store(r);
    expect(await db.listWebhookSubscriptions(scope(r))).toEqual([]);
    expect(await db.listWebhookSubscriptions(scope(r, "bob"))).toHaveLength(1);
    const remainingAt = r.now;
    r.bz.addBug();
    r.tick(2000);
    await r.sent(3);
    await r.stop();
    const remaining = r.events().filter((s) => sendTime(s) === remainingAt);
    expect(remaining).toHaveLength(1);
    signed(remaining[0]!, str(b.id), newSecret);
  },
  60_000,
);

// EVIDENCE-OF: R-cae32c, R-100db5, R-3be334, R-79300a
test.each(profiles)(
  "%s activates after a fresh signed challenge with both a successful status and exact echo",
  async (profile) => {
    const r = await setup({ profile, webhookEnabled: true });
    const url = callback + "/verify";
    const params = subscribe(created, {}, url);
    // A second, already verified destination witnesses automatic worker progress.
    await sub(r);
    for (const mode of ["wrong nonce", "bad status"]) {
      r.onSend = (s) => {
        if (s.request.url !== url || s.body.type !== "verification") return { status: 204 };
        return {
          status: mode === "bad status" ? 503 : 200,
          body: JSON.stringify({
            challenge: mode === "bad status" ? s.body.challenge : "different",
          }),
        };
      };
      failure(await r.rpc("events/subscribe", params), profile === sep ? -32027 : -32015);
    }
    const oldAt = r.now;
    r.bz.addBug();
    r.tick(2000);
    await r.sent(1);
    expect(r.events(url)).toEqual([]);
    r.onSend = () => ({ status: 204 });
    const active = await sub(r, params);
    const newAt = r.now;
    r.bz.addBug();
    r.tick(2000);
    await r.sent(1, url);
    await r.sent(2);
    const verified = r.sends.filter((s) => s.request.url === url && s.body.type === "verification");
    expect(verified.length).toBeGreaterThanOrEqual(3);
    expect(new Set(verified.map((s) => str(s.body.challenge))).size).toBe(verified.length);
    expect(new Set(verified.map(sendId)).size).toBe(verified.length);
    for (const s of verified) {
      expect(s.body).toEqual({ type: "verification", challenge: expect.any(String) });
      signed(s, str(s.headers.get("x-mcp-subscription-id")));
    }
    const delivery = r.events(url)[0]!;
    expect(sendTime(delivery)).toBe(newAt);
    signed(delivery, str(active.id));
    const first = r.events().find((s) => sendTime(s) === oldAt)!;
    const same = r.events().find((s) => sendTime(s) === newAt)!;
    expect(eventId(same)).toBe(eventId(delivery));
    if (profile === sep) {
      expect(new Set([first, same, delivery].map(sendId)).size).toBe(3);
      for (const s of [first, same, delivery]) expect(sendId(s)).not.toBe(eventId(s));
    } else {
      for (const s of [first, same, delivery]) expect(sendId(s)).toBe(eventId(s));
    }
  },
  60_000,
);

// EVIDENCE-OF: R-81b530, R-79300a, R-9f1561
test("SEP restores the grant and verifies both signatures inside the rotation window", async () => {
  const r = await setup({ profile: sep, webhookEnabled: true });
  const initial = await sub(r, subscribe(), { ttlMs: 300_000 });
  const id = str(initial.id);
  const rotated = await sub(r, subscribe(created, { includeSelf: false }, callback, newSecret), {
    ttlMs: 300_000,
  });
  expect(rotated.id).toBe(id);
  await r.restart();
  const subscriptions = await store(r).listWebhookSubscriptions(scope(r));
  expect(subscriptions).toContainEqual(
    expect.objectContaining({ id, verified: true, refreshBefore: rotated.refreshBefore }),
  );
  // No refresh following restart. A receiver that cannot verify again still
  // receives events under the grant made before shutdown.
  r.onSend = (s) => ({ status: s.body.type === "verification" ? 503 : 200 });
  r.bz.addBug();
  r.tick(3000);
  const [s] = await r.sent(1);
  signed(s!, id, secret);
  signed(s!, id, newSecret);
  for (let i = 0; i < 2; i++) {
    expect(success(await r.rpc("events/unsubscribe", unsubscription(sep)))).toEqual({
      resultType: "complete",
    });
  }
  expect(await store(r).listWebhookSubscriptions(scope(r))).toEqual([]);
}, 45_000);
const unsubscription = (profile: string, name = created, args: Obj = {}, url = callback) => ({
  name,
  arguments: args,
  delivery: profile === chat ? { mode: "webhook", url } : { url },
});

function signed(send: Send, id: string, key = secret) {
  expect(send.headers.get("content-type")?.split(";")[0]).toBe("application/json");
  expect(send.headers.get("x-mcp-subscription-id")).toBe(id);
  expect(Buffer.byteLength(send.request.rawBody)).toBeLessThanOrEqual(256 * 1024);
  const stamp = str(send.headers.get("webhook-timestamp"));
  expect(stamp).toMatch(/^\d+$/);
  // The server may use either the injected clock or the actual wall clock for signing.
  const timestampMs = Number(stamp) * 1000;
  expect(
    Math.min(Math.abs(timestampMs - send.logicalTime), Math.abs(timestampMs - send.receivedAt)),
  ).toBeLessThan(3000);
  const mac = createHmac("sha256", Buffer.from(key.slice("whsec_".length), "base64"))
    .update([sendId(send), stamp, send.request.rawBody].join("."))
    .digest("base64");
  expect(str(send.headers.get("webhook-signature")).split(/\s+/)).toContain(`v1,${mac}`);
}

async function anchor(r: Rig, name = created, args: Obj = {}, cursor?: null) {
  const result = await r.poll(name, args, cursor);
  expect(result).toMatchObject({ events: [], truncated: false, hasMore: false });
  return str(result.cursor);
}
async function sub(r: Rig, params = subscribe(), extra: Obj = {}, caller: Caller = {}) {
  return success(await r.rpc("events/subscribe", { ...params, ...extra }, caller));
}

// Give the scheduler opportunities after the minimum deadline. C0 allows
// scheduling later. Assertions below compare the observed attempts' times.
async function advanceUntil(r: Rig, ready: () => boolean, message: string) {
  await expect
    .poll(
      () => {
        if (ready()) return true;
        r.tick(1000);
        return false;
      },
      { timeout: 15_000, interval: 150, message },
    )
    .toBe(true);
}

// retryRestartTest: Queued -> failed -> restart -> interrupted -> restart ->
// Abandoned -> reported gap. Check each transition at the receiving endpoint.
// EVIDENCE-OF: R-cebf76, R-836a57, R-79300a, R-3be334, R-8f1277
test.each([2, undefined, 6, 0])(
  "ChatGPT counts the initial attempt separately (retry setting %s)",
  async (retries) => {
    const r = await setup({
      profile: chat,
      webhookEnabled: true,
      ...(retries === undefined ? {} : { retries }),
    });
    const params = subscribe(created, { severity: "critical" });
    const start = await sub(r, params, { cursor: null });
    const old = str(start.cursor);
    expect(start.truncated).toBe(false);
    const bug = r.bz.addBug("critical");
    const lostAt = r.now;
    let outcome: "fail" | "interrupt" | "network" = "fail";
    r.onSend = (s) => {
      if (s.request.url !== callback || !occurrence(s) || sendTime(s) !== lostAt)
        return { status: 200 };
      if (outcome === "interrupt") return "hold";
      if (outcome === "network") return "disconnect";
      return { status: 503 };
    };
    const lost = () => r.events().filter((s) => sendTime(s) === lostAt);
    const attempts = 1 + (retries ?? 3);
    r.tick(2000);
    await r.sent(1);
    for (let n = 1; n <= attempts; n++) {
      const last = lost()[n - 1]!;
      expect(lost()).toHaveLength(n);
      signed(last, str(start.id));
      expect(sendId(last)).toBe(eventId(last));
      expect(sendId(last)).toBe(sendId(lost()[0]!));
      // Receipt is unknowable for the held call. Kill the OS process with its
      // request outstanding, leaving the original SQLite file in place.
      await r.stop(outcome === "interrupt");
      outcome = n === 1 ? "interrupt" : n === 2 ? "network" : "fail";
      if (n === attempts) break;
      bug.severity = "normal"; // already collected with critical severity
      const minimum = Math.min(10_000, 1000 * 2 ** (n - 1));
      const justBefore = last.logicalTime + minimum - 1;
      if (r.now < justBefore) r.tick(justBefore - r.now);
      const before = r.bz.requests.length;
      await r.start();
      const refresh = await sub(r, params, { cursor: old, maxAgeMs: 1 });
      expect(refresh).toMatchObject({ id: start.id, truncated: false });
      // A distinct destination replays from the actual recovery cursor. Pending
      // work cannot be crossed even when the requested refresh maxAgeMs is tiny.
      if (n === 1) {
        bug.severity = "critical"; // new replay evaluates current severity
        const probeUrl = callback + "/watermark";
        await sub(r, subscribe(created, { severity: "critical" }, probeUrl), {
          cursor: str(refresh.cursor),
        });
        // Probe callbacks succeed independently of the deliberately failed route.
        await r.sent(1, probeUrl);
        expect(eventId(r.events(probeUrl)[0]!)).toBe(eventId(last));
        bug.severity = "normal";
      }
      await until(
        () => expect(r.bz.requests.slice(before).some((q) => q.path === "bug")).toBe(true),
        "worker evaluated restored work",
      );
      expect(lost()).toHaveLength(n);
      r.tick(1);
      await advanceUntil(r, () => lost().length >= n + 1, "retry became observable");
      expect(lost()[n]!.logicalTime - last.logicalTime).toBeGreaterThanOrEqual(minimum);
    }
    await r.start();
    // New work proves the reopened subscription is live after abandonment.
    const witnessAt = r.now + 15_000;
    r.tick(15_000);
    r.bz.addBug("critical");
    r.tick(3000);
    await until(
      () => expect(r.events().some((s) => sendTime(s) === witnessAt)).toBe(true),
      "post-abandonment event",
    );
    expect(lost()).toHaveLength(attempts);
    const recovery = await sub(r, params, { cursor: old });
    expect(recovery).toMatchObject({ id: start.id, truncated: true });
    await r.restart();
    const repeated = await sub(r, params, { cursor: old }); // first refresh response was lost
    expect(repeated).toMatchObject({ id: start.id, truncated: true });
    bug.severity = "critical";
    const url = callback + "/recover";
    await sub(r, subscribe(created, { severity: "critical" }, url), {
      cursor: str(repeated.cursor),
    });
    const marker = r.now;
    r.bz.addBug("critical");
    r.tick(2000);
    await until(
      () => expect(r.events(url).some((s) => sendTime(s) === marker)).toBe(true),
      "recovery position activated",
    );
    await r.stop();
    expect(r.events(url).some((s) => sendTime(s) === lostAt)).toBe(false);
    expect(r.sends.filter((s) => ["gap", "terminated"].includes(String(s.body.type)))).toEqual([]);
    expect(lost()).toHaveLength(attempts);
  },
  180_000,
);

// terminalResponsesTest with a third, later Queued delivery. Interpret opaque
// SEP cursors by polling them under the same tenant, event and arguments.
// EVIDENCE-OF: R-cebf76, R-836a57, R-c83005, R-79300a
test("410 and 413 end only their deliveries, and a SEP recovery cursor respects outstanding work", async () => {
  const r = await setup({ profile: sep, webhookEnabled: true, retries: 3 });
  const subscription = await sub(r);
  const old = str(subscription.cursor);
  const time410 = r.now;
  r.bz.addBug();
  r.tick(1000);
  const time413 = r.now;
  r.bz.addBug();
  r.tick(1000);
  const pending = r.now;
  r.bz.addBug();
  let acceptPending = false;
  r.onSend = (s) => {
    if (s.body.type === "gap") return { status: 503 }; // not acknowledged
    if (!occurrence(s)) return { status: 200 };
    const t = sendTime(s);
    if (t === time410) return { status: 410 };
    if (t === time413) return { status: 413 };
    return { status: t === pending && !acceptPending ? 503 : 200 };
  };
  r.tick(2000);
  await r.sent(3);
  const source = await r.poll(created, {}, old);
  expect(times(source)).toEqual([time410, time413, pending]);
  const pendingSend = r.events().find((s) => sendTime(s) === pending)!;
  const cursor = occurrence(pendingSend)?.cursor ?? pendingSend.body.cursor;
  if (cursor != null) {
    // No acknowledgement of this delivery and no acknowledged gap envelope.
    expect(times(await r.poll(created, {}, str(cursor)))).toEqual([time410, time413, pending]);
  }
  const midway = await sub(r, subscribe(), { cursor: old });
  const remaining = times(await r.poll(created, {}, str(midway.cursor)));
  expect(remaining).toContain(pending);
  if (!remaining.includes(time410) || !remaining.includes(time413))
    expect(midway.truncated).toBe(true);
  acceptPending = true;
  await advanceUntil(
    r,
    () => r.events().filter((s) => sendTime(s) === pending).length >= 2,
    "pending delivery retried",
  );
  await until(
    () => expect(r.sends.some((s) => s.body.type === "gap")).toBe(true),
    "signed SEP gap between refreshes",
  );
  for (const s of r.sends.filter((s) => s.body.type === "gap")) {
    signed(s, str(subscription.id));
    expect(typeof s.body.cursor).toBe("string");
  }
  r.tick(15_000);
  const later = r.now;
  r.bz.addBug();
  r.tick(2000);
  await until(
    () => expect(r.events().some((s) => sendTime(s) === later)).toBe(true),
    "subscription survived terminal responses",
  );
  for (const at of [time410, time413])
    expect(r.events().filter((s) => sendTime(s) === at)).toHaveLength(1);
  const recovered = await sub(r, subscribe(), { cursor: old });
  expect(recovered.truncated).toBe(true);
  expect(times(await r.poll(created, {}, str(recovered.cursor)))).not.toContain(time413);
  expect(times(await r.poll(created, {}, old)).slice(0, 2)).toEqual([time410, time413]);
}, 75_000);

// EVIDENCE-OF: R-1006f2, R-c83005, R-39bcf8, R-a36d59
test("first acquisition fails closed, then null anchors and bounded new Webhook replays select different prefixes", async () => {
  const r = await setup({ profile: sep, webhookEnabled: true, epoch: 1 }, false);
  const bug = r.bz.addBug("normal", r.now - 3000);
  r.bz.unreadableDetailsFor.add(bug.id);
  await r.start();
  failure(await r.rpc("events/poll", { name: commented, cursor: null }), -32603, "scan_incomplete");
  failure(
    await r.rpc("events/subscribe", { ...subscribe(commented), cursor: null }),
    -32603,
    "scan_incomplete",
  );
  expect(await store(r).listWebhookSubscriptions(scope(r))).toEqual([]);
  r.bz.unreadableDetailsFor.clear();
  const cursor = await anchor(r, commented);
  const firstAt = r.now;
  r.bz.addComment(bug, "earlier retained comment");
  r.tick(5000);
  const secondAt = r.now;
  r.bz.addComment(bug, "later retained comment");
  r.tick(2000);
  const full = await r.poll(commented, {}, cursor);
  const bounded = await sub(r, subscribe(commented), { cursor, maxAgeMs: 3500 });
  expect(bounded.truncated).toBe(true);
  const knownSafe = str(full.cursor);
  const freshUrl = callback + "/new";
  const fresh = await sub(r, subscribe(commented, {}, freshUrl), { cursor: null });
  expect(fresh.truncated).toBe(false);
  expect(ids(await r.poll(commented, {}, str(fresh.cursor)))).toEqual([]);
  const marker = r.now;
  r.bz.addComment(bug, "after new subscription");
  r.tick(2000);
  await r.sent(2);
  await r.sent(1, freshUrl);
  expect(r.events().map(sendTime).sort()).toEqual([secondAt, marker]);
  expect(r.events(freshUrl).map(sendTime)).toEqual([marker]);
  expect(times(full)).toEqual([firstAt, secondAt]);
  const bad = subscribe(commented, {}, callback + "/invalid");
  for (const [params, caller] of [
    [{ ...bad, cursor: "malformed" }, {}],
    [{ ...bad, cursor, name: updated }, {}],
    [{ ...bad, cursor, arguments: { mentionMe: true } }, {}],
    [{ ...bad, cursor }, { tenant: "bob" }],
  ] as const)
    failure(await r.rpc("events/subscribe", params, caller), -32602);
  r.options = { ...r.options, epoch: 2 };
  await r.restart();
  failure(await r.rpc("events/subscribe", { ...bad, cursor: knownSafe }), -32026, "schema_changed");
  expect(
    (await store(r).listWebhookSubscriptions(scope(r))).some((s) => s.url === bad.delivery.url),
  ).toBe(false);
}, 60_000);
function envelope(result: Obj, caller: Caller) {
  if (caller.session) expect(result).not.toHaveProperty("resultType");
  else expect(result.resultType).toBe("complete");
}

// EVIDENCE-OF: R-0b14d8
test("read-only HTTP serves a real search and rejects writes before they change state", async () => {
  const r = await setup({ profile: sep, readOnly: true });
  const bug = r.bz.addBug();
  const names = rows(success(await r.rpc("tools/list")).tools).map((t) => str(t.name));
  const reads = [
    "bugzilla_search",
    "bugzilla_get_dossier",
    "bugzilla_triage_board",
    "bugzilla_get_attachment_excerpt",
  ];
  expect(names).toEqual(expect.arrayContaining(reads));
  expect(
    rows((await r.tool("bugzilla_search", { product, limit: 10, offset: 0 })).items),
  ).toContainEqual(expect.objectContaining({ id: bug.id, summary: bug.summary }));
  const key = randomUUID();
  const db = store(r);
  const mutations = [
    [
      "bugzilla_post_analysis",
      { bugId: bug.id, analysisMarkdown: "private analysis", isPrivate: true, idempotencyKey: key },
    ],
    [
      "bugzilla_propose_update",
      {
        bugId: bug.id,
        expectedLastChangeTime: bug.last_change_time,
        diff: { priority: "P1" },
        rationale: "Reprioritize fixture",
        idempotencyKey: key,
      },
    ],
    [
      "bugzilla_create_bug",
      {
        product,
        component,
        version: "1",
        summary: "C1",
        description: "Fixture",
        idempotencyKey: key,
      },
    ],
    [
      "app_save_draft",
      { bugId: bug.id, content: "draft", draftRevision: 1, draftKind: "private_comment" },
    ],
    [
      "app_resolve_proposal",
      { proposalId: "fixture-proposal", revision: 1, decision: "approve", idempotencyKey: key },
    ],
  ] as const;
  for (const [name, args] of mutations) {
    expect(names).not.toContain(name);
    failure(await r.rpc("tools/call", { name, arguments: args }), -32602);
    expect(await db.getReceipt({ ...scope(r), operation: name, key })).toBeNull();
  }
  expect(
    r.bz.requests.filter((q) => ["POST", "PUT", "DELETE", "PATCH"].includes(q.method)),
  ).toEqual([]);
  const { issuer, principalId, instanceUrl } = scope(r);
  expect(
    await db.getDraft({ ...scope(r), bugId: bug.id, draftKind: "private_comment" }),
  ).toBeNull();
  expect(await db.listInternalNotes(issuer, principalId, instanceUrl, bug.id)).toEqual([]);
  expect(await db.listWriteAudits(issuer, principalId, instanceUrl, bug.id)).toEqual([]);
  if (db.listProposals)
    expect(await db.listProposals(issuer, principalId, instanceUrl)).toEqual([]);
}, 30_000);

// EVIDENCE-OF: R-462339
test("changing the write key cannot replenish a bug's event-triggered budget", async () => {
  const r = await setup({ profile: sep });
  const cursor = await anchor(r);
  const a = r.bz.addBug();
  r.tick(1000);
  const b = r.bz.addBug();
  r.tick(2000);
  const triggers = ids(await r.poll(created, {}, cursor));
  expect(triggers).toHaveLength(2);
  async function write(bugId: number, causalEventId: string, expectToolError = false) {
    return r.tool(
      "bugzilla_post_analysis",
      {
        bugId,
        causalEventId,
        idempotencyKey: randomUUID(),
        analysisMarkdown: "Event-triggered fixture note",
        isPrivate: true,
      },
      {},
      { allowError: expectToolError },
    );
  }
  expect((await write(a.id, triggers[0]!)).outcome).toBe("Applied");
  expect((await write(a.id, triggers[0]!)).outcome).toBe("Applied");
  expect((await write(a.id, triggers[0]!, true)).outcome).toBe("CausalBudgetExhausted");
  expect((await write(b.id, triggers[1]!)).outcome).toBe("Applied");
  expect(r.bz.comments.map((c) => c.bug_id)).toEqual([a.id, a.id, b.id]);
}, 40_000);

// EVIDENCE-OF: R-1006f2, R-c83005, R-8f1277
test("bounded lag, severity at collection, and stable pagination through a same-second tie", async () => {
  const r = await setup({ profile: sep, epoch: 1 });
  r.bz.addBug("critical", r.now - 10_000); // Already in the initial verified prefix.
  const args = { severity: "critical" };
  const cursor = await anchor(r, created, args, null);
  const normal = await anchor(r, created, { severity: "normal" });
  const start = r.now;
  const reclassified = r.bz.addBug("normal", start, 2000);
  reclassified.severity = "critical";
  r.bz.addBug("critical");
  r.bz.addBug(null);
  r.tick(1000);
  const recent = r.now;
  r.bz.addBug("critical");
  r.bz.addBug("normal");
  r.bz.addBug("Critical");
  const early = await r.poll(created, args, cursor);
  expect(early).toMatchObject({ events: [], truncated: false, hasMore: false });
  r.tick(2000);
  const all = await r.poll(created, args, str(early.cursor));
  expect(times(all)).toEqual([start, start, recent]);
  const order = ids(all);
  expect(new Set(order).size).toBe(3);
  expect(times(await r.poll(created, { severity: "normal" }, normal))).toEqual([recent]);
  const first = await r.poll(created, args, cursor, { maxEvents: 1 });
  expect(first).toMatchObject({ hasMore: true, truncated: false });
  expect(ids(first)).toEqual(order.slice(0, 1));
  const rest = await r.poll(created, args, str(first.cursor), { maxEvents: 2 });
  expect(rest).toMatchObject({ hasMore: false, truncated: false });
  expect(ids(rest)).toEqual(order.slice(1));
  expect(ids(await r.poll(created, args, cursor))).toEqual(order);
  expect(ids(await r.poll(created, args, str(rest.cursor)))).toEqual([]);
  // Effective replay boundary falls strictly between the two commit seconds.
  const shortened = await r.poll(created, args, cursor, { maxAgeMs: 2500 });
  expect(shortened.truncated).toBe(true);
  expect(ids(shortened)).toEqual(order.slice(-1));
  for (const params of [
    { name: created, arguments: args, cursor: "malformed" },
    { name: commented, arguments: {}, cursor },
    { name: created, arguments: { severity: "normal" }, cursor },
  ]) {
    failure(await r.rpc("events/poll", params), -32602);
  }
  failure(
    await r.rpc("events/poll", { name: created, arguments: args, cursor }, { tenant: "bob" }),
    -32602,
  );
  r.options = { ...r.options, epoch: 2 };
  await r.restart();
  failure(
    await r.rpc("events/poll", { name: created, arguments: args, cursor }),
    -32026,
    "schema_changed",
  );
}, 45_000);

// Quint scanRecoveryTest projected onto a poll result. A required comment read
// fails after the candidate search, with another readable occurrence in the scan.
// EVIDENCE-OF: R-a36d59, R-1006f2, R-c83005
test("an incomplete scan yields no partial poll or replacement cursor, then replays both comments", async () => {
  const r = await setup({ profile: sep });
  const first = r.bz.addBug("normal", r.now - 5000);
  const last = r.bz.addBug("critical", r.now - 4000);
  const cursor = await anchor(r, commented);
  const firstAt = r.now;
  r.bz.addComment(first, "Readable detail");
  r.tick(1000);
  const lastAt = r.now;
  r.bz.addComment(last, "Temporarily unreadable detail");
  r.bz.unreadableDetailsFor.add(last.id);
  r.tick(2000);
  const error = await r.rpc("events/poll", { name: commented, arguments: {}, cursor });
  failure(error, -32603, "scan_incomplete");
  expect(obj(error.message.error).data).not.toHaveProperty("events");
  expect(obj(error.message.error).data).not.toHaveProperty("cursor");
  r.bz.unreadableDetailsFor.clear();
  const complete = await r.poll(commented, {}, cursor);
  expect(times(complete)).toEqual([firstAt, lastAt]);
  expect(complete.truncated).toBe(false);
  expect(ids(await r.poll(commented, {}, str(complete.cursor)))).toEqual([]);
}, 40_000);

// EVIDENCE-OF: R-a36d59
test("a failed candidate search page yields no partial poll and the original cursor replays both bugs", async () => {
  const r = await setup({ profile: sep });
  r.bz.candidatePageSize = 1;
  const cursor = await anchor(r);
  const firstAt = r.now;
  const first = r.bz.addBug();
  r.tick(1000);
  const lastAt = r.now;
  r.bz.addBug();
  r.tick(2000);

  const pagesBeforePoll = r.bz.candidatePages.length;
  r.bz.failCandidateContinuation = true;
  const error = await r.rpc("events/poll", { name: created, arguments: {}, cursor });
  const [firstPage, ...followingPages] = r.bz.candidatePages.slice(pagesBeforePoll);
  expect(firstPage).toEqual({ offset: 0, status: 200, bugIds: [first.id] });
  expect(followingPages).toContainEqual({ offset: 1, status: 503 });
  failure(error, -32603, "scan_incomplete");
  const rpcError = obj(error.message.error);
  for (const value of [error.message, rpcError, obj(rpcError.data)]) {
    expect(value).not.toHaveProperty("events");
    expect(value).not.toHaveProperty("cursor");
  }

  r.bz.failCandidateContinuation = false;
  const complete = await r.poll(created, {}, cursor);
  expect(complete).toMatchObject({ hasMore: false, truncated: false });
  expect(times(complete)).toEqual([firstAt, lastAt]);
  expect(new Set(ids(complete)).size).toBe(2);
  expect(ids(await r.poll(created, {}, str(complete.cursor)))).toEqual([]);
}, 40_000);

// Projections of sameSecondSelectionTest and includeSelfSelectionTest. Populate
// provenance through actual writes. Reopen SQLite before making any selection.
// EVIDENCE-OF: R-5d5271, R-8f1277
test("confirmed creates and comment IDs survive restart and stay scoped to the writer", async () => {
  const r = await setup({ profile: sep });
  const existing = r.bz.addBug("critical", r.now - 8000);
  const filter = { severity: "critical" };
  const createdCursor = await anchor(r, created, filter);
  const allCreated = await anchor(r, created, { ...filter, includeSelf: true });
  const comments = await anchor(r, commented);
  const allComments = await anchor(r, commented, { includeSelf: true });
  const bob = { tenant: "bob" } as const;
  const other = str((await r.poll(commented, {}, null, {}, bob)).cursor);
  const createdBug = await r.tool("bugzilla_create_bug", {
    idempotencyKey: randomUUID(),
    product,
    component,
    version: "1",
    summary: "Created fixture",
    description: "Verification",
    severity: "critical",
  });
  expect(createdBug.outcome).toBe("Applied");
  const createdByServer = [...r.bz.bugs.values()].find((b) => b.summary === "Created fixture")!;
  const human = r.bz.addBug("critical");
  r.bz.addBug("normal");
  expect(
    (
      await r.tool("bugzilla_post_analysis", {
        idempotencyKey: randomUUID(),
        bugId: existing.id,
        analysisMarkdown: "Pair of indistinguishable texts",
        isPrivate: true,
      })
    ).outcome,
  ).toBe("Applied");
  const self = r.bz.comments[0]!;
  const twin = r.bz.addComment(existing, self.text);
  expect(twin.id).not.toBe(self.id);
  r.tick(3000);
  await r.restart();
  const selected = ids(await r.poll(commented, {}, comments));
  expect(selected).toHaveLength(1);
  expect(new Set(ids(await r.poll(commented, { includeSelf: true }, allComments))).size).toBe(2);
  expect(ids(await r.poll(commented, {}, other, {}, bob))).toHaveLength(2);
  r.bz.hiddenComments.add(twin.id);
  expect(ids(await r.poll(commented, {}, comments))).toEqual([]);
  expect(ids(await r.poll(commented, { includeSelf: true }, allComments))).toHaveLength(1);
  expect(ids(await r.poll(created, filter, createdCursor))).toHaveLength(1);
  expect(ids(await r.poll(created, { ...filter, includeSelf: true }, allCreated))).toHaveLength(2);
  r.bz.hiddenBugs.add(human.id);
  expect(ids(await r.poll(created, filter, createdCursor))).toEqual([]);
  expect(r.bz.hiddenBugs.has(createdByServer.id)).toBe(false);
}, 45_000);

// EVIDENCE-OF: R-5d5271
test("one-to-one confirmed history deltas identify field writes and their derived needinfo", async () => {
  const r = await setup({ profile: sep });
  const bug = r.bz.addBug("normal", r.now - 10_000);
  const other = r.bz.addBug("normal", r.now - 10_000);
  const args = { bugIds: [bug.id], watchedFields: ["priority"] };
  const filtered = await anchor(r, updated, args);
  const all = await anchor(r, updated, { ...args, includeSelf: true });
  const selfArgs = { requestee: "self-target@example.test" };
  const humanArgs = { requestee: "human-target@example.test" };
  const selfFlag = await anchor(r, needinfo, selfArgs);
  const allFlags = await anchor(r, needinfo, { ...selfArgs, includeSelf: true });
  const humanFlag = await anchor(r, needinfo, humanArgs);
  async function propose(id: number, base: string, diff: Obj) {
    const result = await r.tool("bugzilla_propose_update", {
      bugId: id,
      expectedLastChangeTime: base,
      diff,
      rationale: "Apply a fixture update",
      idempotencyKey: randomUUID(),
      approval: { kind: "policy_grant", policyId: "fixture" },
    });
    expect(result.outcome).toBe("Applied");
  }
  await propose(bug.id, bug.last_change_time, { priority: "P1" }); // P2 -> P1
  r.bz.update(bug, "priority", "P3"); // same actor, second and field, different delta
  await propose(other.id, other.last_change_time, {
    flags: [{ name: "needinfo", status: "?", requestee: selfArgs.requestee }],
  });
  r.bz.requestInfo(other, humanArgs.requestee);
  r.tick(3000);
  await r.restart();
  expect(ids(await r.poll(updated, args, filtered))).toHaveLength(1);
  expect(new Set(ids(await r.poll(updated, { ...args, includeSelf: true }, all))).size).toBe(2);
  expect(ids(await r.poll(needinfo, selfArgs, selfFlag))).toEqual([]);
  expect(ids(await r.poll(needinfo, { ...selfArgs, includeSelf: true }, allFlags))).toHaveLength(1);
  expect(ids(await r.poll(needinfo, humanArgs, humanFlag))).toHaveLength(1);
}, 45_000);

// EVIDENCE-OF: R-5d5271
test("an ambiguous confirmed history delta leaves all priority updates eligible by default", async () => {
  const r = await setup({ profile: sep });
  const bug = r.bz.addBug("normal", r.now - 10_000);
  const args = { bugIds: [bug.id], watchedFields: ["priority"] };
  const withSelf = { ...args, includeSelf: true };
  const defaultCursor = await anchor(r, updated, args);
  const allCursor = await anchor(r, updated, withSelf);

  // Another client using the same Bugzilla account changes and restores the priority
  // during the PUT, within the same Bugzilla timestamp as the confirmed update.
  r.bz.beforeBugUpdate = (target) => {
    r.bz.update(target, "priority", "P1");
    r.bz.update(target, "priority", "P2");
  };
  const changedAt = r.now;
  const write = await r.tool("bugzilla_propose_update", {
    bugId: bug.id,
    expectedLastChangeTime: bug.last_change_time,
    diff: { priority: "P1" },
    rationale: "Apply a fixture update",
    idempotencyKey: randomUUID(),
    approval: { kind: "policy_grant", policyId: "fixture" },
  });
  expect(write.outcome).toBe("Applied");
  const matchingEntry = {
    when: iso(changedAt),
    who: actor,
    changes: [{ field_name: "priority", removed: "P2", added: "P1" }],
  };
  expect(r.bz.history.get(bug.id)).toEqual([
    matchingEntry,
    { ...matchingEntry, changes: [{ field_name: "priority", removed: "P1", added: "P2" }] },
    matchingEntry,
  ]);

  r.tick(3000);
  await r.restart();
  const eligible = await r.poll(updated, withSelf, allCursor);
  expect(times(eligible)).toEqual([changedAt, changedAt, changedAt]);
  const eligibleIds = ids(eligible);
  expect(new Set(eligibleIds).size).toBe(3);
  expect(ids(await r.poll(updated, args, defaultCursor))).toEqual(eligibleIds);
}, 45_000);

// EVIDENCE-OF: R-48f15c
test.each([{ noAuthentication: true }, { memoryOnly: true }])(
  "rejects an unready Webhook deployment %o",
  async (option) => {
    const r = await setup({ profile: chat, webhookEnabled: true, ...option }, false);
    await expect(r.start()).rejects.toMatchObject({ code: "WebhookConfigurationError" });
    expect(r.logs).not.toContain("C1_READY");
  },
  30_000,
);

// EVIDENCE-OF: R-48f15c
test("the supplied HTTPS sender allows an authenticated start without a custom transport", async () => {
  const r = await setup({ profile: chat, webhookEnabled: true, defaultSender: true });
  const result = success(await r.rpc("server/discover"));
  expect(obj(result.capabilities)).toHaveProperty("events");
}, 30_000);

// EVIDENCE-OF: R-48f15c, R-e3c811, R-0986c6
for (const profile of profiles) {
  for (const enabled of [false, true]) {
    test(`${profile} readiness, catalog and validation (Webhook ${enabled})`, async () => {
      const r = await setup({ profile, ...(enabled ? { webhookEnabled: true } : {}) });
      const capabilities = obj(success(await r.rpc("server/discover")).capabilities);
      const negotiated = await r.legacy();
      if (profile === chat) {
        for (const cap of [capabilities, negotiated.capabilities]) {
          expect(Object.hasOwn(cap, "events")).toBe(enabled);
        }
      } else {
        expect(
          obj(negotiated.capabilities.extensions)["io.modelcontextprotocol/events"],
        ).toBeDefined();
      }
      const disabledChat = profile === chat && !enabled;
      const list = await r.rpc("events/list");
      if (disabledChat) failure(list, -32601);
      else {
        const entries = rows(success(list).events);
        expect(entries.map((e) => e.name).sort()).toEqual(Object.keys(argsFor).sort());
        for (const e of entries) {
          const schema = obj(e.inputSchema);
          expect(schema.additionalProperties).toBe(false);
          expect(Object.keys(obj(schema.properties)).sort()).toEqual(
            ["includeSelf", ...argsFor[str(e.name)]!].sort(),
          );
          expect(obj(obj(schema.properties).includeSelf).type).toBe("boolean");
          expect(schema.required ?? []).toEqual([]);
          expect(obj(e.payloadSchema)).toBeDefined();
          const modes = [...(profile === sep ? ["poll"] : []), ...(enabled ? ["webhook"] : [])];
          expect(Array.isArray(e.delivery) && [...e.delivery].sort()).toEqual(modes);
        }
      }

      const before = r.bz.requests.length;
      const disabled: [string, Obj][] = [["events/stream", { name: created, arguments: {} }]];
      if (profile === chat) disabled.push(["events/poll", { name: created, arguments: {} }]);
      if (!enabled)
        disabled.push(
          ["events/subscribe", subscribe()],
          ["events/unsubscribe", unsubscription(profile)],
        );
      for (const [method, params] of disabled) {
        failure(
          await r.rpc(method, params),
          profile === chat ? -32601 : -32026,
          profile === sep ? "delivery_disabled" : undefined,
        );
      }
      if (!disabledChat) {
        for (const [name, wrong] of [
          [created, { watchedFields: ["status"] }],
          [updated, { watchedFields: ["summary"] }],
          [updated, { bugIds: "42" }],
          [commented, { mentionMe: "false" }],
          [needinfo, { requestee: 10 }],
          [created, { includeSelf: "true" }],
          [created, { extra: true }],
        ] as const) {
          if (profile === sep)
            failure(await r.rpc("events/poll", { name, arguments: wrong }), -32602);
          if (enabled) failure(await r.rpc("events/subscribe", subscribe(name, wrong)), -32602);
        }
      }
      expect(
        r.bz.requests.slice(before).filter((q) => q.path === "bug" || q.path.startsWith("bug/")),
      ).toEqual([]);
      expect(r.sends).toEqual([]);
      expect(await store(r).listWebhookSubscriptions(scope(r))).toEqual([]);
    }, 40_000);
  }
}
