import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, test } from "vite-plus/test";
import {
  createBoundedIdempotencyKey,
  isSafeHttpUrl,
  unwrapToolResult,
} from "../packages/app-ui/src/index.js";
import {
  BugzillaAccessDeniedError,
  BugzillaCredentialRevokedError,
  BugzillaRateLimitError,
  BugzillaTransientError,
  BugzillaValidationError,
  classifyResponseOutcome,
  createRestBugzillaClient,
  extractMissingFields,
} from "../packages/bugzilla-client/src/index.js";
import {
  MCP_PROTOCOL_LEGACY,
  MCP_PROTOCOL_MODERN,
  type PrincipalContext,
} from "../packages/contracts/src/index.js";
import {
  canonicalJson,
  createCloudApprovalTokenService,
  createSyntheticEventsService,
  createWriteGuardService,
  normalizeArgsForCanonical,
  type WebhookOutboundTransport,
  type WebhookScanState,
} from "../packages/core/src/index.js";
import {
  createDualEraHttpHandler,
  createStdioRpcProcessor,
  type DualEraHttpRequest,
  type DualEraHttpResponse,
  type HttpServerConfig,
} from "../packages/server/src/index.js";
import { createSqliteStorage, type StoragePorts } from "../packages/storage/src/index.js";
import {
  bugzilla,
  comment,
  dependencies,
  epoch,
  iso,
  manualClock,
  memoryStorage,
  origin,
  principal,
} from "./helpers/fakes.js";

const serviceUrl = "https://mcp.example";
const bearer = "track-a-bearer-token";
const signingSecret = "track-a-signing-secret-0123456789abcdef0123456789";

function parseRpc(response: DualEraHttpResponse): Record<string, unknown> {
  const line = response.body.split("\n").find((entry) => entry.startsWith("data:"));
  return JSON.parse(line ? line.slice("data:".length) : response.body) as Record<string, unknown>;
}

