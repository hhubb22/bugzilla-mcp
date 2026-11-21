import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, test } from "vite-plus/test";
import { normalizeBoardTenantKey, resolveBoardTenantKey } from "../packages/app-ui/src/index.js";
import {
  MCP_PROTOCOL_LEGACY,
  PrincipalContextSchema,
  RESERVED_LEGACY_ISSUER,
  type PrincipalContext,
} from "../packages/contracts/src/index.js";
import {
  createCloudApprovalTokenService,
  createSyntheticEventsService,
  createWriteGuardService,
  startWebhookDeliveryLoop,
} from "../packages/core/src/index.js";
import { createDualEraHttpHandler, createStdioRpcProcessor } from "../packages/server/src/index.js";
import { createSqliteStorage } from "../packages/storage/src/index.js";
import {
  bugzilla,
  comment,
  deferred,
  dependencies,
  epoch,
  iso,
  manualClock,
  origin,
  principal,
} from "./helpers/fakes.js";

const issuerA = "https://idp-a.example";
const issuerB = "https://idp-b.example";
const LEGACY_ISSUER = RESERVED_LEGACY_ISSUER;

const principalA: PrincipalContext = {
  ...principal,
  issuer: issuerA,
  principalId: "alice",
};

const principalB: PrincipalContext = {
  ...principal,
  issuer: issuerB,
  principalId: "alice",
};

const tempDirs: string[] = [];