function modernRequest(
  method: string,
  params: Record<string, unknown>,
  extraHeaders: Record<string, string | undefined> = {},
): DualEraHttpRequest {
  const name = typeof params.name === "string" ? params.name : undefined;
  return {
    method: "POST",
    path: "/mcp",
    headers: {
      origin,
      authorization: `Bearer ${bearer}`,
      "mcp-protocol-version": MCP_PROTOCOL_MODERN,
      "mcp-method": method,
      ...(name !== undefined ? { "mcp-name": name } : {}),
      ...extraHeaders,
    },
    rawBody: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method,
      params: {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_MODERN,
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  };
}

describe("Track A postmortem & red-team regressions", () => {
  test("bugzilla_create_bug missing component/version returns isError structured issues with zero upstream writes or receipt pollution", async () => {
    const storage = createSqliteStorage(":memory:");
    const upstream = bugzilla();
    const handler = createDualEraHttpHandler({
      mode: "cloud-multi-user",
      allowedOrigins: [origin],
      allowAbsentOrigin: true,
      eventsProfile: "sep-3415",
      publicBaseUrl: serviceUrl,
      core: dependencies(upstream.client, { storage }),
      authenticateBearerToken: async (tok) => (tok === bearer ? principal : null),
    });

    const idempotencyKey = "create-missing-fields-001";
    const response = await handler.handleHttp(
      modernRequest("tools/call", {
        name: "bugzilla_create_bug",
        arguments: {
          idempotencyKey,
          product: "Browser",
          summary: "Missing component and version",
          description: "Must fail at schema boundary",
        },
      }),
    );

    expect(response.status).toBe(200);
    const envelope = parseRpc(response) as {
      result: {
        isError: boolean;
        structuredContent: {
          error: boolean;
          code: string;
          issues: Array<{ path: string; code: string }>;
        };
      };
    };
    expect(envelope.result.isError).toBe(true);
    expect(envelope.result.structuredContent.error).toBe(true);
    expect(envelope.result.structuredContent.code).toBe("invalid_tool_input");
    const paths = envelope.result.structuredContent.issues.map((i) => i.path);
    expect(paths).toContain("component");
    expect(paths).toContain("version");
    expect(upstream.mutations).toEqual([]);
    expect(
      await storage.getReceipt({
        issuer: principal.issuer,
        principalId: principal.principalId,
        instanceUrl: principal.instanceUrl,
        operation: "bugzilla_create_bug",
        key: idempotencyKey,
      }),
    ).toBeNull();
  });

  test("bugzilla_create_bug upstream HTTP 400 marks receipt failed (not indeterminate) and allows retrying the same idempotencyKey", async () => {
    const storage = createSqliteStorage(":memory:");
    let rejectNext = true;
    const base = bugzilla();
    const client = {
      ...base.client,
      async createBug(input: Parameters<typeof base.client.createBug>[0]) {
        if (rejectNext) {
          throw new BugzillaValidationError({
            httpStatus: 400,
            bzErrorCode: 105,
            bzMessage: "You must select/enter a valid component.",
            missingFields: ["component"],
          });
        }
        return base.client.createBug(input);
      },
    };
    const handler = createDualEraHttpHandler({
      mode: "cloud-multi-user",
      allowedOrigins: [origin],
      allowAbsentOrigin: true,
      eventsProfile: "sep-3415",
      publicBaseUrl: serviceUrl,
      core: dependencies(client, { storage }),
      authenticateBearerToken: async (tok) => (tok === bearer ? principal : null),
    });

    const idempotencyKey = "create-400-retry-key-001";
    const firstRes = await handler.handleHttp(
      modernRequest("tools/call", {
        name: "bugzilla_create_bug",
        arguments: {
          idempotencyKey,
          product: "Browser",
          component: "Layout",
          version: "1.0",
          summary: "Bug with rejected field",
          description: "First attempt gets 400 from Bugzilla",
        },
      }),
    );
    expect(firstRes.status).toBe(200);
    const firstRpc = parseRpc(firstRes) as {
      result: { isError: boolean; structuredContent: { outcome: string; effectCertainty: string } };
    };
    expect(firstRpc.result.isError).toBe(true);
    expect(firstRpc.result.structuredContent).toMatchObject({
      outcome: "UpstreamRejected",
      effectCertainty: "none",
    });

    const receiptAfter400 = await storage.getReceipt({
      issuer: principal.issuer,
      principalId: principal.principalId,
      instanceUrl: principal.instanceUrl,
      operation: "bugzilla_create_bug",
      key: idempotencyKey,
    });
    expect(receiptAfter400?.status).toBe("failed");

    rejectNext = false;
    const secondRes = await handler.handleHttp(
      modernRequest("tools/call", {
        name: "bugzilla_create_bug",
        arguments: {
          idempotencyKey,
          product: "Browser",
          component: "Layout",
          version: "1.0",
          summary: "Bug with fixed field",
          description: "Second attempt succeeds reusing the same key",
        },
      }),
    );
    const secondRpc = parseRpc(secondRes) as {
      result: { isError?: boolean; structuredContent: { outcome: string; artifactId: string } };
    };
    expect(secondRpc.result.isError).not.toBe(true);
    expect(secondRpc.result.structuredContent).toMatchObject({
      outcome: "Applied",
      artifactId: "bug:200",
    });
    expect(base.mutations).toHaveLength(1);
  });

  test("applyBugUpdate upstream HTTP 400 returns UpstreamRejected and reverts proposal executing -> pending (not bricked)", async () => {
    const storage = createSqliteStorage(":memory:");
    const approvalService = createCloudApprovalTokenService(signingSecret, storage);
    let rejectUpdate = true;
    const base = bugzilla();
    const client = {
      ...base.client,
      async applyBugUpdate(bugId: number, diff: Parameters<typeof base.client.applyBugUpdate>[1]) {
        if (rejectUpdate) {
          throw new BugzillaValidationError({
            httpStatus: 400,
            bzErrorCode: 108,
            bzMessage: "Invalid status transition for this product.",
          });
        }
        return base.client.applyBugUpdate(bugId, diff);
      },
    };
    const writeGuard = createWriteGuardService(
      dependencies(client, { storage, cloudApprovalService: approvalService }),
    );
    const proposed = await writeGuard.proposeUpdate(principal, {
      bugId: 41,
      idempotencyKey: "prop-400-revert-001",
      expectedLastChangeTime: iso(epoch),
      diff: { priority: "P1" },
      rationale: "Escalate priority",
    });
    expect(proposed.outcome).toBe("ProposalPending");
    if (proposed.outcome !== "ProposalPending") throw new Error("Expected ProposalPending");

    const token1 = await approvalService.issue({
      approverIssuer: principal.issuer,
      approverPrincipalId: principal.principalId,
      instanceUrl: principal.instanceUrl,
      proposalId: proposed.proposalId,
      revision: proposed.revision,
      bugId: 41,
      baseVersion: iso(epoch),
      diff: { priority: "P1" },
      visibility: "public",
      ttlMs: 60_000,
      nowMs: epoch,
    });
    const firstResolve = await writeGuard.resolveProposal(principal, {
      proposalId: proposed.proposalId,
      revision: proposed.revision,
      decision: "approve",
      idempotencyKey: "resolve-400-revert-001",
      approval: { kind: "cloud_signed_token", token: token1.token },
    });
    expect(firstResolve).toMatchObject({
      outcome: "UpstreamRejected",
      effectCertainty: "none",
      bzErrorCode: 108,
    });

    const storedAfter400 = await storage.getProposal(
      principal.issuer,
      principal.principalId,
      principal.instanceUrl,
      proposed.proposalId,
      proposed.revision,
    );
    expect(storedAfter400?.state).toBe("pending");

    // Retry with a fresh approval token now succeeds
    rejectUpdate = false;
    const token2 = await approvalService.issue({
      approverIssuer: principal.issuer,
      approverPrincipalId: principal.principalId,
      instanceUrl: principal.instanceUrl,
      proposalId: proposed.proposalId,
      revision: proposed.revision,
      bugId: 41,
      baseVersion: iso(epoch),
      diff: { priority: "P1" },
      visibility: "public",
      ttlMs: 60_000,
      nowMs: epoch,
    });
    const secondResolve = await writeGuard.resolveProposal(principal, {
      proposalId: proposed.proposalId,
      revision: proposed.revision,
      decision: "approve",
      idempotencyKey: "resolve-400-revert-001",
      approval: { kind: "cloud_signed_token", token: token2.token },
    });
    expect(secondResolve).toMatchObject({ outcome: "Applied", bugId: 41 });
  });

  test("true upstream timeout / 5xx locks both idempotency key and proposal as indeterminate", async () => {
    const storage = createSqliteStorage(":memory:");
    const approvalService = createCloudApprovalTokenService(signingSecret, storage);
    let updateCalls = 0;
    const base = bugzilla({
      async applyBugUpdate() {
        updateCalls += 1;
        throw new BugzillaTransientError({
          effectCertainty: "uncertain",
          httpStatus: 504,
          message: "Gateway timeout after dispatch",
        });
      },
    });
    const writeGuard = createWriteGuardService(
      dependencies(base.client, { storage, cloudApprovalService: approvalService }),
    );
    const proposed = await writeGuard.proposeUpdate(principal, {
      bugId: 41,
      idempotencyKey: "prop-504-lock-001",
      expectedLastChangeTime: iso(epoch),
      diff: { severity: "critical" },
      rationale: "Mark critical",
    });
    if (proposed.outcome !== "ProposalPending") throw new Error("Expected ProposalPending");

    const token = await approvalService.issue({
      approverIssuer: principal.issuer,
      approverPrincipalId: principal.principalId,
      instanceUrl: principal.instanceUrl,
      proposalId: proposed.proposalId,
      revision: proposed.revision,
      bugId: 41,
      baseVersion: iso(epoch),
      diff: { severity: "critical" },
      visibility: "public",
      ttlMs: 60_000,
      nowMs: epoch,
    });
    const resolveKey = "resolve-504-lock-001";
    const outcome = await writeGuard.resolveProposal(principal, {
      proposalId: proposed.proposalId,
      revision: proposed.revision,
      decision: "approve",
      idempotencyKey: resolveKey,
      approval: { kind: "cloud_signed_token", token: token.token },
    });
    expect(outcome).toMatchObject({
      outcome: "OperationIndeterminate",
      idempotencyKey: resolveKey,
    });

    const receipt = await storage.getReceipt({
      issuer: principal.issuer,
      principalId: principal.principalId,
      instanceUrl: principal.instanceUrl,
      operation: "app_resolve_proposal",
      key: resolveKey,
    });
    expect(receipt?.status).toBe("indeterminate");
    const proposal = await storage.getProposal(
      principal.issuer,
      principal.principalId,
      principal.instanceUrl,
      proposed.proposalId,
      proposed.revision,
    );
    expect(proposal?.state).toBe("indeterminate");

    // Replaying same key returns OperationIndeterminate without re-dispatching
    const replay = await writeGuard.resolveProposal(principal, {
      proposalId: proposed.proposalId,
      revision: proposed.revision,
      decision: "approve",
      idempotencyKey: resolveKey,
      approval: { kind: "cloud_signed_token", token: token.token },
    });
    expect(replay).toMatchObject({
      outcome: "OperationIndeterminate",
      idempotencyKey: resolveKey,
    });
    expect(updateCalls).toBe(1);
  });

  test("leaseToken fencing race: pre-dispatch expiry reclaims and fences stale worker; post-dispatch expiry transitions to indeterminate without redispatch", async () => {
    const storage = createSqliteStorage(":memory:");
    const scopeA = {
      issuer: principal.issuer,
      principalId: principal.principalId,
      instanceUrl: principal.instanceUrl,
      operation: "bugzilla_create_bug",
      key: "lease-fence-pre-001",
    };

    // Pre-dispatch lease issued to Worker 1 at t=epoch (leaseMs=1000)
    const r1 = await storage.reservePending(scopeA, "hash-1", { nowMs: epoch, leaseMs: 1_000 });
    expect(r1.kind).toBe("reserved");
    if (r1.kind !== "reserved") throw new Error("Expected reserved");
    const staleLease = r1.leaseToken;

    // Before expiry, Worker 2 sees existing pending
    const rEarly = await storage.reservePending(scopeA, "hash-1", {
      nowMs: epoch + 500,
      leaseMs: 1_000,
    });
    expect(rEarly.kind).toBe("existing");

    // After expiry (still pre-dispatch), Worker 2 reclaims with a fresh leaseToken
    const r2 = await storage.reservePending(scopeA, "hash-1", {
      nowMs: epoch + 1_500,
      leaseMs: 1_000,
    });
    expect(r2.kind).toBe("reserved");
    if (r2.kind !== "reserved") throw new Error("Expected reclaimed reservation");
    expect(r2.leaseToken).not.toBe(staleLease);

    // Stale Worker 1 is fenced out on markDispatchStarted, finalizeReceipt, and commitAppliedMutation
    expect(await storage.markDispatchStarted(scopeA, staleLease, { nowMs: epoch + 1_600 })).toBe(
      false,
    );
    expect(
      await storage.finalizeReceipt(
        scopeA,
        { status: "failed", intentHash: "hash-1", errorCode: "stale" },
        { expectedLeaseToken: staleLease },
      ),
    ).toBe(false);
    expect(
      await storage.commitAppliedMutation({
        scope: scopeA,
        leaseToken: staleLease,
        intentHash: "hash-1",
        artifactId: "bug:999",
      }),
    ).toEqual({ committed: false, reason: "lease_fenced" });

    // Worker 2 marks dispatch started and commits cleanly
    expect(await storage.markDispatchStarted(scopeA, r2.leaseToken, { nowMs: epoch + 1_600 })).toBe(
      true,
    );
    expect(
      await storage.commitAppliedMutation({
        scope: scopeA,
        leaseToken: r2.leaseToken,
        intentHash: "hash-1",
        artifactId: "bug:201",
      }),
    ).toEqual({ committed: true });

    // Post-dispatch expiry transitions to indeterminate without re-dispatching
    const scopeB = { ...scopeA, key: "lease-fence-post-002" };
    const b1 = await storage.reservePending(scopeB, "hash-2", { nowMs: epoch, leaseMs: 1_000 });
    if (b1.kind !== "reserved") throw new Error("Expected reserved");
    expect(await storage.markDispatchStarted(scopeB, b1.leaseToken, { nowMs: epoch + 100 })).toBe(
      true,
    );
    const bAfterExpiry = await storage.reservePending(scopeB, "hash-2", {
      nowMs: epoch + 1_500,
      leaseMs: 1_000,
    });
    expect(bAfterExpiry).toMatchObject({
      kind: "existing",
      receipt: { status: "indeterminate", intentHash: "hash-2" },
    });
    expect((await storage.getReceipt(scopeB))?.status).toBe("indeterminate");
  });

  test("end-to-end writeGuard.createBug & resolveProposal reclaim expired pre-dispatch leases and lock expired post-dispatch leases as indeterminate", async () => {
    const clock = manualClock();
    const storage = createSqliteStorage(":memory:");
    const leaseMs = 5_000;
    const upstream = bugzilla();
    const localPrincipal: PrincipalContext = {
      ...principal,
      deploymentMode: "local-trusted-ide",
    };
    const writeGuard = createWriteGuardService(
      dependencies(upstream.client, { storage, clock: clock.now, receiptLeaseMs: leaseMs }),
    );

    // 1. createBug: expired pre-dispatch pending lease is reclaimed -> Applied
    const createPreKey = "e2e-create-pre-expire-001";
    const createPreScope = {
      issuer: localPrincipal.issuer,
      principalId: localPrincipal.principalId,
      instanceUrl: localPrincipal.instanceUrl,
      operation: "bugzilla_create_bug",
      key: createPreKey,
    };
    const preReserve = await storage.reservePending(createPreScope, "stale-worker-hash", {
      nowMs: clock.now(),
      leaseMs,
    });
    expect(preReserve.kind).toBe("reserved");

    // While lease is active, same key sees OperationPending/IdempotencyConflict (does not dispatch)
    const createPayload = {
      idempotencyKey: createPreKey,
      product: "Browser",
      component: "Layout",
      version: "1.0",
      summary: "Reclaimed pre-dispatch create",
      description: "Recovers cleanly after pre-dispatch worker crash",
    };
    expect(await writeGuard.createBug(localPrincipal, createPayload)).toMatchObject({
      outcome: "IdempotencyConflict",
      idempotencyKey: createPreKey,
    });

    // Advance past leaseMs -> writeGuard.createBug reclaims and dispatches cleanly!
    clock.advance(leaseMs + 100);
    expect(await writeGuard.createBug(localPrincipal, createPayload)).toMatchObject({
      outcome: "Applied",
      bugId: 200,
    });
    expect(upstream.mutations).toHaveLength(1);

    // 2. createBug: expired post-dispatch pending lease transitions to OperationIndeterminate without redispatch
    const createPostKey = "e2e-create-post-expire-002";
    const createPostScope = { ...createPreScope, key: createPostKey };
    const createPostPayload = {
      idempotencyKey: createPostKey,
      product: "Browser",
      component: "Layout",
      version: "1.0",
      summary: "Post-dispatch crashed create",
      description: "Must lock indeterminate without re-dispatching",
    };
    const { idempotencyKey: _ik, ...rawCreatePost } = createPostPayload;
    const postReserve = await storage.reservePending(
      createPostScope,
      // Store matching intentHash by using writeGuard's canonical hash via direct check
      (await import("node:crypto"))
        .createHash("sha256")
        .update(canonicalJson(rawCreatePost))
        .digest("hex"),
      { nowMs: clock.now(), leaseMs },
    );
    if (postReserve.kind !== "reserved") throw new Error("Expected reserved");
    expect(
      await storage.markDispatchStarted(createPostScope, postReserve.leaseToken, {
        nowMs: clock.now(),
      }),
    ).toBe(true);

    clock.advance(leaseMs + 100);
    expect(await writeGuard.createBug(localPrincipal, createPostPayload)).toMatchObject({
      outcome: "OperationIndeterminate",
      idempotencyKey: createPostKey,
    });
    expect((await storage.getReceipt(createPostScope))?.status).toBe("indeterminate");
    expect(upstream.mutations).toHaveLength(1);

    // 3. resolveProposal: expired pre-dispatch pending lease + executing proposal recovers -> Applied
    const prop1 = await writeGuard.proposeUpdate(localPrincipal, {
      bugId: 41,
      idempotencyKey: "e2e-prop-pre-expire-001",
      expectedLastChangeTime: iso(epoch),
      diff: { priority: "P1" },
      rationale: "Recover abandoned pre-dispatch execution",
    });
    if (prop1.outcome !== "ProposalPending") throw new Error("Expected ProposalPending");

    const resPreKey = "e2e-resolve-pre-expire-001";
    const resPreScope = {
      issuer: localPrincipal.issuer,
      principalId: localPrincipal.principalId,
      instanceUrl: localPrincipal.instanceUrl,
      operation: "app_resolve_proposal",
      key: resPreKey,
    };
    const resPreIntent = (await import("node:crypto"))
      .createHash("sha256")
      .update(
        canonicalJson({
          proposalId: prop1.proposalId,
          revision: prop1.revision,
          decision: "approve",
        }),
      )
      .digest("hex");
    await storage.reservePending(resPreScope, resPreIntent, { nowMs: clock.now(), leaseMs });
    expect(
      await storage.transitionProposalCas({
        issuer: localPrincipal.issuer,
        principalId: localPrincipal.principalId,
        instanceUrl: localPrincipal.instanceUrl,
        proposalId: prop1.proposalId,
        revision: prop1.revision,
        fromStates: ["pending"],
        toState: "executing",
      }),
    ).toBe(true);

    // While lease active, returns OperationPending
    expect(
      await writeGuard.resolveProposal(localPrincipal, {
        proposalId: prop1.proposalId,
        revision: prop1.revision,
        decision: "approve",
        idempotencyKey: resPreKey,
        approval: { kind: "local_ide_host_confirmed", confirmedAt: iso(clock.now()) },
      }),
    ).toEqual({ outcome: "OperationPending", idempotencyKey: resPreKey });

    // After lease expiry (dispatchAttempted === false), reverts executing -> pending, reclaims lease, and applies!
    clock.advance(leaseMs + 100);
    expect(
      await writeGuard.resolveProposal(localPrincipal, {
        proposalId: prop1.proposalId,
        revision: prop1.revision,
        decision: "approve",
        idempotencyKey: resPreKey,
        approval: { kind: "local_ide_host_confirmed", confirmedAt: iso(clock.now()) },
      }),
    ).toMatchObject({ outcome: "Applied", bugId: 41 });
    expect(
      (
        await storage.getProposal(
          localPrincipal.issuer,
          localPrincipal.principalId,
          localPrincipal.instanceUrl,
          prop1.proposalId,
          prop1.revision,
        )
      )?.state,
    ).toBe("applied");
    expect(upstream.mutations).toHaveLength(2);

    // 4. resolveProposal: expired post-dispatch pending lease locks both receipt & proposal as indeterminate
    const prop2 = await writeGuard.proposeUpdate(localPrincipal, {
      bugId: 41,
      idempotencyKey: "e2e-prop-post-expire-002",
      expectedLastChangeTime: iso(epoch),
      diff: { severity: "blocker" },
      rationale: "Post-dispatch crash must lock indeterminate",
    });
    if (prop2.outcome !== "ProposalPending") throw new Error("Expected ProposalPending");

    const resPostKey = "e2e-resolve-post-expire-002";
    const resPostScope = { ...resPreScope, key: resPostKey };
    const resPostIntent = (await import("node:crypto"))
      .createHash("sha256")
      .update(
        canonicalJson({
          proposalId: prop2.proposalId,
          revision: prop2.revision,
          decision: "approve",
        }),
      )
      .digest("hex");
    const resPostLease = await storage.reservePending(resPostScope, resPostIntent, {
      nowMs: clock.now(),
      leaseMs,
    });
    if (resPostLease.kind !== "reserved") throw new Error("Expected reserved");
    await storage.transitionProposalCas({
      issuer: localPrincipal.issuer,
      principalId: localPrincipal.principalId,
      instanceUrl: localPrincipal.instanceUrl,
      proposalId: prop2.proposalId,
      revision: prop2.revision,
      fromStates: ["pending"],
      toState: "executing",
    });
    expect(
      await storage.markDispatchStarted(resPostScope, resPostLease.leaseToken, {
        nowMs: clock.now(),
      }),
    ).toBe(true);

    clock.advance(leaseMs + 100);
    expect(
      await writeGuard.resolveProposal(localPrincipal, {
        proposalId: prop2.proposalId,
        revision: prop2.revision,
        decision: "approve",
        idempotencyKey: resPostKey,
        approval: { kind: "local_ide_host_confirmed", confirmedAt: iso(clock.now()) },
      }),
    ).toMatchObject({ outcome: "OperationIndeterminate", idempotencyKey: resPostKey });
    expect((await storage.getReceipt(resPostScope))?.status).toBe("indeterminate");
    expect(
      (
        await storage.getProposal(
          localPrincipal.issuer,
          localPrincipal.principalId,
          localPrincipal.instanceUrl,
          prop2.proposalId,
          prop2.revision,
        )
      )?.state,
    ).toBe("indeterminate");
    expect(upstream.mutations).toHaveLength(2);
  });

  test("Stage 4 post-commit SQLite error after Bugzilla 200 OK never regresses applied -> indeterminate", async () => {
    const backing = createSqliteStorage(":memory:");
    const faultyStorage: StoragePorts = {
      ...backing,
      async commitAppliedMutation(params) {
        // Persist applied state first, then simulate post-commit SQLite hiccup
        await backing.commitAppliedMutation(params);
        throw new Error("SQLITE_BUSY: simulated post-commit error");
      },
    };
    const upstream = bugzilla();
    const writeGuard = createWriteGuardService(
      dependencies(upstream.client, { storage: faultyStorage }),
    );
    const key = "stage4-sqlite-busy-001";
    const outcome = await writeGuard.createBug(principal, {
      idempotencyKey: key,
      product: "Browser",
      component: "Layout",
      version: "1.0",
      summary: "Post-commit SQLite hiccup test",
      description: "Must return Applied, never OperationIndeterminate",
    });

    expect(outcome).toMatchObject({
      outcome: "Applied",
      artifactId: "bug:200",
      bugId: 200,
    });
    const scope = {
      issuer: principal.issuer,
      principalId: principal.principalId,
      instanceUrl: principal.instanceUrl,
      operation: "bugzilla_create_bug",
      key,
    };
    expect((await backing.getReceipt(scope))?.status).toBe("applied");

    // Direct regression guard: finalizeReceipt refuses applied -> indeterminate
    expect(
      await backing.finalizeReceipt(scope, {
        status: "indeterminate",
        intentHash: "x",
        recordedAt: iso(epoch),
      }),
    ).toBe(false);
    expect((await backing.getReceipt(scope))?.status).toBe("applied");
  });

  // EVIDENCE-OF: R-5d5271
  test("comment-only Guarded update routes to postPublicComment and records deterministic commentId self-write provenance", async () => {
    const storage = createSqliteStorage(":memory:");
    const clock = manualClock();
    const upstream = bugzilla();
    const localPrincipal: PrincipalContext = {
      ...principal,
      deploymentMode: "local-trusted-ide",
    };
    const writeGuard = createWriteGuardService(
      dependencies(upstream.client, { storage, clock: clock.now }),
    );
    const proposed = await writeGuard.proposeUpdate(localPrincipal, {
      bugId: 41,
      idempotencyKey: "prop-comment-only-001",
      expectedLastChangeTime: iso(epoch),
      diff: { publicComment: "Confirmed public response from triage." },
      rationale: "Post approved public comment",
    });
    if (proposed.outcome !== "ProposalPending") throw new Error("Expected ProposalPending");

    const resolved = await writeGuard.resolveProposal(localPrincipal, {
      proposalId: proposed.proposalId,
      revision: proposed.revision,
      decision: "approve",
      idempotencyKey: "resolve-comment-only-001",
      approval: { kind: "local_ide_host_confirmed", confirmedAt: iso(epoch) },
    });
    expect(resolved).toMatchObject({
      outcome: "Applied",
      bugId: 41,
      auditRecorded: true,
    });
    // Must route to postPublicComment, NEVER applyBugUpdate
    expect(upstream.mutations.map((m) => m.kind)).toEqual(["public"]);
    expect(
      await storage.hasSelfWrite({
        issuer: localPrincipal.issuer,
        principalId: localPrincipal.principalId,
        instanceUrl: localPrincipal.instanceUrl,
        bugId: 41,
        commentId: 300,
      }),
    ).toBe(true);

    // Events polling suppresses the self-written comment by default
    const eventsSvc = createSyntheticEventsService(
      dependencies(
        {
          ...upstream.client,
          async listChangesSince() {
            return {
              occurrences: [
                comment(300, iso(epoch + 1_000), { actor: "alice@example.test" }),
                comment(301, iso(epoch + 1_000), { actor: "human@example.test" }),
              ],
              scanComplete: true,
            };
          },
        },
        { storage, clock: clock.now },
      ),
    );
    const initial = await eventsSvc.poll(localPrincipal, {
      name: "bugzilla.bug.commented",
      arguments: { includeSelf: false },
      cursor: null,
    });
    clock.advance(5_000);
    const polled = await eventsSvc.poll(localPrincipal, {
      name: "bugzilla.bug.commented",
      arguments: { includeSelf: false },
      cursor: initial.cursor,
    });
    expect(polled.events.map((e) => e.data.commentId)).toEqual([301]);
  });

  test("mid-session API key revocation (401/300/306/410) and HTTP 429 checkVisibility behavior", async () => {
    const jsonResp = (status: number, body: unknown, headers?: Record<string, string>) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      });

    for (const scenario of [
      { label: "HTTP 401", status: 401, body: { error: true, message: "Unauthorized" } },
      {
        label: "BZ code 300",
        status: 400,
        body: { error: true, code: 300, message: "Invalid login" },
      },
      {
        label: "BZ code 306",
        status: 400,
        body: { error: true, code: 306, message: "Invalid API key" },
      },
      {
        label: "BZ code 410",
        status: 401,
        body: { error: true, code: 410, message: "Login required" },
      },
      {
        label: "HTTP 200 error:true 410",
        status: 200,
        body: { error: true, code: 410, message: "Login required" },
      },
    ]) {
      const client = createRestBugzillaClient({
        baseUrl: "https://bz.example",
        apiKey: "revoked-key-secret",
        maxGetRetries: 0,
        fetchImpl: (async () =>
          jsonResp(scenario.status, scenario.body)) as unknown as typeof fetch,
      });
      expect(await client.checkVisibility(41), scenario.label).toBe("credential_revoked");
      await expect(client.searchBugs({ limit: 5, offset: 0 })).rejects.toBeInstanceOf(
        BugzillaCredentialRevokedError,
      );
    }

    // HTTP 429 on checkVisibility MUST fail with BugzillaRateLimitError (NOT "restricted_or_missing")
    const rateLimitedClient = createRestBugzillaClient({
      baseUrl: "https://bz.example",
      apiKey: "valid-key-secret",
      maxGetRetries: 0,
      fetchImpl: (async () =>
        jsonResp(
          429,
          { error: true, message: "Too Many Requests" },
          { "retry-after": "2" },
        )) as unknown as typeof fetch,
    });
    await expect(rateLimitedClient.checkVisibility(41)).rejects.toBeInstanceOf(
      BugzillaRateLimitError,
    );

    // Verify events/poll treats 429 on checkVisibility as transient failure (never silently suppresses)
    const clock = manualClock();
    const eventsSvc = createSyntheticEventsService(
      dependencies(
        {
          ...bugzilla().client,
          async listChangesSince() {
            return {
              occurrences: [comment(501, iso(epoch + 1_000))],
              scanComplete: true,
            };
          },
          async checkVisibility() {
            throw new BugzillaRateLimitError({ retryAfterMs: 2_000, bzMessage: "Rate limited" });
          },
        },
        { storage: memoryStorage(clock.now), clock: clock.now },
      ),
    );
    const start = await eventsSvc.poll(principal, {
      name: "bugzilla.bug.commented",
      arguments: { includeSelf: false },
      cursor: null,
    });
    clock.advance(5_000);
    await expect(
      eventsSvc.poll(principal, {
        name: "bugzilla.bug.commented",
        arguments: { includeSelf: false },
        cursor: start.cursor,
      }),
    ).rejects.toMatchObject({ code: -32603 });
  });

  test("legacy 2025-11-25 HTTP catches domain errors cleanly (no bare HTTP 500) and stdio enforces config.readOnly", async () => {
    const storage = createSqliteStorage(":memory:");
    let authShouldThrow = false;
    const base = bugzilla({
      async checkVisibility() {
        return "credential_revoked";
      },
      async searchBugs() {
        throw new BugzillaCredentialRevokedError({
          bzErrorCode: 306,
          bzMessage: "Invalid API key",
        });
      },
    });
    const config: HttpServerConfig = {
      mode: "cloud-multi-user",
      allowedOrigins: [origin],
      allowAbsentOrigin: true,
      eventsProfile: "sep-3415",
      publicBaseUrl: serviceUrl,
      core: dependencies(base.client, { storage }),
      authenticateBearerToken: async (tok) => {
        if (authShouldThrow) throw new Error("OIDC JWKS endpoint unreachable");
        return tok === bearer ? principal : null;
      },
    };
    const handler = createDualEraHttpHandler(config);

    // Initialize legacy 2025-11-25 session
    const initRes = await handler.handleHttp({
      method: "POST",
      path: "/mcp",
      headers: {
        origin,
        authorization: `Bearer ${bearer}`,
        "mcp-protocol-version": MCP_PROTOCOL_LEGACY,
      },
      rawBody: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: MCP_PROTOCOL_LEGACY },
      }),
    });
    expect(initRes.status).toBe(200);
    const sessionId = Object.entries(initRes.headers).find(
      ([k]) => k.toLowerCase() === "mcp-session-id",
    )?.[1];
    expect(sessionId).toBeTruthy();

    // 1. Revoked key on legacy tools/call -> 200 JSON-RPC isError: true (NOT bare 500, no resultType)
    const toolRes = await handler.handleHttp({
      method: "POST",
      path: "/mcp",
      headers: {
        origin,
        authorization: `Bearer ${bearer}`,
        "mcp-protocol-version": MCP_PROTOCOL_LEGACY,
        "mcp-session-id": sessionId,
      },
      rawBody: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "bugzilla_search", arguments: {} },
      }),
    });
    expect(toolRes.status).toBe(200);
    const toolRpc = parseRpc(toolRes) as {
      result: { isError: boolean; resultType?: string; structuredContent: { code: string } };
    };
    expect(toolRpc.result.isError).toBe(true);
    expect(toolRpc.result.resultType).toBeUndefined();
    expect(toolRpc.result.structuredContent.code).toBe("credential_revoked");

    // 2. Revoked key on legacy resources/read -> structured JSON-RPC error with credential_revoked (NOT INDISTINGUISHABLE_RESOURCE_ERROR)
    const readRes = await handler.handleHttp({
      method: "POST",
      path: "/mcp",
      headers: {
        origin,
        authorization: `Bearer ${bearer}`,
        "mcp-protocol-version": MCP_PROTOCOL_LEGACY,
        "mcp-session-id": sessionId,
      },
      rawBody: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "resources/read",
        params: { uri: "bugzilla://bug/41" },
      }),
    });
    expect(readRes.status).toBe(200);
    const readRpc = parseRpc(readRes) as { error: { code: number; data?: { code?: string } } };
    expect(readRpc.error.data?.code).toBe("credential_revoked");

    // 3. Throwing authenticateBearerToken -> JSON-RPC -32603 (NOT uncaught exception)
    authShouldThrow = true;
    const authErrRes = await handler.handleHttp({
      method: "POST",
      path: "/mcp",
      headers: {
        origin,
        authorization: `Bearer ${bearer}`,
        "mcp-protocol-version": MCP_PROTOCOL_LEGACY,
        "mcp-session-id": sessionId,
      },
      rawBody: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping", params: {} }),
    });
    expect(authErrRes.status).toBe(500);
    expect(parseRpc(authErrRes)).toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32603 },
    });

    // 4. stdio.ts enforces config.readOnly (hides mutating tools and rejects mutating calls with -32602)
    const cleanUpstream = bugzilla();
    const stdio = createStdioRpcProcessor({
      config: {
        mode: "local-trusted-ide",
        allowedOrigins: [],
        eventsProfile: "sep-3415",
        readOnly: true,
        core: dependencies(cleanUpstream.client, { storage: createSqliteStorage(":memory:") }),
      },
      principal: { ...principal, deploymentMode: "local-trusted-ide" },
    });
    try {
      const listRaw = await stdio(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      );
      const listResp = JSON.parse(listRaw ?? "{}") as {
        result: { tools: Array<{ name: string }> };
      };
      const toolNames = listResp.result.tools.map((t) => t.name);
      expect(toolNames).toContain("bugzilla_search");
      expect(toolNames).not.toContain("bugzilla_create_bug");
      expect(toolNames).not.toContain("bugzilla_post_analysis");
      expect(toolNames).not.toContain("bugzilla_propose_update");

      const blockedRaw = await stdio(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "bugzilla_create_bug",
            arguments: {
              idempotencyKey: "stdio-readonly-block-001",
              product: "Browser",
              component: "Layout",
              version: "1.0",
              summary: "Should be blocked",
              description: "Read-only mode",
            },
          },
        }),
      );
      const blockedWrite = JSON.parse(blockedRaw ?? "{}") as {
        error: { code: number; message: string };
      };
      expect(blockedWrite.error.code).toBe(-32602);
      expect(cleanUpstream.mutations).toEqual([]);
    } finally {
      await stdio.dispose();
    }
  });

  test("app_save_draft and app_get_draft enforce checkVisibility before persisting or returning drafts", async () => {
    const storage = createSqliteStorage(":memory:");
    let visibility: "visible" | "restricted_or_missing" | "credential_revoked" =
      "restricted_or_missing";
    const upstream = bugzilla({
      async checkVisibility() {
        return visibility;
      },
    });
    const writeGuard = createWriteGuardService(dependencies(upstream.client, { storage }));

    // Restricted/missing bug -> AccessDenied, zero drafts persisted
    await expect(
      writeGuard.saveDraft(principal, {
        bugId: 99,
        draftKind: "private_comment",
        draftRevision: 1,
        content: "Should not persist for restricted bug",
      }),
    ).rejects.toMatchObject({ _tag: "AccessDenied" });
    expect(
      await storage.getDraft({
        issuer: principal.issuer,
        principalId: principal.principalId,
        instanceUrl: principal.instanceUrl,
        bugId: 99,
        draftKind: "private_comment",
      }),
    ).toBeNull();

    // Revoked key -> CredentialRevoked
    visibility = "credential_revoked";
    await expect(
      writeGuard.saveDraft(principal, {
        bugId: 99,
        draftKind: "private_comment",
        draftRevision: 1,
        content: "Revoked key must fail",
      }),
    ).rejects.toMatchObject({ _tag: "CredentialRevoked" });

    // Visible bug -> succeeds; then losing visibility blocks app_get_draft
    visibility = "visible";
    expect(
      await writeGuard.saveDraft(principal, {
        bugId: 99,
        draftKind: "private_comment",
        draftRevision: 1,
        content: "Authorized draft",
      }),
    ).toMatchObject({ status: "acknowledged", draftRevision: 1 });

    visibility = "restricted_or_missing";
    await expect(
      writeGuard.getDraft(principal, { bugId: 99, draftKind: "private_comment" }),
    ).rejects.toMatchObject({ _tag: "AccessDenied" });
  });

  test("Cloud POST /approve enforces readOnly, live credentialGeneration, persisted scopes, and Accept HTML vs JSON", async () => {
    const storage = createSqliteStorage(":memory:");
    // Seed live bound credential at generation 3 (NOT hardcoded 1!)
    await storage.saveBoundCredential({
      issuer: principal.issuer,
      principalId: principal.principalId,
      instanceUrl: principal.instanceUrl,
      ciphertext: "ct1",
      iv: "iv1",
      authTag: "tag1",
    });
    await storage.saveBoundCredential({
      issuer: principal.issuer,
      principalId: principal.principalId,
      instanceUrl: principal.instanceUrl,
      ciphertext: "ct2",
      iv: "iv2",
      authTag: "tag2",
    });
    const bound = await storage.saveBoundCredential({
      issuer: principal.issuer,
      principalId: principal.principalId,
      instanceUrl: principal.instanceUrl,
      ciphertext: "ct3",
      iv: "iv3",
      authTag: "tag3",
    });
    expect(bound.credentialGeneration).toBe(3);

    const seenResolveGenerations: number[] = [];
    const upstream = bugzilla();
    const approvalService = createCloudApprovalTokenService(signingSecret, storage);
    let currentReadOnly = false;
    let activePrincipal: PrincipalContext = { ...principal, credentialGeneration: 3 };

    const makeHandler = () =>
      createDualEraHttpHandler({
        mode: "cloud-multi-user",
        allowedOrigins: [origin],
        allowAbsentOrigin: true,
        eventsProfile: "sep-3415",
        publicBaseUrl: serviceUrl,
        readOnly: currentReadOnly,
        core: dependencies(upstream.client, {
          storage,
          cloudApprovalService: approvalService,
          resolveClient: async (ctx) => {
            seenResolveGenerations.push(ctx.credentialGeneration);
            return upstream.client;
          },
        }),
        authenticateBearerToken: async (tok) => (tok === bearer ? activePrincipal : null),
        verifyBindingOpenerSession: async () => ({
          issuer: principal.issuer,
          principalId: principal.principalId,
        }),
      });

    async function proposeAndLoadTicket(
      handler: ReturnType<typeof makeHandler>,
      idemKey: string,
      priority: string,
    ) {
      const propRes = await handler.handleHttp(
        modernRequest("tools/call", {
          name: "bugzilla_propose_update",
          arguments: {
            bugId: 41,
            idempotencyKey: idemKey,
            expectedLastChangeTime: iso(epoch),
            diff: { priority },
            rationale: `Set priority to ${priority}`,
          },
        }),
      );
      const propOut = (
        parseRpc(propRes) as {
          result: {
            structuredContent: { proposalId: string; revision: number; approvalUrl: string };
          };
        }
      ).result.structuredContent;
      const url = new URL(propOut.approvalUrl);
      const path = `${url.pathname}${url.search}`;
      const pageRes = await handler.handleHttp({
        method: "GET",
        path,
        headers: {},
        rawBody: "",
      });
      expect(pageRes.status).toBe(200);
      const csrf = /name="csrf" value="([^"]+)"/.exec(pageRes.body)?.[1] ?? "";
      const t = /name="t" value="([^"]+)"/.exec(pageRes.body)?.[1] ?? "";
      expect(csrf).toBeTruthy();
      expect(t).toBeTruthy();
      return { ...propOut, path, csrf, t };
    }

    // 1. Persisted scopes check: ticket issued without bz:write:guarded -> POST /approve returns 403
    const handlerNormal = makeHandler();
    const tScope = await proposeAndLoadTicket(handlerNormal, "approve-scope-001", "P1");
    const storedForScope = await storage.getApprovalTicket(tScope.t);
    expect(storedForScope?.scopes).toContain("bz:write:guarded");
    await storage.saveApprovalTicket({
      ...storedForScope!,
      scopes: ["bz:read"],
    });
    const scopeDeniedRes = await handlerNormal.handleHttp({
      method: "POST",
      path: tScope.path,
      headers: {
        origin: serviceUrl,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      rawBody: new URLSearchParams({
        t: tScope.t,
        csrf: tScope.csrf,
        decision: "approve",
      }).toString(),
    });
    expect(scopeDeniedRes.status).toBe(403);
    expect((await storage.getApprovalTicket(tScope.t))?.consumed).toBe(false);

    // 2. readOnly enforcement on POST /approve -> 403 and ticket not consumed
    currentReadOnly = true;
    const handlerReadOnly = makeHandler();
    await storage.saveApprovalTicket({
      ...storedForScope!,
      scopes: ["bz:read", "bz:write:guarded"],
    });
    const readOnlyRes = await handlerReadOnly.handleHttp({
      method: "POST",
      path: tScope.path,
      headers: {
        origin: serviceUrl,
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
      },
      rawBody: new URLSearchParams({
        t: tScope.t,
        csrf: tScope.csrf,
        decision: "approve",
      }).toString(),
    });
    expect(readOnlyRes.status).toBe(403);
    expect((await storage.getApprovalTicket(tScope.t))?.consumed).toBe(false);
    currentReadOnly = false;

    // 3. Accept: text/html executes approve server-side using live credentialGeneration=3 and renders HTML
    seenResolveGenerations.length = 0;
    const htmlApproveRes = await handlerNormal.handleHttp({
      method: "POST",
      path: tScope.path,
      headers: {
        origin: serviceUrl,
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html,application/xhtml+xml",
      },
      rawBody: new URLSearchParams({
        t: tScope.t,
        csrf: tScope.csrf,
        decision: "approve",
      }).toString(),
    });
    expect(htmlApproveRes.status).toBe(200);
    expect(htmlApproveRes.headers["content-type"]).toContain("text/html");
    expect(htmlApproveRes.body).toContain("Applied");
    expect(seenResolveGenerations).toContain(3);
    expect(seenResolveGenerations).not.toContain(1);
    expect(upstream.mutations).toHaveLength(1);

    // 4. Accept: text/html reject executes server-side -> ProposalRejected HTML, 0 additional upstream writes
    const tReject = await proposeAndLoadTicket(handlerNormal, "approve-reject-html-002", "P3");
    const htmlRejectRes = await handlerNormal.handleHttp({
      method: "POST",
      path: tReject.path,
      headers: {
        origin: serviceUrl,
        "content-type": "application/x-www-form-urlencoded",
        accept: "text/html",
      },
      rawBody: new URLSearchParams({
        t: tReject.t,
        csrf: tReject.csrf,
        decision: "reject",
      }).toString(),
    });
    expect(htmlRejectRes.status).toBe(200);
    expect(htmlRejectRes.headers["content-type"]).toContain("text/html");
    expect(htmlRejectRes.body).toContain("ProposalRejected");
    expect(upstream.mutations).toHaveLength(1);
    expect(
      (
        await storage.getProposal(
          principal.issuer,
          principal.principalId,
          principal.instanceUrl,
          tReject.proposalId,
          tReject.revision,
        )
      )?.state,
    ).toBe("rejected");

    // 5. Accept: application/json returns { approvalToken } without executing server-side
    const tJson = await proposeAndLoadTicket(handlerNormal, "approve-json-token-003", "P4");
    const jsonApproveRes = await handlerNormal.handleHttp({
      method: "POST",
      path: tJson.path,
      headers: {
        origin: serviceUrl,
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      rawBody: new URLSearchParams({
        t: tJson.t,
        csrf: tJson.csrf,
        decision: "approve",
      }).toString(),
    });
    expect(jsonApproveRes.status).toBe(200);
    expect(jsonApproveRes.headers["content-type"]).toContain("application/json");
    const jsonPayload = JSON.parse(jsonApproveRes.body) as { approvalToken?: string };
    expect(jsonPayload.approvalToken).toBeTruthy();
    expect(upstream.mutations).toHaveLength(1);
  });

  test("Events: sendGap exhaustion never advances safeWatermark, subscribeWebhook refresh clears gapPending and preserves lastGapCursor", async () => {
    const clock = manualClock();
    const storage = createSqliteStorage(":memory:");
    const rows: Array<ReturnType<typeof comment>> = [];
    const scanStates: Array<{ subscriptionId: string; state: WebhookScanState }> = [];
    const callbackUrl = "https://callback.example/gap-watermark";
    const webhookSecret = `whsec_${Buffer.alloc(32, 42).toString("base64")}`;

    let failEventsAndGaps = false;
    const sentPayloads: Array<{ type?: string; cursor?: string }> = [];
    const transport: WebhookOutboundTransport = {
      async resolveHost() {
        return ["1.1.1.1"];
      },
      async postPinned(req) {
        const parsed = JSON.parse(req.rawBody) as {
          type?: string;
          challenge?: string;
          cursor?: string;
        };
        sentPayloads.push(parsed);
        if (parsed.type === "verification") {
          return { status: 200, body: JSON.stringify({ challenge: parsed.challenge }) };
        }
        if (failEventsAndGaps) {
          return { status: 503, body: "unavailable" };
        }
        return { status: 200, body: "ok" };
      },
    };

    const client = bugzilla({
      async listChangesSince({ since }) {
        const floor = Date.parse(since);
        return {
          occurrences: rows.filter((row) => Date.parse(row.timestamp) >= floor),
          scanComplete: true,
        };
      },
    }).client;

    const events = createSyntheticEventsService(
      dependencies(client, {
        storage,
        clock: clock.now,
        webhookTransport: transport,
        maxWebhookRetries: 1,
        onWebhookScanState(subscriptionId, state) {
          scanStates.push({ subscriptionId, state });
        },
      }),
    );

    const sub1 = await events.subscribeWebhook(principal, {
      name: "bugzilla.bug.commented",
      arguments: { includeSelf: false },
      delivery: { mode: "webhook", url: callbackUrl, secret: webhookSecret },
      cursor: null,
      ttlMs: null,
    });
    const initialWatermark = sub1.cursor;
    expect(initialWatermark).toBeTruthy();

    // Add an occurrence and exhaust its delivery + gap delivery retries (all 503)
    failEventsAndGaps = true;
    rows.push(comment(701, iso(epoch + 1_000)));
    clock.advance(5_000);
    for (let i = 0; i < 8; i += 1) {
      await events.deliverPendingWebhooks(principal);
      clock.advance(15_000);
    }

    const storedAfterExhaustion = (
      await storage.listWebhookSubscriptions({
        issuer: principal.issuer,
        principalId: principal.principalId,
        instanceUrl: principal.instanceUrl,
      })
    )[0];
    expect(storedAfterExhaustion).toBeDefined();
    expect(storedAfterExhaustion?.gapPending).toBe(true);
    expect(storedAfterExhaustion?.safeWatermark).toBe(initialWatermark);
    expect(storedAfterExhaustion?.lastGapCursor).toBeTruthy();
    expect(scanStates.some((s) => s.state === "gap_delivery_stalled")).toBe(true);
    const savedLastGapCursor = storedAfterExhaustion?.lastGapCursor;

    // Live refresh communicates the pending gap via truncated: true, clears gapPending,
    // advances safeWatermark to recoveryCursor, and preserves lastGapCursor
    const refreshed = await events.subscribeWebhook(principal, {
      name: "bugzilla.bug.commented",
      arguments: { includeSelf: false },
      delivery: { mode: "webhook", url: callbackUrl, secret: webhookSecret },
      cursor: initialWatermark,
      ttlMs: null,
    });
    expect(refreshed.truncated).toBe(true);
    expect(refreshed.cursor).not.toBe(initialWatermark);

    const storedAfterRefresh = (
      await storage.listWebhookSubscriptions({
        issuer: principal.issuer,
        principalId: principal.principalId,
        instanceUrl: principal.instanceUrl,
      })
    )[0];
    expect(storedAfterRefresh?.gapPending).toBe(false);
    expect(storedAfterRefresh?.safeWatermark).toBe(refreshed.cursor);
    expect(storedAfterRefresh?.lastGapCursor).toBe(savedLastGapCursor);
    expect(sentPayloads.some((p) => p.type === "gap")).toBe(true);
  });

  test("Events: credentialGeneration rotation takeover and normalizeArgsForCanonical({ includeSelf: undefined })", async () => {
    // 1. normalizeArgsForCanonical strips undefined keys cleanly and canonicalJson(undefined) -> "null"
    expect(
      canonicalJson(normalizeArgsForCanonical({ includeSelf: undefined, product: "Browser" })),
    ).toBe('{"includeSelf":false,"product":"Browser"}');
    expect(canonicalJson(normalizeArgsForCanonical({ includeSelf: undefined }))).toBe(
      '{"includeSelf":false}',
    );
    expect(canonicalJson(undefined)).toBe("null");

    // 2. credentialGeneration rotation takeover
    const clock = manualClock();
    const storage = createSqliteStorage(":memory:");
    const callbackUrl = "https://callback.example/rotation";
    const webhookSecret = `whsec_${Buffer.alloc(32, 77).toString("base64")}`;
    const transport: WebhookOutboundTransport = {
      async resolveHost() {
        return ["1.1.1.1"];
      },
      async postPinned(req) {
        const parsed = JSON.parse(req.rawBody) as { type?: string; challenge?: string };
        return {
          status: 200,
          body:
            parsed.type === "verification" ? JSON.stringify({ challenge: parsed.challenge }) : "ok",
        };
      },
    };
    let activeGeneration = 1;
    const client = bugzilla().client;
    const events = createSyntheticEventsService(
      dependencies(client, {
        storage,
        clock: clock.now,
        webhookTransport: transport,
        resolveClient: async (ctx) =>
          ctx.credentialGeneration >= activeGeneration ? client : null,
      }),
    );

    const gen1Principal: PrincipalContext = { ...principal, credentialGeneration: 1 };
    const sub1 = await events.subscribeWebhook(gen1Principal, {
      name: "bugzilla.bug.commented",
      arguments: { includeSelf: false },
      delivery: { mode: "webhook", url: callbackUrl, secret: webhookSecret },
      cursor: null,
      ttlMs: null,
    });
    expect(sub1.id).toBeTruthy();

    // Rotate credential to generation 2 -> gen1 subscription gets revoked on sweep
    activeGeneration = 2;
    clock.advance(5_000);
    const sweepResult = await events.deliverPendingWebhooks(gen1Principal);
    expect(sweepResult.terminated).toBe(1);

    // Stale generation 1 cannot reclaim revoked subscription
    await expect(
      events.subscribeWebhook(gen1Principal, {
        name: "bugzilla.bug.commented",
        arguments: { includeSelf: false },
        delivery: { mode: "webhook", url: callbackUrl, secret: webhookSecret },
        cursor: null,
        ttlMs: null,
      }),
    ).rejects.toMatchObject({ code: -32024 });

    // Higher generation 2 cleanly takes over the revoked subscription
    const gen2Principal: PrincipalContext = { ...principal, credentialGeneration: 2 };
    const sub2 = await events.subscribeWebhook(gen2Principal, {
      name: "bugzilla.bug.commented",
      arguments: { includeSelf: false },
      delivery: { mode: "webhook", url: callbackUrl, secret: webhookSecret },
      cursor: null,
      ttlMs: null,
    });
    expect(sub2.id).toBeTruthy();
    expect(sub2.id).not.toBe(sub1.id);

    // Stale gen 1 cannot overwrite active gen 2 subscription
    await expect(
      events.subscribeWebhook(gen1Principal, {
        name: "bugzilla.bug.commented",
        arguments: { includeSelf: false },
        delivery: { mode: "webhook", url: callbackUrl, secret: webhookSecret },
        cursor: null,
        ttlMs: null,
      }),
    ).rejects.toMatchObject({ code: -32024 });
  });

  test("packages/app-ui/src has zero runtime imports from @bugzilla-mcp/contracts or effect, and UI helpers enforce safety invariants", () => {
    const appUiSrcRoot = resolve(process.cwd(), "packages/app-ui/src");
    const sourceFiles: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
        } else if (full.endsWith(".ts") || full.endsWith(".tsx")) {
          sourceFiles.push(full);
        }
      }
    };
    walk(appUiSrcRoot);
    expect(sourceFiles.length).toBeGreaterThan(0);

    const runtimeImportRe =
      /(?:^|\n)\s*import\s+(?!type\b)[\s\S]*?\bfrom\s+["'](@bugzilla-mcp\/contracts(?:\/[^"']*)?|effect(?:\/[^"']*)?)["']/g;
    const bareSideEffectImportRe =
      /(?:^|\n)\s*import\s+["'](@bugzilla-mcp\/contracts(?:\/[^"']*)?|effect(?:\/[^"']*)?)["']/g;
    const dynamicImportRe =
      /\bimport\s*\(\s*["'](@bugzilla-mcp\/contracts(?:\/[^"']*)?|effect(?:\/[^"']*)?)["']\s*\)/g;

    const violations: string[] = [];
    for (const file of sourceFiles) {
      const content = readFileSync(file, "utf8");
      if (
        runtimeImportRe.test(content) ||
        bareSideEffectImportRe.test(content) ||
        dynamicImportRe.test(content)
      ) {
        violations.push(file);
      }
      runtimeImportRe.lastIndex = 0;
      bareSideEffectImportRe.lastIndex = 0;
      dynamicImportRe.lastIndex = 0;
    }
    expect(violations).toEqual([]);

    // Sanity-check key Track A UI helpers
    const errRes = unwrapToolResult({
      isError: true,
      structuredContent: {
        error: true,
        code: "credential_revoked",
        message: "API key revoked",
      },
    });
    expect(errRes.ok).toBe(false);
    if (!errRes.ok) {
      expect(errRes.kind).toBe("credential_revoked");
      expect(errRes.code).toBe("credential_revoked");
    }

    const boundedKey = createBoundedIdempotencyKey("approve", "x".repeat(200), 1);
    expect(boundedKey.length).toBeGreaterThanOrEqual(8);
    expect(boundedKey.length).toBeLessThanOrEqual(128);

    expect(isSafeHttpUrl("https://bugzilla.example/show_bug.cgi?id=41")).toBe(true);
    expect(isSafeHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeHttpUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  test("classifyResponse maps structured POST/PUT HTTP 404 input errors to BugzillaValidationError while preserving [R-32f1fc] for ACL/32614/codeless/GET 404", () => {
    const runFail = (
      method: "GET" | "POST" | "PUT",
      resp: Parameters<typeof classifyResponseOutcome>[1],
      secrets: readonly string[] = [],
    ) => {
      const outcome = classifyResponseOutcome(method, resp, secrets);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Expected failure outcome");
      return outcome.error;
    };

    // 1. POST & PUT HTTP 404 with structured Bugzilla code 51 (unknown keyword) -> BugzillaValidationError
    for (const method of ["POST", "PUT"] as const) {
      const err = runFail(
        method,
        {
          status: 404,
          data: null,
          parseOk: true,
          bzError: true,
          bzErrorCode: 51,
          bzMessage:
            "There is no keyword named 'nonexistent' (https://bz.example/rest/bug?api_key=super-secret-key).",
        },
        ["super-secret-key"],
      );
      expect(err).toBeInstanceOf(BugzillaValidationError);
      if (!(err instanceof BugzillaValidationError)) throw new Error("Expected validation error");
      expect(err.effectCertainty).toBe("none");
      expect(err.httpStatus).toBe(404);
      expect(err.bzErrorCode).toBe(51);
      expect(err.bzMessage).toContain("There is no keyword named 'nonexistent'");
      expect(err.bzMessage).not.toContain("super-secret-key");
      expect(err.missingFields).toEqual(["keywords"]);
    }

    // Also verify field extraction for keyword/milestone/user lookup variants
    expect(extractMissingFields("Keyword 'foo' does not exist.")).toEqual(["keywords"]);
    expect(extractMissingFields("Unknown keyword 'bar'.")).toEqual(["keywords"]);
    expect(extractMissingFields("There is no milestone named 'v9.9'.")).toEqual([
      "target_milestone",
    ]);
    expect(extractMissingFields("There is no user named 'ghost@example.test'.")).toEqual(["user"]);

    // 2. [R-32f1fc] strictly preserved for ACL codes (101, 102, 110, 111, 505, 113) & route-not-found (32614)
    for (const code of [101, 102, 110, 111, 505, 113, 32614]) {
      for (const method of ["GET", "POST", "PUT"] as const) {
        const err = runFail(method, {
          status: 404,
          data: null,
          parseOk: true,
          bzError: true,
          bzErrorCode: code,
          bzMessage: `Access denied or route missing (code ${code})`,
        });
        expect(err, `${method} code ${code}`).toBeInstanceOf(BugzillaAccessDeniedError);
      }
    }

    // 3. Codeless 404, non-bzError JSON 404, non-JSON 404, HTTP 403, and GET 404 (even code 51) -> BugzillaAccessDeniedError
    for (const [label, method, resp] of [
      [
        "POST codeless 404",
        "POST",
        { status: 404, data: null, parseOk: true, bzError: true, bzMessage: "Not found" },
      ],
      [
        "PUT non-bzError 404",
        "PUT",
        { status: 404, data: { detail: "missing" }, parseOk: true, bzError: false },
      ],
      ["POST non-JSON 404", "POST", { status: 404, data: null, parseOk: false, bzError: false }],
      [
        "POST HTTP 403 code 51",
        "POST",
        {
          status: 403,
          data: null,
          parseOk: true,
          bzError: true,
          bzErrorCode: 51,
          bzMessage: "Forbidden",
        },
      ],
      [
        "GET HTTP 404 code 51",
        "GET",
        {
          status: 404,
          data: null,
          parseOk: true,
          bzError: true,
          bzErrorCode: 51,
          bzMessage: "There is no keyword named 'bogus'.",
        },
      ],
    ] as const) {
      const err = runFail(method, resp);
      expect(err, label).toBeInstanceOf(BugzillaAccessDeniedError);
    }
  });

  test("bugzilla_create_bug nonexistent keywords: preflight (populated & empty values) and fallback HTTP 404 all return UpstreamRejected without key poisoning", async () => {
    const makeHandler = (
      client: Parameters<typeof dependencies>[0],
      storage: ReturnType<typeof createSqliteStorage>,
    ) =>
      createDualEraHttpHandler({
        mode: "cloud-multi-user",
        allowedOrigins: [origin],
        allowAbsentOrigin: true,
        eventsProfile: "sep-3415",
        publicBaseUrl: serviceUrl,
        core: dependencies(client, { storage }),
        authenticateBearerToken: async (tok) => (tok === bearer ? principal : null),
      });

    // (a) Preflight with non-empty keywords.values -> UpstreamRejected with fieldHints.keywords, 0 writes, 0 receipts
    {
      const storage = createSqliteStorage(":memory:");
      const upstream = bugzilla({
        async getBugFields() {
          return [
            {
              id: 10,
              name: "keywords",
              displayName: "Keywords",
              type: 8,
              isCustom: false,
              isMandatory: false,
              isOnBugEntry: true,
              values: [{ name: "regression" }, { name: "perf" }],
            },
          ];
        },
      });
      const handler = makeHandler(upstream.client, storage);
      const key = "create-kw-preflight-populated-001";
      const res = await handler.handleHttp(
        modernRequest("tools/call", {
          name: "bugzilla_create_bug",
          arguments: {
            idempotencyKey: key,
            product: "Browser",
            component: "Layout",
            version: "1.0",
            summary: "Unknown keyword test",
            description: "Should fail preflight before upstream write",
            keywords: ["regression", "bogus-kw"],
          },
        }),
      );
      expect(res.status).toBe(200);
      const rpc = parseRpc(res) as {
        result: {
          isError: boolean;
          content: Array<{ text: string }>;
          structuredContent: {
            outcome: string;
            effectCertainty: string;
            missingFields: string[];
            fieldHints: Record<string, string[]>;
            reason: string;
          };
        };
      };
      expect(rpc.result.isError).toBe(true);
      expect(rpc.result.structuredContent).toMatchObject({
        outcome: "UpstreamRejected",
        effectCertainty: "none",
        missingFields: ["keywords"],
        fieldHints: { keywords: ["regression", "perf"] },
      });
      expect(rpc.result.structuredContent.reason).toContain("bogus-kw");
      expect(rpc.result.content[0]?.text).not.toContain("Resource not found or inaccessible");
      expect(upstream.mutations).toEqual([]);
      expect(
        await storage.getReceipt({
          issuer: principal.issuer,
          principalId: principal.principalId,
          instanceUrl: principal.instanceUrl,
          operation: "bugzilla_create_bug",
          key,
        }),
      ).toBeNull();

      // Case-insensitive valid keyword matches Bugzilla 5.2 sql_istrcmp behavior -> Applied
      const okRes = await handler.handleHttp(
        modernRequest("tools/call", {
          name: "bugzilla_create_bug",
          arguments: {
            idempotencyKey: key,
            product: "Browser",
            component: "Layout",
            version: "1.0",
            summary: "Valid case-insensitive keyword",
            description: "Should pass preflight and create bug",
            keywords: ["Regression"],
          },
        }),
      );
      const okRpc = parseRpc(okRes) as {
        result: { isError?: boolean; structuredContent: { outcome: string; bugId: number } };
      };
      expect(okRpc.result.isError).not.toBe(true);
      expect(okRpc.result.structuredContent).toMatchObject({ outcome: "Applied", bugId: 200 });
      expect(upstream.mutations).toHaveLength(1);
    }

    // (b) Preflight with empty keywords.values: [] -> UpstreamRejected stating no keywords configured, 0 writes, 0 receipts
    {
      const storage = createSqliteStorage(":memory:");
      const upstream = bugzilla({
        async getBugFields() {
          return [
            {
              id: 10,
              name: "keywords",
              displayName: "Keywords",
              type: 8,
              isCustom: false,
              isMandatory: false,
              isOnBugEntry: true,
              values: [],
            },
          ];
        },
      });
      const handler = makeHandler(upstream.client, storage);
      const key = "create-kw-preflight-empty-001";
      const res = await handler.handleHttp(
        modernRequest("tools/call", {
          name: "bugzilla_create_bug",
          arguments: {
            idempotencyKey: key,
            product: "Browser",
            component: "Layout",
            version: "1.0",
            summary: "Empty keywords instance test",
            description: "Bugzilla 5.2 returns values: [] when no keywords exist",
            keywords: ["nonexistent"],
          },
        }),
      );
      expect(res.status).toBe(200);
      const rpc = parseRpc(res) as {
        result: {
          isError: boolean;
          structuredContent: {
            outcome: string;
            effectCertainty: string;
            missingFields: string[];
            reason: string;
            remediationHint: string;
          };
        };
      };
      expect(rpc.result.isError).toBe(true);
      expect(rpc.result.structuredContent).toMatchObject({
        outcome: "UpstreamRejected",
        effectCertainty: "none",
        missingFields: ["keywords"],
      });
      expect(rpc.result.structuredContent.reason).toContain(
        "No keywords are configured on this Bugzilla instance",
      );
      expect(rpc.result.structuredContent.remediationHint).toContain("Omit keywords");
      expect(upstream.mutations).toEqual([]);
      expect(
        await storage.getReceipt({
          issuer: principal.issuer,
          principalId: principal.principalId,
          instanceUrl: principal.instanceUrl,
          operation: "bugzilla_create_bug",
          key,
        }),
      ).toBeNull();
    }

    // (c) Fallback upstream HTTP 404 path (when /rest/field/bug omits keywords.values) ->
    // real REST client classifies 404 code 51 as BugzillaValidationError -> UpstreamRejected,
    // receipt marked failed, same idempotencyKey reusable after fixing -> Applied
    {
      const storage = createSqliteStorage(":memory:");
      let postCount = 0;
      const restClient = createRestBugzillaClient({
        baseUrl: "https://bz.example",
        apiKey: "test-api-key-secret",
        maxGetRetries: 0,
        fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
          const url = typeof input === "string" ? input : input.toString();
          const method = init?.method ?? "GET";
          if (method === "GET" && url.includes("/rest/product/")) {
            return new Response(
              JSON.stringify({
                products: [
                  {
                    id: 1,
                    name: "Browser",
                    is_active: true,
                    components: [{ id: 1, name: "Layout", is_active: true }],
                    versions: [{ id: 1, name: "1.0", is_active: true }],
                  },
                ],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (method === "GET" && url.includes("/rest/field/bug")) {
            // Omit `values` on keywords so preflight gracefully degrades to Layer 1 classify.ts
            return new Response(
              JSON.stringify({
                fields: [{ id: 10, name: "keywords", display_name: "Keywords", type: 8 }],
              }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          if (method === "POST" && url.endsWith("/rest/bug")) {
            postCount += 1;
            const body = JSON.parse(String(init?.body ?? "{}")) as { keywords?: string[] };
            if (body.keywords?.includes("bogus-404")) {
              return new Response(
                JSON.stringify({
                  error: true,
                  code: 51,
                  message: "There is no keyword named 'bogus-404'.",
                }),
                { status: 404, headers: { "content-type": "application/json" } },
              );
            }
            return new Response(JSON.stringify({ id: 777 }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(JSON.stringify({}), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }) as unknown as typeof fetch,
      });

      const handler = makeHandler(restClient, storage);
      const key = "create-kw-fallback-404-001";
      const firstRes = await handler.handleHttp(
        modernRequest("tools/call", {
          name: "bugzilla_create_bug",
          arguments: {
            idempotencyKey: key,
            product: "Browser",
            component: "Layout",
            version: "1.0",
            summary: "Fallback 404 keyword test",
            description: "First call triggers Bugzilla 5.2 HTTP 404 code 51",
            keywords: ["bogus-404"],
          },
        }),
      );
      expect(firstRes.status).toBe(200);
      const firstRpc = parseRpc(firstRes) as {
        result: {
          isError: boolean;
          content: Array<{ text: string }>;
          structuredContent: {
            outcome: string;
            effectCertainty: string;
            bzErrorCode: number;
            reason: string;
            missingFields: string[];
          };
        };
      };
      expect(firstRpc.result.isError).toBe(true);
      expect(firstRpc.result.structuredContent).toMatchObject({
        outcome: "UpstreamRejected",
        effectCertainty: "none",
        bzErrorCode: 51,
        reason: "There is no keyword named 'bogus-404'.",
        missingFields: ["keywords"],
      });
      expect(firstRpc.result.content[0]?.text).toContain("There is no keyword named 'bogus-404'.");
      expect(firstRpc.result.content[0]?.text).not.toContain("Resource not found or inaccessible");

      const receiptAfter404 = await storage.getReceipt({
        issuer: principal.issuer,
        principalId: principal.principalId,
        instanceUrl: principal.instanceUrl,
        operation: "bugzilla_create_bug",
        key,
      });
      expect(receiptAfter404?.status).toBe("failed");

      // Reusing the exact same idempotencyKey after removing the bad keyword succeeds -> Applied
      const secondRes = await handler.handleHttp(
        modernRequest("tools/call", {
          name: "bugzilla_create_bug",
          arguments: {
            idempotencyKey: key,
            product: "Browser",
            component: "Layout",
            version: "1.0",
            summary: "Fallback 404 keyword test",
            description: "Second call omits invalid keyword and reuses idempotencyKey",
          },
        }),
      );
      const secondRpc = parseRpc(secondRes) as {
        result: { isError?: boolean; structuredContent: { outcome: string; artifactId: string } };
      };
      expect(secondRpc.result.isError).not.toBe(true);
      expect(secondRpc.result.structuredContent).toMatchObject({
        outcome: "Applied",
        artifactId: "bug:777",
      });
      expect(postCount).toBe(2);
    }
  });

  test("applyBugUpdate / resolveProposal on upstream HTTP 404 invalid user (code 51) returns UpstreamRejected and reverts proposal executing -> pending", async () => {
    const storage = createSqliteStorage(":memory:");
    const approvalService = createCloudApprovalTokenService(signingSecret, storage);
    const restClient = createRestBugzillaClient({
      baseUrl: "https://bz.example",
      apiKey: "test-api-key-secret",
      maxGetRetries: 0,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.toString();
        const method = init?.method ?? "GET";
        if (method === "GET" && url.includes("/rest/bug/41")) {
          return new Response(
            JSON.stringify({
              bugs: [
                {
                  id: 41,
                  summary: "Visible regression",
                  product: "Browser",
                  component: "Layout",
                  status: "NEW",
                  resolution: "",
                  priority: "P2",
                  severity: "normal",
                  assigned_to: "alice@example.test",
                  last_change_time: iso(epoch),
                },
              ],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (method === "PUT" && url.endsWith("/rest/bug/41")) {
          return new Response(
            JSON.stringify({
              error: true,
              code: 51,
              message: "There is no user named 'ghost@example.test'.",
            }),
            { status: 404, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
    });

    const writeGuard = createWriteGuardService(
      dependencies(restClient, { storage, cloudApprovalService: approvalService }),
    );
    const proposed = await writeGuard.proposeUpdate(principal, {
      bugId: 41,
      idempotencyKey: "prop-404-user-001",
      expectedLastChangeTime: iso(epoch),
      diff: { assignedTo: "ghost@example.test" },
      rationale: "Reassign to nonexistent user",
    });
    expect(proposed.outcome).toBe("ProposalPending");
    if (proposed.outcome !== "ProposalPending") throw new Error("Expected ProposalPending");

    const token = await approvalService.issue({
      approverIssuer: principal.issuer,
      approverPrincipalId: principal.principalId,
      instanceUrl: principal.instanceUrl,
      proposalId: proposed.proposalId,
      revision: proposed.revision,
      bugId: 41,
      baseVersion: iso(epoch),
      diff: { assignedTo: "ghost@example.test" },
      visibility: "public",
      ttlMs: 60_000,
      nowMs: epoch,
    });

    const resolved = await writeGuard.resolveProposal(principal, {
      proposalId: proposed.proposalId,
      revision: proposed.revision,
      decision: "approve",
      idempotencyKey: "resolve-404-user-001",
      approval: { kind: "cloud_signed_token", token: token.token },
    });
    expect(resolved).toMatchObject({
      outcome: "UpstreamRejected",
      effectCertainty: "none",
      bzErrorCode: 51,
      reason: "There is no user named 'ghost@example.test'.",
      missingFields: ["user"],
    });

    const storedProposal = await storage.getProposal(
      principal.issuer,
      principal.principalId,
      principal.instanceUrl,
      proposed.proposalId,
      proposed.revision,
    );
    expect(storedProposal?.state).toBe("pending");

    const storedReceipt = await storage.getReceipt({
      issuer: principal.issuer,
      principalId: principal.principalId,
      instanceUrl: principal.instanceUrl,
      operation: "app_resolve_proposal",
      key: "resolve-404-user-001",
    });
    expect(storedReceipt?.status).toBe("failed");
  });
});