function createTempDbPath(name = "multi-issuer.sqlite"): string {
  const dir = mkdtempSync(join(tmpdir(), "bz-mcp-r970164-"));
  tempDirs.push(dir);
  return join(dir, name);
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("R-970164 multi-issuer tenant isolation and SQLite migration", () => {
  // EVIDENCE-OF: R-970164
  test("isolates receipts, internal notes, drafts, proposals, and write audits across issuers sharing principalId", async () => {
    const storage = createSqliteStorage(createTempDbPath());
    const upstream = bugzilla({
      async probeCapabilities() {
        return {
          version: "5.2",
          supportsHeaderAuth: true,
          authenticatedUser: "alice@example.test",
          isInsider: false,
        };
      },
    });
    const signingSecret = "multi-issuer-test-secret-0123456789";
    const approvalService = createCloudApprovalTokenService(signingSecret, storage);
    const service = createWriteGuardService(
      dependencies(upstream.client, {
        storage,
        cloudApprovalService: approvalService,
      }),
    );

    // 1. Receipts & internal notes: identical idempotencyKey under different issuers execute independently
    const analysisA = await service.postAnalysis(principalA, {
      idempotencyKey: "shared-key-analysis",
      bugId: 41,
      analysisMarkdown: "Secret analysis from Issuer A",
      isPrivate: true,
    });
    const analysisB = await service.postAnalysis(principalB, {
      idempotencyKey: "shared-key-analysis",
      bugId: 41,
      analysisMarkdown: "Secret analysis from Issuer B",
      isPrivate: true,
    });
    expect(analysisA).toMatchObject({ outcome: "SavedAsInternalNote", reason: "non_insider" });
    expect(analysisB).toMatchObject({ outcome: "SavedAsInternalNote", reason: "non_insider" });

    const notesA = await storage.listInternalNotes(issuerA, "alice", principalA.instanceUrl, 41);
    const notesB = await storage.listInternalNotes(issuerB, "alice", principalB.instanceUrl, 41);
    expect(notesA.map((n) => n.text)).toEqual([expect.stringContaining("Issuer A")]);
    expect(notesB.map((n) => n.text)).toEqual([expect.stringContaining("Issuer B")]);

    // 2. Drafts: Issuer B cannot see Issuer A's draft and starts cleanly at revision 1
    const saveA = await service.saveDraft(principalA, {
      bugId: 41,
      draftKind: "private_comment",
      draftRevision: 2,
      content: "Issuer A confidential draft",
    });
    expect(saveA).toMatchObject({ status: "acknowledged", draftRevision: 2 });
    expect(
      await service.getDraft(principalB, { bugId: 41, draftKind: "private_comment" }),
    ).toBeNull();
    const saveB = await service.saveDraft(principalB, {
      bugId: 41,
      draftKind: "private_comment",
      draftRevision: 1,
      content: "Issuer B independent draft",
    });
    expect(saveB).toMatchObject({ status: "acknowledged", draftRevision: 1 });
    expect(
      (await service.getDraft(principalA, { bugId: 41, draftKind: "private_comment" }))?.content,
    ).toBe("Issuer A confidential draft");

    // 3. Proposals & write audits: Issuer B cannot read or resolve Issuer A's proposal
    const diff = { status: "ASSIGNED", publicComment: "Confirmed by Issuer A" };
    const propA = await service.proposeUpdate(principalA, {
      idempotencyKey: "shared-key-proposal",
      bugId: 41,
      expectedLastChangeTime: iso(epoch),
      diff,
      rationale: "Issuer A triage",
    });
    expect(propA.outcome).toBe("ProposalPending");
    if (propA.outcome !== "ProposalPending") throw new Error("Expected ProposalPending");

    expect(
      await storage.getProposal(
        issuerB,
        "alice",
        principalB.instanceUrl,
        propA.proposalId,
        propA.revision,
      ),
    ).toBeNull();
    expect(await storage.listProposals?.(issuerB, "alice", principalB.instanceUrl)).toEqual([]);

    const grantForB = await approvalService.issue({
      approverIssuer: issuerB,
      approverPrincipalId: "alice",
      instanceUrl: principalB.instanceUrl,
      proposalId: propA.proposalId,
      revision: propA.revision,
      bugId: 41,
      baseVersion: iso(epoch),
      diff,
      visibility: "public",
      ttlMs: 60_000,
      nowMs: epoch,
    });
    await expect(
      service.resolveProposal(principalB, {
        idempotencyKey: "resolve-cross-issuer",
        proposalId: propA.proposalId,
        revision: propA.revision,
        decision: "approve",
        approval: { kind: "cloud_signed_token", token: grantForB.token },
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // Issuer A resolves its own proposal and records an audit only under Issuer A
    const grantForA = await approvalService.issue({
      approverIssuer: issuerA,
      approverPrincipalId: "alice",
      instanceUrl: principalA.instanceUrl,
      proposalId: propA.proposalId,
      revision: propA.revision,
      bugId: 41,
      baseVersion: iso(epoch),
      diff,
      visibility: "public",
      ttlMs: 60_000,
      nowMs: epoch,
    });
    const resolvedA = await service.resolveProposal(principalA, {
      idempotencyKey: "resolve-issuer-a",
      proposalId: propA.proposalId,
      revision: propA.revision,
      decision: "approve",
      approval: { kind: "cloud_signed_token", token: grantForA.token },
    });
    expect(resolvedA).toMatchObject({ outcome: "Applied", auditRecorded: true });

    const auditsA = await storage.listWriteAudits(issuerA, "alice", principalA.instanceUrl, 41);
    const auditsB = await storage.listWriteAudits(issuerB, "alice", principalB.instanceUrl, 41);
    expect(auditsA).toHaveLength(1);
    expect(auditsA[0]?.issuer).toBe(issuerA);
    expect(auditsB).toEqual([]);
  });

  // EVIDENCE-OF: R-970164
  test("rejects cloud approval tokens presented under a different issuer without consuming the JTI", async () => {
    const storage = createSqliteStorage(createTempDbPath("approval-issuer.sqlite"));
    const approvalService = createCloudApprovalTokenService("approval-secret-r970164", storage);
    const diff = { priority: "P1", publicComment: "Escalated" };

    const issued = await approvalService.issue({
      approverIssuer: issuerA,
      approverPrincipalId: "alice",
      instanceUrl: principalA.instanceUrl,
      proposalId: "prop-1",
      revision: 1,
      bugId: 41,
      baseVersion: iso(epoch),
      diff,
      visibility: "public",
      ttlMs: 60_000,
      nowMs: epoch,
    });

    const wrongIssuer = await approvalService.verifyAndConsume(issued.token, {
      approverIssuer: issuerB,
      approverPrincipalId: "alice",
      instanceUrl: principalB.instanceUrl,
      proposalId: "prop-1",
      revision: 1,
      bugId: 41,
      baseVersion: iso(epoch),
      diff,
      visibility: "public",
      nowMs: epoch + 1000,
    });
    expect(wrongIssuer).toEqual({ valid: false, reason: "binding_mismatch" });

    // Legitimate issuer can still consume its unspent token, and subsequent replay is blocked
    const validIssuer = await approvalService.verifyAndConsume(issued.token, {
      approverIssuer: issuerA,
      approverPrincipalId: "alice",
      instanceUrl: principalA.instanceUrl,
      proposalId: "prop-1",
      revision: 1,
      bugId: 41,
      baseVersion: iso(epoch),
      diff,
      visibility: "public",
      nowMs: epoch + 1000,
    });
    expect(validIssuer).toEqual({ valid: true });

    const replayed = await approvalService.verifyAndConsume(issued.token, {
      approverIssuer: issuerA,
      approverPrincipalId: "alice",
      instanceUrl: principalA.instanceUrl,
      proposalId: "prop-1",
      revision: 1,
      bugId: 41,
      baseVersion: iso(epoch),
      diff,
      visibility: "public",
      nowMs: epoch + 2000,
    });
    expect(replayed).toEqual({ valid: false, reason: "replayed" });
  });

  // EVIDENCE-OF: R-970164
  test("isolates event cursors and webhook subscriptions across issuers sharing principalId", async () => {
    const storage = createSqliteStorage(createTempDbPath("events-issuer.sqlite"));
    const clock = manualClock(epoch);
    const occurrences = [comment(11, iso(epoch + 1_000))];
    const deliveries: Array<{ url: string; body: string }> = [];
    const upstream = bugzilla({
      async listChangesSince({ since, offset, limit }) {
        const filtered = occurrences.filter(
          (occ) => Date.parse(occ.timestamp) >= Date.parse(since),
        );
        return {
          occurrences: filtered.slice(offset, offset + limit),
          scanComplete: offset + limit >= filtered.length,
        };
      },
    });
    const events = createSyntheticEventsService(
      dependencies(upstream.client, {
        storage,
        clock: clock.now,
        lagWindowMs: 2_000,
        webhookTransport: {
          async resolveHost() {
            return ["93.184.216.34"];
          },
          async postPinned(req) {
            const parsed = JSON.parse(req.rawBody) as { challenge?: string };
            if (parsed.challenge) {
              return {
                status: 200,
                body: JSON.stringify({ challenge: parsed.challenge }),
              };
            }
            deliveries.push({ url: req.url, body: req.rawBody });
            return { status: 202, body: "ok" };
          },
        },
      }),
    );

    // 1. Poll cursor minted for Issuer A MUST be rejected when presented by Issuer B
    const pollA = await events.poll(principalA, {
      name: "bugzilla.bug.commented",
      arguments: { bugIds: [41], includeSelf: false },
    });
    expect(pollA.cursor).toEqual(expect.any(String));
    await expect(
      events.poll(principalB, {
        name: "bugzilla.bug.commented",
        arguments: { bugIds: [41], includeSelf: false },
        cursor: pollA.cursor,
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // 2. Identical webhook (url, name, args) under Issuer A and Issuer B do not collide
    const secretA = `whsec_${Buffer.alloc(32, 0x41).toString("base64")}`;
    const secretB = `whsec_${Buffer.alloc(32, 0x42).toString("base64")}`;
    const subA = await events.subscribeWebhook(principalA, {
      name: "bugzilla.bug.commented",
      arguments: { bugIds: [41], includeSelf: false },
      delivery: {
        mode: "webhook",
        url: "https://hooks.example/bugzilla",
        secret: secretA,
      },
    });
    const subB = await events.subscribeWebhook(principalB, {
      name: "bugzilla.bug.commented",
      arguments: { bugIds: [41], includeSelf: false },
      delivery: {
        mode: "webhook",
        url: "https://hooks.example/bugzilla",
        secret: secretB,
      },
    });
    expect(subA.id).not.toBe(subB.id);
    expect(
      await storage.listWebhookSubscriptions({
        issuer: issuerA,
        principalId: "alice",
        instanceUrl: principalA.instanceUrl,
      }),
    ).toHaveLength(1);
    expect(
      await storage.listWebhookSubscriptions({
        issuer: issuerB,
        principalId: "alice",
        instanceUrl: principalB.instanceUrl,
      }),
    ).toHaveLength(1);

    // Unsubscribing Issuer B must NOT delete Issuer A's subscription
    await events.unsubscribeWebhook(principalB, {
      name: "bugzilla.bug.commented",
      arguments: { bugIds: [41], includeSelf: false },
      delivery: { mode: "webhook", url: "https://hooks.example/bugzilla" },
    });
    expect(
      await storage.listWebhookSubscriptions({
        issuer: issuerB,
        principalId: "alice",
        instanceUrl: principalB.instanceUrl,
      }),
    ).toEqual([]);
    expect(
      await storage.listWebhookSubscriptions({
        issuer: issuerA,
        principalId: "alice",
        instanceUrl: principalA.instanceUrl,
      }),
    ).toHaveLength(1);

    // Delivering for Issuer B sends nothing; delivering for Issuer A delivers its event
    clock.advance(5_000);
    expect(await events.deliverPendingWebhooks(principalB)).toMatchObject({ delivered: 0 });
    expect(deliveries).toHaveLength(0);
    expect(await events.deliverPendingWebhooks(principalA)).toMatchObject({ delivered: 1 });
    expect(deliveries).toHaveLength(1);
  });

  // EVIDENCE-OF: R-970164
  test("isolates HTTP tools, resources, and /approve tickets across issuers sharing principalId", async () => {
    const storage = createSqliteStorage(createTempDbPath("http-issuer.sqlite"));
    const upstream = bugzilla({
      async probeCapabilities() {
        return {
          version: "5.2",
          supportsHeaderAuth: true,
          authenticatedUser: "alice@example.test",
          isInsider: false,
        };
      },
    });
    const approvalService = createCloudApprovalTokenService(
      "http-approval-secret-r970164",
      storage,
    );
    const handler = createDualEraHttpHandler({
      mode: "cloud-multi-user",
      allowedOrigins: [origin],
      eventsProfile: "sep-3415",
      publicBaseUrl: "https://mcp.example",
      core: dependencies(upstream.client, {
        storage,
        cloudApprovalService: approvalService,
      }),
      authenticateBearerToken: async (token) => {
        if (token === "token-a") return principalA;
        if (token === "token-b") return principalB;
        return null;
      },
      verifyBindingOpenerSession: async (req) => {
        const cookie = req.headers.cookie ?? "";
        if (cookie.includes("sess=a")) return { issuer: issuerA, principalId: "alice" };
        if (cookie.includes("sess=b")) return { issuer: issuerB, principalId: "alice" };
        return null;
      },
    });

    const rpc = async (token: string, method: string, params: Record<string, unknown>, id = 1) => {
      const res = await handler.handleHttp({
        method: "POST",
        path: "/mcp",
        headers: {
          origin,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(typeof params.name === "string"
            ? { "mcp-name": params.name }
            : typeof params.uri === "string"
              ? { "mcp-name": params.uri }
              : {}),
        },
        rawBody: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      expect(res.status).toBe(200);
      return JSON.parse(res.body) as { result?: Record<string, unknown>; error?: unknown };
    };

    // Issuer A saves a draft, an internal note, and a pending proposal
    await rpc("token-a", "tools/call", {
      name: "app_save_draft",
      arguments: {
        bugId: 41,
        draftKind: "private_comment",
        draftRevision: 1,
        content: "Confidential Issuer A UI draft",
      },
    });
    await rpc("token-a", "tools/call", {
      name: "bugzilla_post_analysis",
      arguments: {
        idempotencyKey: "http-note-a",
        bugId: 41,
        analysisMarkdown: "Confidential Issuer A analysis note",
      },
    });
    const propRes = await rpc("token-a", "tools/call", {
      name: "bugzilla_propose_update",
      arguments: {
        idempotencyKey: "http-prop-a",
        bugId: 41,
        expectedLastChangeTime: iso(epoch),
        diff: { status: "ASSIGNED", publicComment: "Issuer A update" },
        rationale: "Issuer A fix",
      },
    });
    const propStructured = propRes.result?.structuredContent as { approvalUrl?: string };
    expect(propStructured.approvalUrl).toEqual(expect.stringContaining("/approve?t="));

    // Issuer B sees ZERO of Issuer A's drafts, internal notes, or proposals across every surface
    const fullB = (
      await rpc("token-b", "tools/call", {
        name: "app_get_bug_full",
        arguments: { bugId: 41 },
      })
    ).result?.structuredContent as {
      dossier: { internalNotes: unknown[] };
      draft: unknown;
      proposals: unknown[];
    };
    expect(fullB.dossier.internalNotes).toEqual([]);
    expect(fullB.draft).toBeNull();
    expect(fullB.proposals).toEqual([]);

    const boardB = (
      await rpc("token-b", "tools/call", {
        name: "bugzilla_triage_board",
        arguments: {},
      })
    ).result?.structuredContent as { bugs: Array<{ pendingProposalCount: number }> };
    expect(boardB.bugs[0]?.pendingProposalCount).toBe(0);

    const resA = (await rpc("token-a", "resources/read", { uri: "bugzilla://bug/41" })).result as {
      contents: Array<{ text: string }>;
    };
    const dossierA = JSON.parse(resA.contents[0]?.text ?? "{}") as { internalNotes: unknown[] };
    expect(dossierA.internalNotes).toHaveLength(1);

    const resB = (await rpc("token-b", "resources/read", { uri: "bugzilla://bug/41" })).result as {
      contents: Array<{ text: string }>;
    };
    const dossierB = JSON.parse(resB.contents[0]?.text ?? "{}") as { internalNotes: unknown[] };
    expect(dossierB.internalNotes).toEqual([]);

    // Issuer B cannot open Issuer A's /approve ticket
    const approvePath =
      new URL(propStructured.approvalUrl!).pathname + new URL(propStructured.approvalUrl!).search;
    const forbiddenGet = await handler.handleHttp({
      method: "GET",
      path: approvePath,
      headers: { cookie: "sess=b" },
      rawBody: "",
    });
    expect(forbiddenGet.status).toBe(403);

    // Issuer A CAN open its own /approve ticket
    const allowedGet = await handler.handleHttp({
      method: "GET",
      path: approvePath,
      headers: { cookie: "sess=a" },
      rawBody: "",
    });
    expect(allowedGet.status).toBe(200);
  });

  // EVIDENCE-OF: R-970164
  test("migrates a04c54f SQLite databases atomically, preserves sequence high-water marks, blocks legacy receipt redispatch, and rolls back on corrupt JSON", async () => {
    const dbPath = createTempDbPath("legacy-v2.sqlite");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      CREATE TABLE receipts (
        principal_id TEXT NOT NULL,
        instance_url TEXT NOT NULL,
        operation TEXT NOT NULL,
        idem_key TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        PRIMARY KEY (principal_id, instance_url, operation, idem_key)
      );
      CREATE TABLE write_audits (
        audit_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        instance_url TEXT NOT NULL,
        bug_id INTEGER NOT NULL,
        entry_json TEXT NOT NULL
      );
      CREATE TABLE internal_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        principal_id TEXT NOT NULL,
        instance_url TEXT NOT NULL,
        bug_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE proposals (
        principal_id TEXT NOT NULL,
        instance_url TEXT NOT NULL,
        proposal_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        proposal_json TEXT NOT NULL,
        PRIMARY KEY (principal_id, instance_url, proposal_id, revision)
      );
      CREATE TABLE drafts (
        principal_id TEXT NOT NULL,
        instance_url TEXT NOT NULL,
        bug_id INTEGER NOT NULL,
        draft_kind TEXT NOT NULL,
        draft_revision INTEGER NOT NULL,
        content TEXT NOT NULL,
        saved_at TEXT NOT NULL,
        PRIMARY KEY (principal_id, instance_url, bug_id, draft_kind)
      );
      CREATE TABLE webhook_subscriptions (
        principal_id TEXT NOT NULL,
        url TEXT NOT NULL,
        name TEXT NOT NULL,
        canonical_args_json TEXT NOT NULL,
        sub_json TEXT NOT NULL,
        PRIMARY KEY (principal_id, url, name, canonical_args_json)
      );
      CREATE TABLE webhook_retry_queue (
        subscription_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        next_attempt_at_ms INTEGER NOT NULL,
        PRIMARY KEY (subscription_id, event_id)
      );
      CREATE INDEX idx_write_audits_lookup ON write_audits (principal_id, instance_url, bug_id);
      CREATE INDEX idx_internal_notes_lookup ON internal_notes (principal_id, instance_url, bug_id);
    `);

    // Applied, pending, and indeterminate legacy receipts (ISO-02)
    const insertReceipt = legacyDb.prepare(
      `INSERT INTO receipts (principal_id, instance_url, operation, idem_key, receipt_json) VALUES (?, ?, ?, ?, ?)`,
    );
    insertReceipt.run(
      "alice",
      principalA.instanceUrl,
      "bugzilla_create_bug",
      "legacy-applied-key",
      JSON.stringify({ status: "applied", intentHash: "abc", artifactId: "bug:999" }),
    );
    insertReceipt.run(
      "alice",
      principalA.instanceUrl,
      "bugzilla_create_bug",
      "legacy-pending-key",
      JSON.stringify({ status: "pending", intentHash: "def", createdAt: iso(epoch) }),
    );
    insertReceipt.run(
      "alice",
      principalA.instanceUrl,
      "bugzilla_create_bug",
      "legacy-indeterminate-key",
      JSON.stringify({ status: "indeterminate", intentHash: "ghi", recordedAt: iso(epoch) }),
    );

    // Audit with mismatched embedded issuer to prove authoritative SQL issuer overwrites it (ISO-07)
    legacyDb
      .prepare(
        `INSERT INTO write_audits (audit_id, principal_id, instance_url, bug_id, entry_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "audit-legacy-1",
        "alice",
        principalA.instanceUrl,
        41,
        JSON.stringify({
          issuer: "https://spoofed-legacy.example",
          auditId: "audit-legacy-1",
          principalId: "alice",
          instanceUrl: principalA.instanceUrl,
          bugId: 41,
          proposalId: "p-legacy",
          revision: 1,
          expectedLastChangeTime: iso(epoch),
          updatedLastChangeTime: iso(epoch + 1000),
          diff: { status: "ASSIGNED" },
          recordedAt: iso(epoch + 1000),
        }),
      );

    // Insert 2 notes and delete the highest ID (#2) to verify sqlite_sequence preservation (ISO-12)
    const insertNote = legacyDb.prepare(
      `INSERT INTO internal_notes (principal_id, instance_url, bug_id, text, created_at) VALUES (?, ?, ?, ?, ?)`,
    );
    insertNote.run("alice", principalA.instanceUrl, 41, "legacy note 1", iso(epoch));
    insertNote.run("alice", principalA.instanceUrl, 41, "legacy note 2 (deleted)", iso(epoch));
    legacyDb.exec(`DELETE FROM internal_notes WHERE id = 2`);

    // Exact a04c54f proposal payload (state: "pending", empty embedded issuer)
    legacyDb
      .prepare(
        `INSERT INTO proposals (principal_id, instance_url, proposal_id, revision, proposal_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "alice",
        principalA.instanceUrl,
        "p-legacy",
        1,
        JSON.stringify({
          issuer: "",
          proposalId: "p-legacy",
          revision: 1,
          principalId: "alice",
          instanceUrl: principalA.instanceUrl,
          bugId: 41,
          baseVersion: iso(epoch),
          diff: { status: "ASSIGNED" },
          rationale: "legacy",
          state: "pending",
          createdAt: iso(epoch),
        }),
      );
    legacyDb
      .prepare(
        `INSERT INTO drafts (principal_id, instance_url, bug_id, draft_kind, draft_revision, content, saved_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("alice", principalA.instanceUrl, 41, "private_comment", 1, "legacy draft", iso(epoch));

    // Exact a04c54f webhook subscription payload (`secret`, real encoded cursor watermark, full retry item)
    const legacyWatermark = Buffer.from(
      JSON.stringify({ v: 1, scope: "legacy-scope", ts: epoch, tie: "comment-1" }),
      "utf8",
    ).toString("base64url");
    legacyDb
      .prepare(
        `INSERT INTO webhook_subscriptions (principal_id, url, name, canonical_args_json, sub_json) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "alice",
        "https://hooks.example/legacy",
        "bugzilla.bug.commented",
        "{}",
        JSON.stringify({
          issuer: null,
          id: "sub_legacy_1",
          principalId: "alice",
          instanceUrl: principalA.instanceUrl,
          url: "https://hooks.example/legacy",
          name: "bugzilla.bug.commented",
          args: { includeSelf: false },
          canonicalArgsJson: "{}",
          secret: `whsec_${Buffer.alloc(32, 0x55).toString("base64")}`,
          verified: true,
          safeWatermark: legacyWatermark,
          refreshBefore: null,
          gapPending: false,
        }),
      );
    legacyDb
      .prepare(
        `INSERT INTO webhook_retry_queue (subscription_id, event_id, payload_json, attempts, next_attempt_at_ms) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        "sub_legacy_1",
        "evt_legacy_1",
        JSON.stringify({
          eventId: "evt_legacy_1",
          bugId: 41,
          tsMs: epoch + 1000,
          tieKey: "comment-1",
          occurrence: {
            id: "evt_legacy_1",
            name: "bugzilla.bug.commented",
            timestamp: iso(epoch + 1000),
            payload: { bugId: 41 },
          },
          attempts: 1,
          nextAttemptAtMs: epoch + 2000,
        }),
        1,
        epoch + 2000,
      );
    legacyDb.close();

    // Opening with createSqliteStorage migrates all 6 tables + indexes atomically and is idempotent
    const storage1 = createSqliteStorage(dbPath);
    const storage = createSqliteStorage(dbPath);
    expect(storage1).toBeDefined();

    // Live issuers MUST NOT read migrated legacy rows
    expect(await storage.listWriteAudits(issuerA, "alice", principalA.instanceUrl, 41)).toEqual([]);
    expect(await storage.listInternalNotes(issuerA, "alice", principalA.instanceUrl, 41)).toEqual(
      [],
    );
    expect(
      await storage.getProposal(issuerA, "alice", principalA.instanceUrl, "p-legacy", 1),
    ).toBeNull();
    expect(
      await storage.getDraft({
        issuer: issuerA,
        principalId: "alice",
        instanceUrl: principalA.instanceUrl,
        bugId: 41,
        draftKind: "private_comment",
      }),
    ).toBeNull();
    expect(
      await storage.listWebhookSubscriptions({
        issuer: issuerA,
        principalId: "alice",
        instanceUrl: principalA.instanceUrl,
      }),
    ).toEqual([]);

    // ISO-02: Live issuer retrying ANY non-failed legacy receipt is blocked as OperationIndeterminate
    // without dispatching upstream or disclosing the legacy artifactId
    const upstream = bugzilla();
    const writeGuard = createWriteGuardService(dependencies(upstream.client, { storage }));
    for (const key of ["legacy-applied-key", "legacy-pending-key", "legacy-indeterminate-key"]) {
      const outcome = await writeGuard.createBug(principalA, {
        idempotencyKey: key,
        product: "Browser",
        component: "Layout",
        version: "1",
        summary: "Retry after upgrade",
        description: "Must not duplicate",
      });
      expect(outcome).toMatchObject({ outcome: "OperationIndeterminate", idempotencyKey: key });
      expect(JSON.stringify(outcome)).not.toContain("bug:999");
    }
    expect(upstream.mutations).toEqual([]);

    // ISO-12: New note MUST NOT reuse deleted ID #2
    const postUpgradeNote = await storage.saveInternalNote(
      issuerA,
      "alice",
      principalA.instanceUrl,
      41,
      "post-upgrade note",
    );
    expect(Number(postUpgradeNote.id)).toBeGreaterThanOrEqual(3);

    // ISO-07: Legacy rows are preserved with authoritative issuer overwriting spoofed/empty/null JSON issuer
    const migratedAudits = await storage.listWriteAudits(
      LEGACY_ISSUER,
      "alice",
      principalA.instanceUrl,
      41,
    );
    expect(migratedAudits).toHaveLength(1);
    expect(migratedAudits[0]?.issuer).toBe(LEGACY_ISSUER);

    const migratedProposal = await storage.getProposal(
      LEGACY_ISSUER,
      "alice",
      principalA.instanceUrl,
      "p-legacy",
      1,
    );
    expect(migratedProposal?.issuer).toBe(LEGACY_ISSUER);
    expect(migratedProposal?.state).toBe("pending");

    const migratedSubs = await storage.listWebhookSubscriptions({
      issuer: LEGACY_ISSUER,
      principalId: "alice",
      instanceUrl: principalA.instanceUrl,
    });
    expect(migratedSubs).toHaveLength(1);
    expect(migratedSubs[0]?.issuer).toBe(LEGACY_ISSUER);
    expect(migratedSubs[0]?.safeWatermark).toBe(legacyWatermark);
    expect(await storage.listWebhookRetryItems?.("sub_legacy_1")).toHaveLength(1);

    // ISO-02/ISO-07 rollback: corrupt/null/array receipts fail migration and roll back cleanly
    for (const badPayload of ["{not-json", "null", "[]"]) {
      const badReceiptPath = createTempDbPath("corrupt-receipt.sqlite");
      const badDb = new DatabaseSync(badReceiptPath);
      badDb.exec(`
        CREATE TABLE receipts (
          principal_id TEXT NOT NULL,
          instance_url TEXT NOT NULL,
          operation TEXT NOT NULL,
          idem_key TEXT NOT NULL,
          receipt_json TEXT NOT NULL,
          PRIMARY KEY (principal_id, instance_url, operation, idem_key)
        );
      `);
      badDb
        .prepare(`INSERT INTO receipts VALUES ('alice', 'https://bugzilla.example', 'op', 'k1', ?)`)
        .run(badPayload);
      badDb.close();
      expect(() => createSqliteStorage(badReceiptPath)).toThrow(/Failed to migrate receipts/i);
      const checkDb = new DatabaseSync(badReceiptPath);
      const receiptCols = checkDb.prepare(`PRAGMA table_info(receipts)`).all() as Array<{
        name: string;
      }>;
      checkDb.close();
      expect(receiptCols.some((c) => c.name === "issuer")).toBe(false);
    }

    // ISO-11 rollback: failure during index creation rolls back ALL 6 migrated tables atomically
    const idxFailPath = createTempDbPath("idx-fail-legacy.sqlite");
    const idxFailDb = new DatabaseSync(idxFailPath);
    idxFailDb.exec(`
      CREATE TABLE receipts (
        principal_id TEXT NOT NULL,
        instance_url TEXT NOT NULL,
        operation TEXT NOT NULL,
        idem_key TEXT NOT NULL,
        receipt_json TEXT NOT NULL,
        PRIMARY KEY (principal_id, instance_url, operation, idem_key)
      );
      CREATE TABLE idx_write_audits_lookup (collision INTEGER);
    `);
    idxFailDb.close();
    expect(() => createSqliteStorage(idxFailPath)).toThrow();
    const checkIdxFail = new DatabaseSync(idxFailPath);
    const receiptsAfterIdxFail = checkIdxFail
      .prepare(`PRAGMA table_info(receipts)`)
      .all() as Array<{
      name: string;
    }>;
    checkIdxFail.close();
    expect(receiptsAfterIdxFail.some((c) => c.name === "issuer")).toBe(false);

    // ISO-12: empty internal_notes with sqlite_sequence above Number.MAX_SAFE_INTEGER migrates
    // cleanly AND preserves exact 64-bit string IDs across subsequent saves and listInternalNotes
    const bigSeqPath = createTempDbPath("big-seq-legacy.sqlite");
    const bigSeqDb = new DatabaseSync(bigSeqPath);
    bigSeqDb.exec(`
      CREATE TABLE internal_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        principal_id TEXT NOT NULL,
        instance_url TEXT NOT NULL,
        bug_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      INSERT INTO internal_notes (id, principal_id, instance_url, bug_id, text, created_at)
      VALUES (9007199254740993, 'alice', 'https://bugzilla.example', 41, 'huge', '${iso(epoch)}');
      DELETE FROM internal_notes;
    `);
    bigSeqDb.close();
    const bigSeqStorage = createSqliteStorage(bigSeqPath);
    const noteNext1 = await bigSeqStorage.saveInternalNote(
      issuerA,
      "alice",
      principalA.instanceUrl,
      41,
      "post-big-seq-1",
    );
    const noteNext2 = await bigSeqStorage.saveInternalNote(
      issuerA,
      "alice",
      principalA.instanceUrl,
      41,
      "post-big-seq-2",
    );
    expect(noteNext1.id).toBe("9007199254740994");
    expect(noteNext2.id).toBe("9007199254740995");
    const listedBigNotes = await bigSeqStorage.listInternalNotes(
      issuerA,
      "alice",
      principalA.instanceUrl,
      41,
    );
    expect(listedBigNotes.map((n) => n.id)).toEqual(["9007199254740994", "9007199254740995"]);

    // ISO-07 rollback: corrupt JSON in a pre-v3 write_audits DB fails migration and rolls back cleanly
    const corruptDbPath = createTempDbPath("corrupt-legacy.sqlite");
    const corruptDb = new DatabaseSync(corruptDbPath);
    corruptDb.exec(`
      CREATE TABLE write_audits (
        audit_id TEXT PRIMARY KEY,
        principal_id TEXT NOT NULL,
        instance_url TEXT NOT NULL,
        bug_id INTEGER NOT NULL,
        entry_json TEXT NOT NULL
      );
      INSERT INTO write_audits VALUES ('bad-1', 'alice', 'https://bugzilla.example', 41, '{not-json');
    `);
    corruptDb.close();
    expect(() => createSqliteStorage(corruptDbPath)).toThrow(/malformed JSON/i);
    const verifyRollbackDb = new DatabaseSync(corruptDbPath);
    const cols = verifyRollbackDb.prepare(`PRAGMA table_info(write_audits)`).all() as Array<{
      name: string;
    }>;
    verifyRollbackDb.close();
    expect(cols.some((c) => c.name === "issuer")).toBe(false);
  });

  // EVIDENCE-OF: R-970164
  test("ISO-01: isolates identical webhook callbacks across two Bugzilla instances with pending retries, restart, and unsubscribe", async () => {
    const dbPath = createTempDbPath("multi-instance-webhook.sqlite");
    const clock = manualClock(epoch);
    const instance1 = "https://bz-one.example";
    const instance2 = "https://bz-two.example";
    const ctx1: PrincipalContext = { ...principalA, instanceUrl: instance1 };
    const ctx2: PrincipalContext = { ...principalA, instanceUrl: instance2 };

    const occ1 = [comment(101, iso(epoch + 1_000), { commentText: "from-instance-1" })];
    const occ2 = [comment(101, iso(epoch + 1_000), { commentText: "from-instance-2" })];
    let failFirstDelivery = true;
    const deliveredBodies: string[] = [];

    const makeEvents = () => {
      const storage = createSqliteStorage(dbPath);
      const client1 = bugzilla({
        async listChangesSince({ since }) {
          return {
            occurrences: occ1.filter((o) => Date.parse(o.timestamp) >= Date.parse(since)),
            scanComplete: true,
          };
        },
      }).client;
      const client2 = bugzilla({
        async listChangesSince({ since }) {
          return {
            occurrences: occ2.filter((o) => Date.parse(o.timestamp) >= Date.parse(since)),
            scanComplete: true,
          };
        },
      }).client;
      return {
        storage,
        events: createSyntheticEventsService(
          dependencies(client1, {
            storage,
            clock: clock.now,
            lagWindowMs: 2_000,
            resolveClient: async (ctx) => (ctx.instanceUrl === instance1 ? client1 : client2),
            webhookTransport: {
              async resolveHost() {
                return ["93.184.216.34"];
              },
              async postPinned(req) {
                const parsed = JSON.parse(req.rawBody) as { challenge?: string };
                if (parsed.challenge) {
                  return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
                }
                if (failFirstDelivery) {
                  failFirstDelivery = false;
                  return { status: 503, body: "retry" };
                }
                deliveredBodies.push(req.rawBody);
                return { status: 202, body: "ok" };
              },
            },
          }),
        ),
      };
    };

    const firstRun = makeEvents();
    const sharedUrl = "https://hooks.example/shared-cb";
    const sub1 = await firstRun.events.subscribeWebhook(ctx1, {
      name: "bugzilla.bug.commented",
      arguments: { bugIds: [41], includeSelf: false },
      delivery: {
        mode: "webhook",
        url: sharedUrl,
        secret: `whsec_${Buffer.alloc(32, 0x11).toString("base64")}`,
      },
    });
    const sub2 = await firstRun.events.subscribeWebhook(ctx2, {
      name: "bugzilla.bug.commented",
      arguments: { bugIds: [41], includeSelf: false },
      delivery: {
        mode: "webhook",
        url: sharedUrl,
        secret: `whsec_${Buffer.alloc(32, 0x22).toString("base64")}`,
      },
    });
    expect(sub1.id).not.toBe(sub2.id);

    // Trigger retry queue item on instance1 (503 on first attempt)
    clock.advance(5_000);
    await firstRun.events.deliverPendingWebhooks(ctx1);
    expect(await firstRun.storage.listWebhookRetryItems?.(sub1.id)).toHaveLength(1);
    expect(await firstRun.storage.listWebhookRetryItems?.(sub2.id)).toEqual([]);

    // Simulate restart: deliver instance2 MUST deliver its own event and MUST NOT pull instance1's retry item
    const restarted = makeEvents();
    clock.advance(5_000);
    await restarted.events.deliverPendingWebhooks(ctx2);
    expect(deliveredBodies.length).toBeGreaterThanOrEqual(1);
    expect(deliveredBodies.every((body) => body.includes("from-instance-2"))).toBe(true);
    expect(deliveredBodies.some((body) => body.includes("from-instance-1"))).toBe(false);

    await restarted.events.unsubscribeWebhook(ctx1, {
      name: "bugzilla.bug.commented",
      arguments: { bugIds: [41], includeSelf: false },
      delivery: { mode: "webhook", url: sharedUrl },
    });
    expect(
      await restarted.storage.listWebhookSubscriptions({
        issuer: ctx1.issuer,
        principalId: ctx1.principalId,
        instanceUrl: instance1,
      }),
    ).toEqual([]);
    expect(
      await restarted.storage.listWebhookSubscriptions({
        issuer: ctx2.issuer,
        principalId: ctx2.principalId,
        instanceUrl: instance2,
      }),
    ).toHaveLength(1);
  });

  // EVIDENCE-OF: R-970164
  test("ISO-03: isolates failing principals and corrupt subscription watermarks in webhook delivery loop", async () => {
    const storage = createSqliteStorage(createTempDbPath("delivery-loop-iso03.sqlite"));
    const clock = manualClock(epoch);
    const deliveries: string[] = [];
    const healthyDelivered = deferred<void>();
    const upstreamB = bugzilla({
      async listChangesSince({ since }) {
        const occ = comment(77, iso(epoch + 1_000));
        return {
          occurrences: Date.parse(occ.timestamp) >= Date.parse(since) ? [occ] : [],
          scanComplete: true,
        };
      },
    }).client;

    const events = createSyntheticEventsService(
      dependencies(upstreamB, {
        storage,
        clock: clock.now,
        lagWindowMs: 2_000,
        resolveClient: async (ctx) => {
          if (ctx.issuer === issuerA) {
            throw new Error("Transient Issuer A resolver failure");
          }
          return upstreamB;
        },
        webhookTransport: {
          async resolveHost() {
            return ["93.184.216.34"];
          },
          async postPinned(req) {
            const parsed = JSON.parse(req.rawBody) as { challenge?: string };
            if (parsed.challenge) {
              return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
            }
            deliveries.push(req.url);
            if (req.url === "https://hooks.example/healthy") {
              healthyDelivered.resolve();
            }
            return { status: 202, body: "ok" };
          },
        },
      }),
    );

    // Mint a real cursor for principalB's exact scope, then tamper ONLY its timestamp 1ms past JS Date max (ISO-03, ISO-13)
    const validPollB = await events.poll(principalB, {
      name: "bugzilla.bug.commented",
      arguments: { bugIds: [41], includeSelf: false },
    });
    const decodedValid = JSON.parse(
      Buffer.from(validPollB.cursor!, "base64url").toString("utf8"),
    ) as { v: number; scope: string; ts: number; tie: string };
    const outOfRangeWm = Buffer.from(
      JSON.stringify({ ...decodedValid, ts: 8_640_000_000_000_001 }),
      "utf8",
    ).toString("base64url");
    // Direct poll with validly scoped out-of-range timestamp MUST reject with INVALID_PARAMS
    await expect(
      events.poll(principalB, {
        name: "bugzilla.bug.commented",
        arguments: { bugIds: [41], includeSelf: false },
        cursor: outOfRangeWm,
      }),
    ).rejects.toMatchObject({ code: -32602 });

    // Seed an empty-string watermark, a corrupt watermark, a valid-scope out-of-range date watermark
    // (all with gapPending: true), AND a healthy subscription under Issuer B (ISO-03)
    await storage.upsertWebhookSubscription({
      id: "sub_empty_wm",
      issuer: issuerB,
      principalId: "alice",
      instanceUrl: principalB.instanceUrl,
      url: "https://hooks.example/empty-wm",
      name: "bugzilla.bug.commented",
      args: { bugIds: [41], includeSelf: false },
      canonicalArgsJson: '{"bugIds":[41],"includeSelf":false}',
      secret: `whsec_${Buffer.alloc(32, 0x31).toString("base64")}`,
      verified: true,
      safeWatermark: "",
      refreshBefore: null,
      gapPending: true,
    });
    await storage.upsertWebhookSubscription({
      id: "sub_corrupt_wm",
      issuer: issuerB,
      principalId: "alice",
      instanceUrl: principalB.instanceUrl,
      url: "https://hooks.example/corrupt",
      name: "bugzilla.bug.commented",
      args: { bugIds: [41], includeSelf: false },
      canonicalArgsJson: '{"bugIds":[41],"includeSelf":false}',
      secret: `whsec_${Buffer.alloc(32, 0x33).toString("base64")}`,
      verified: true,
      safeWatermark: "corrupt-invalid-watermark",
      refreshBefore: null,
      gapPending: true,
    });
    await storage.upsertWebhookSubscription({
      id: "sub_oob_date_wm",
      issuer: issuerB,
      principalId: "alice",
      instanceUrl: principalB.instanceUrl,
      url: "https://hooks.example/oob-date",
      name: "bugzilla.bug.commented",
      args: { bugIds: [41], includeSelf: false },
      canonicalArgsJson: '{"bugIds":[41],"includeSelf":false}',
      secret: `whsec_${Buffer.alloc(32, 0x35).toString("base64")}`,
      verified: true,
      safeWatermark: outOfRangeWm,
      refreshBefore: null,
      gapPending: true,
    });
    await events.subscribeWebhook(principalB, {
      name: "bugzilla.bug.commented",
      arguments: { bugIds: [41], includeSelf: false },
      delivery: {
        mode: "webhook",
        url: "https://hooks.example/healthy",
        secret: `whsec_${Buffer.alloc(32, 0x44).toString("base64")}`,
      },
    });

    clock.advance(5_000);
    // Direct complete pass verifies all bad subscriptions are skipped before gap/scan and healthy delivers
    const directResult = await events.deliverPendingWebhooks(principalB);
    expect(directResult.delivered).toBe(1);
    expect(deliveries).toEqual(["https://hooks.example/healthy"]);

    // Verify delivery loop isolates failing principalA and still executes principalB on the same tick
    const secondTickDone = deferred<void>();
    const loopErrors: unknown[] = [];
    const loop = startWebhookDeliveryLoop({
      events: {
        ...events,
        async deliverPendingWebhooks(ctx) {
          const out = await events.deliverPendingWebhooks(ctx);
          if (ctx.issuer === issuerB) secondTickDone.resolve();
          return out;
        },
      },
      listPrincipals: async () => [principalA, principalB],
      intervalMs: 10,
      onError: (err) => loopErrors.push(err),
    });
    try {
      await secondTickDone.promise;
    } finally {
      loop.stop();
    }
    expect(loopErrors.length).toBeGreaterThanOrEqual(1);
    expect(deliveries).toEqual(["https://hooks.example/healthy"]);
  });

  // EVIDENCE-OF: R-970164
  test("ISO-04, ISO-06, ISO-08, ISO-09, ISO-10: enforces board tenantKey, immutable composite audit PK, legacy issuer rejection, legacy session ownership, and structured claim lock", async () => {
    const storage = createSqliteStorage(createTempDbPath("hardening-iso.sqlite"));

    // ISO-06: same auditId coexists across issuers and is immutable within a tenant
    const baseAudit = {
      auditId: "shared-audit-id",
      principalId: "alice",
      instanceUrl: principalA.instanceUrl,
      bugId: 41,
      proposalId: "prop-1",
      revision: 1,
      expectedLastChangeTime: iso(epoch),
      updatedLastChangeTime: iso(epoch + 1_000),
      diff: { status: "ASSIGNED" },
      recordedAt: iso(epoch + 1_000),
    };
    await storage.recordWriteAudit({ ...baseAudit, issuer: issuerA });
    await storage.recordWriteAudit({
      ...baseAudit,
      issuer: issuerB,
      diff: { status: "RESOLVED" },
    });
    await storage.recordWriteAudit({
      ...baseAudit,
      issuer: issuerA,
      diff: { status: "WONTFIX" },
    });
    const auditsA = await storage.listWriteAudits(issuerA, "alice", principalA.instanceUrl, 41);
    const auditsB = await storage.listWriteAudits(issuerB, "alice", principalB.instanceUrl, 41);
    expect(auditsA).toHaveLength(1);
    expect(auditsA[0]?.diff).toEqual({ status: "ASSIGNED" });
    expect(auditsB).toHaveLength(1);
    expect(auditsB[0]?.diff).toEqual({ status: "RESOLVED" });

    // ISO-08: PrincipalContextSchema, HTTP auth, and stdio reject RESERVED_LEGACY_ISSUER
    expect(
      PrincipalContextSchema.safeParse({ ...principalA, issuer: RESERVED_LEGACY_ISSUER }).success,
    ).toBe(false);
    const upstream = bugzilla();
    expect(() =>
      createStdioRpcProcessor({
        config: {
          mode: "local-trusted-ide",
          allowedOrigins: [],
          eventsProfile: "sep-3415",
          core: dependencies(upstream.client, { storage }),
        },
        principal: { ...principalA, issuer: RESERVED_LEGACY_ISSUER },
      }),
    ).toThrow(/Reserved legacy issuer/i);

    const handler = createDualEraHttpHandler({
      mode: "cloud-multi-user",
      allowedOrigins: [origin],
      eventsProfile: "sep-3415",
      publicBaseUrl: "https://mcp.example",
      core: dependencies(upstream.client, { storage }),
      authenticateBearerToken: async (token) => {
        if (token === "tok-a") return principalA;
        if (token === "tok-b") return principalB;
        if (token === "tok-legacy") return { ...principalA, issuer: RESERVED_LEGACY_ISSUER };
        return null;
      },
    });

    const legacyAuthResp = await handler.handleHttp({
      method: "POST",
      path: "/mcp",
      headers: {
        origin,
        authorization: "Bearer tok-legacy",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/list",
      },
      rawBody: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    expect(legacyAuthResp.status).toBe(401);

    // ISO-04: bugzilla_triage_board returns distinct tenantKey across issuers sharing (principalId, instanceUrl)
    const callBoard = async (token: string) => {
      const res = await handler.handleHttp({
        method: "POST",
        path: "/mcp",
        headers: {
          origin,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "bugzilla_triage_board",
        },
        rawBody: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "bugzilla_triage_board",
            arguments: {},
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      expect(res.status).toBe(200);
      return (
        JSON.parse(res.body) as {
          result: {
            structuredContent: {
              tenantKey?: string;
              instanceUrl: string;
              principalId: string;
              deploymentMode: "cloud-multi-user";
              fetchedAt: string;
              bugs: [];
              proposals: [];
            };
          };
        }
      ).result.structuredContent;
    };
    const boardA = await callBoard("tok-a");
    const boardB = await callBoard("tok-b");
    expect(boardA.tenantKey).toEqual(expect.any(String));
    expect(boardB.tenantKey).toEqual(expect.any(String));
    expect(resolveBoardTenantKey(boardA)).not.toBe(resolveBoardTenantKey(boardB));

    // ISO-04-B: Consecutive legacy a04c54f boards (principalId + instanceUrl, no issuer/tenantKey)
    // MUST receive distinct fresh keys so two issuers never share draft state
    let legacySeq = 0;
    const legacyBoard1 = normalizeBoardTenantKey(
      { principalId: "alice", instanceUrl: principalA.instanceUrl },
      () => `anon-${++legacySeq}`,
    );
    const legacyBoard2 = normalizeBoardTenantKey(
      { principalId: "alice", instanceUrl: principalA.instanceUrl },
      () => `anon-${++legacySeq}`,
    );
    const missingPrincipalBoard = normalizeBoardTenantKey({}, () => `anon-${++legacySeq}`);
    expect(legacyBoard1.tenantKey).not.toBe(legacyBoard2.tenantKey);
    expect(missingPrincipalBoard.tenantKey).toBe("anon-3");

    // ISO-04-B: inline bugzilla_get_dossier ALSO carries distinct tenantKey per issuer
    const callDossier = async (token: string) => {
      const res = await handler.handleHttp({
        method: "POST",
        path: "/mcp",
        headers: {
          origin,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": "bugzilla_get_dossier",
        },
        rawBody: JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "bugzilla_get_dossier",
            arguments: { bugId: 41 },
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        }),
      });
      expect(res.status).toBe(200);
      return (JSON.parse(res.body) as { result: { structuredContent: { tenantKey?: string } } })
        .result.structuredContent;
    };
    const dossierResA = await callDossier("tok-a");
    const dossierResB = await callDossier("tok-b");
    expect(dossierResA.tenantKey).toBe(boardA.tenantKey);
    expect(dossierResB.tenantKey).toBe(boardB.tenantKey);
    expect(dossierResA.tenantKey).not.toBe(dossierResB.tenantKey);

    // ISO-09: Unauthenticated / invalid-bearer legacy initialize returns 401 and allocates no session
    for (const authHeader of [undefined, "Bearer invalid-token"]) {
      const unauthInit = await handler.handleHttp({
        method: "POST",
        path: "/mcp",
        headers: {
          origin,
          ...(authHeader ? { authorization: authHeader } : {}),
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": MCP_PROTOCOL_LEGACY,
        },
        rawBody: JSON.stringify({
          jsonrpc: "2.0",
          id: 9,
          method: "initialize",
          params: {
            protocolVersion: MCP_PROTOCOL_LEGACY,
            capabilities: {},
            clientInfo: { name: "x", version: "1" },
          },
        }),
      });
      expect(unauthInit.status).toBe(401);
      expect(unauthInit.headers["Mcp-Session-Id"]).toBeUndefined();
    }

    // ISO-09: Local HTTP mode with missing/empty localAuthToken and no bearer verifier fails closed
    const localUnconfigured = createDualEraHttpHandler({
      mode: "local-trusted-ide",
      allowedOrigins: [origin],
      eventsProfile: "sep-3415",
      core: dependencies(upstream.client, { storage }),
    });
    const localUnauthInit = await localUnconfigured.handleHttp({
      method: "POST",
      path: "/mcp",
      headers: {
        origin,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_LEGACY,
      },
      rawBody: JSON.stringify({
        jsonrpc: "2.0",
        id: 91,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_LEGACY,
          capabilities: {},
          clientInfo: { name: "x", version: "1" },
        },
      }),
    });
    expect(localUnauthInit.status).toBe(401);
    expect(localUnauthInit.headers["Mcp-Session-Id"]).toBeUndefined();

    // ISO-09: Legacy 2025-11-25 session initialized by Issuer A rejects Issuer B on initialized & tools/list
    const initRes = await handler.handleHttp({
      method: "POST",
      path: "/mcp",
      headers: {
        origin,
        authorization: "Bearer tok-a",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_LEGACY,
      },
      rawBody: JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_LEGACY,
          capabilities: {},
          clientInfo: { name: "x", version: "1" },
        },
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers["Mcp-Session-Id"] ?? initRes.headers["mcp-session-id"];
    expect(sessionId).toEqual(expect.any(String));

    const hijackNotify = await handler.handleHttp({
      method: "POST",
      path: "/mcp",
      headers: {
        origin,
        authorization: "Bearer tok-b",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_LEGACY,
        "mcp-session-id": sessionId,
      },
      rawBody: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    });
    expect(hijackNotify.status).toBe(403);

    const hijackList = await handler.handleHttp({
      method: "POST",
      path: "/mcp",
      headers: {
        origin,
        authorization: "Bearer tok-b",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": MCP_PROTOCOL_LEGACY,
        "mcp-session-id": sessionId,
      },
      rawBody: JSON.stringify({ jsonrpc: "2.0", id: 11, method: "tools/list", params: {} }),
    });
    expect(hijackList.status).toBe(403);

    // ISO-10: Delimiter-containing identifiers with identical proposalId do not collide in in-flight proposal claim lock
    const gate = deferred<void>();
    const bothEntered = deferred<void>();
    let enteredCount = 0;
    const slowUpstream = bugzilla({
      async applyBugUpdate(id, diff) {
        enteredCount += 1;
        if (enteredCount === 2) bothEntered.resolve();
        await gate.promise;
        return upstream.client.applyBugUpdate(id, diff);
      },
    });
    const wg = createWriteGuardService(
      dependencies(slowUpstream.client, {
        storage,
        cloudApprovalService: createCloudApprovalTokenService("iso10-secret", storage),
      }),
    );
    const ctxDelim1: PrincipalContext = {
      ...principalA,
      issuer: "https://idp.example/a|b",
      principalId: "c",
      deploymentMode: "local-trusted-ide",
    };
    const ctxDelim2: PrincipalContext = {
      ...principalA,
      issuer: "https://idp.example/a",
      principalId: "b|c",
      deploymentMode: "local-trusted-ide",
    };
    for (const ctx of [ctxDelim1, ctxDelim2]) {
      await storage.saveProposal({
        proposalId: "prop-same-id",
        revision: 1,
        issuer: ctx.issuer,
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
        bugId: 41,
        baseVersion: iso(epoch),
        diff: { status: "ASSIGNED" },
        rationale: "delimiter collision check",
        state: "pending",
      });
    }
    const r1 = wg.resolveProposal(ctxDelim1, {
      idempotencyKey: "delim-r1",
      proposalId: "prop-same-id",
      revision: 1,
      decision: "approve",
      approval: { kind: "local_ide_host_confirmed", confirmedAt: iso(epoch) },
    });
    const r2 = wg.resolveProposal(ctxDelim2, {
      idempotencyKey: "delim-r2",
      proposalId: "prop-same-id",
      revision: 1,
      decision: "approve",
      approval: { kind: "local_ide_host_confirmed", confirmedAt: iso(epoch) },
    });
    // Both resolutions must enter applyBugUpdate concurrently without lock contention
    await bothEntered.promise;
    gate.resolve();
    const [out1, out2] = await Promise.all([r1, r2]);
    expect(out1).toMatchObject({ outcome: "Applied" });
    expect(out2).toMatchObject({ outcome: "Applied" });
  });
});
