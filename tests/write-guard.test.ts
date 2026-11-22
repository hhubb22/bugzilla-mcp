import type { BugzillaClient } from "../packages/bugzilla-client/src/index.js";
import type {
  BugzillaPostAnalysisInput,
  BugzillaProposeUpdateInput,
} from "../packages/contracts/src/index.js";
import {
  createCloudApprovalTokenService,
  createWriteGuardService,
} from "../packages/core/src/index.js";
import type { CloudApprovalExpected } from "../packages/core/src/index.js";
import fc from "fast-check";
import { expect, test } from "vite-plus/test";
import {
  bugSummary,
  bugzilla,
  deferred,
  dependencies,
  epoch,
  iso,
  manualClock,
  memoryStorage,
  principal,
} from "./helpers/fakes.js";

const bugId = 41;
const analysis: BugzillaPostAnalysisInput = {
  bugId,
  idempotencyKey: "analysis-01",
  analysisMarkdown: "compare the two traces",
  isPrivate: true,
};
const proposal: BugzillaProposeUpdateInput = {
  bugId,
  idempotencyKey: "proposal-01",
  expectedLastChangeTime: iso(epoch),
  diff: { status: "ASSIGNED", publicComment: "Confirmed on the test build" },
  rationale: "Reproduced",
};

const approvalTarget: CloudApprovalExpected = {
  approverIssuer: principal.issuer,
  approverPrincipalId: principal.principalId,
  instanceUrl: principal.instanceUrl,
  proposalId: "proposal-fixture",
  revision: 1,
  bugId,
  baseVersion: iso(epoch),
  diff: proposal.diff,
  visibility: "public",
  nowMs: epoch,
};
const signingSecret = "verification-signing-secret-for-synthetic-approvals";

// EVIDENCE-OF: R-d31426
// EVIDENCE-OF: R-a722be
// EVIDENCE-OF: R-f5dc7f
test("server policy may bypass proposal review while local host confirmation can resolve a pending proposal", async () => {
  const upstream = bugzilla();
  const guarded = createWriteGuardService(
    dependencies(upstream.client, {
      isPolicyGranted: async (_, input) => input.diff.status === "ASSIGNED",
    }),
  );
  expect(await guarded.proposeUpdate(principal, proposal)).toMatchObject({
    outcome: "Applied",
    auditRecorded: true,
  });
  expect(upstream.mutations).toEqual([{ kind: "update", bugId, diff: proposal.diff }]);

  const local = { ...principal, deploymentMode: "local-trusted-ide" } as const;
  const service = createWriteGuardService(dependencies(upstream.client));
  const pending = await service.proposeUpdate(local, proposal);
  if (pending.outcome !== "ProposalPending")
    throw new Error("Expected local review before mutation");
  expect(upstream.mutations).toHaveLength(1);
  const { proposalId, revision } = pending;
  const input = {
    proposalId,
    revision,
    idempotencyKey: "local-approval",
    decision: "approve",
    approval: { kind: "local_ide_host_confirmed", confirmedAt: iso(epoch) },
  } as const;
  expect(await service.resolveProposal(local, input)).toMatchObject({
    outcome: "Applied",
    auditRecorded: true,
  });
  expect(upstream.mutations).toHaveLength(2);
});

// EVIDENCE-OF: R-a722be
test.each([
  { caseName: "approver", change: { approverPrincipalId: "bob" }, reason: "binding_mismatch" },
  {
    caseName: "instance",
    change: { instanceUrl: "https://other.example" },
    reason: "binding_mismatch",
  },
  { caseName: "proposal", change: { proposalId: "other-proposal" }, reason: "binding_mismatch" },
  { caseName: "revision", change: { revision: 2 }, reason: "binding_mismatch" },
  { caseName: "bug", change: { bugId: 42 }, reason: "binding_mismatch" },
  { caseName: "diff", change: { diff: { status: "RESOLVED" } }, reason: "binding_mismatch" },
  { caseName: "base", change: { baseVersion: iso(epoch + 1000) }, reason: "binding_mismatch" },
  { caseName: "visibility", change: { visibility: "private" }, reason: "visibility_mismatch" },
  { caseName: "expiry", change: { nowMs: epoch + 60_001 }, reason: "expired" },
] as const)("approval verifies $caseName against the signed intent", async ({ change, reason }) => {
  const approval = createCloudApprovalTokenService(signingSecret);
  const { token } = await approval.issue({ ...approvalTarget, ttlMs: 60_000 });
  expect(await approval.verifyAndConsume(token, { ...approvalTarget, ...change })).toEqual({
    valid: false,
    reason,
  });
});

// EVIDENCE-OF: R-a722be
test("signed approval rejects a different signer and only one concurrent canonical match can consume it", async () => {
  const approval = createCloudApprovalTokenService(signingSecret);
  const foreign = createCloudApprovalTokenService(
    "unrelated-verification-secret-for-signature-negative-case",
  );
  const grant = await approval.issue({ ...approvalTarget, ttlMs: 60_000 });
  expect(Date.parse(grant.expiresAt)).toBe(epoch + 60_000);
  expect(await foreign.verifyAndConsume(grant.token, approvalTarget)).toEqual({
    valid: false,
    reason: "invalid_signature",
  });
  const canonical = {
    ...approvalTarget,
    diff: { publicComment: "Confirmed on the test build", status: "ASSIGNED" },
  };
  const results = await Promise.all([
    approval.verifyAndConsume(grant.token, canonical),
    approval.verifyAndConsume(grant.token, approvalTarget),
  ]);
  expect(results).toHaveLength(2);
  expect(results).toEqual(
    expect.arrayContaining([{ valid: true }, { valid: false, reason: "replayed" }]),
  );
});

// EVIDENCE-OF: R-d31426
// EVIDENCE-OF: R-a722be
test("cloud resolution needs signed approval and executes each approved proposal at most once", async () => {
  const upstream = bugzilla();
  const storage = memoryStorage();
  const approval = createCloudApprovalTokenService(signingSecret);
  const service = createWriteGuardService(
    dependencies(upstream.client, { storage, cloudApprovalService: approval }),
  );
  const pending = await service.proposeUpdate(principal, {
    ...proposal,
    idempotencyKey: analysis.idempotencyKey,
  });
  expect(pending).toMatchObject({ outcome: "ProposalPending" });
  if (pending.outcome !== "ProposalPending") throw new Error("Expected a pending proposal");
  const { proposalId, revision } = pending;
  const resolve = {
    proposalId,
    revision,
    decision: "approve",
    idempotencyKey: "resolve-without-signature",
  } as const;
  const assertRefused = async (call: () => Promise<unknown>) => {
    const result = await call().catch(() => null);
    if (result !== null) expect(result).not.toMatchObject({ outcome: "Applied" });
    expect(upstream.mutations).toEqual([]);
  };
  await assertRefused(() => service.resolveProposal(principal, resolve));
  await assertRefused(() =>
    service.resolveProposal(principal, {
      ...resolve,
      idempotencyKey: "resolve-with-local-proof",
      approval: { kind: "local_ide_host_confirmed", confirmedAt: iso(epoch) },
    }),
  );
  const grant = await approval.issue({ ...approvalTarget, proposalId, revision, ttlMs: 60_000 });
  const valid = {
    ...resolve,
    idempotencyKey: analysis.idempotencyKey,
    approval: { kind: "cloud_signed_token", token: grant.token } as const,
  };
  expect(await service.postAnalysis(principal, analysis)).toMatchObject({ outcome: "Applied" });
  const applied = await service.resolveProposal(principal, valid);
  expect(applied).toMatchObject({ outcome: "Applied", auditRecorded: true, bugId });
  expect(await service.resolveProposal(principal, valid)).toEqual({
    outcome: "DuplicateNoOp",
    originalArtifactId: "artifactId" in applied ? applied.artifactId : undefined,
  });
  const replay = await service
    .resolveProposal(principal, { ...valid, idempotencyKey: "resolve-fresh-key" })
    .catch(() => null);
  if (replay !== null) expect(replay).not.toMatchObject({ outcome: "Applied" });
  expect(upstream.mutations.map(({ kind }) => kind)).toEqual(["private", "update"]);
});

// EVIDENCE-OF: R-d31426
// EVIDENCE-OF: R-f5dc7f
test("an external edit makes a signed proposal stale and only a newly authorized base can be applied and audited", async () => {
  let version = iso(epoch);
  const upstream = bugzilla({
    async getBugDossierData(id) {
      const bug = bugSummary(id, "Current authorized title", version);
      return {
        bug,
        recentHistory: [],
        attachments: [],
        recentComments: [
          {
            id: 99,
            creator: "alice@example.test",
            time: version,
            isPrivate: true,
            text: "dossier-only-detail",
            untrustedUserContent: true,
          },
        ],
      };
    },
  });
  const storage = memoryStorage();
  const approval = createCloudApprovalTokenService(signingSecret);
  const service = createWriteGuardService(
    dependencies(upstream.client, { storage, cloudApprovalService: approval }),
  );
  async function authorize(input: BugzillaProposeUpdateInput) {
    const pending = await service.proposeUpdate(principal, input);
    if (pending.outcome !== "ProposalPending")
      throw new Error("Expected an immutable pending proposal");
    const { proposalId, revision } = pending;
    const grant = await approval.issue({
      ...approvalTarget,
      proposalId,
      revision,
      baseVersion: input.expectedLastChangeTime,
      ttlMs: 60_000,
    });
    return {
      proposalId,
      revision,
      decision: "approve",
      idempotencyKey: `resolve-${input.idempotencyKey}`,
      approval: { kind: "cloud_signed_token", token: grant.token },
    } as const;
  }
  const original = await authorize(proposal);
  version = iso(epoch + 500);
  const stale = await service.resolveProposal(principal, original);
  expect(stale).toEqual({
    outcome: "StaleBugConflict",
    expectedLastChangeTime: iso(epoch),
    actualLastChangeTime: version,
    latestAuthorizedSnapshot: bugSummary(bugId, "Current authorized title", version),
  });
  expect(upstream.mutations).toEqual([]);
  expect(
    await storage.listWriteAudits(
      principal.issuer,
      principal.principalId,
      principal.instanceUrl,
      bugId,
    ),
  ).toEqual([]);
  const rebased = await authorize({
    ...proposal,
    expectedLastChangeTime: version,
    idempotencyKey: "rebased-proposal",
  });
  expect([rebased.proposalId, rebased.revision]).not.toEqual([
    original.proposalId,
    original.revision,
  ]);
  expect(
    await storage.getProposal(
      principal.issuer,
      principal.principalId,
      principal.instanceUrl,
      original.proposalId,
      original.revision,
    ),
  ).toMatchObject({
    baseVersion: iso(epoch),
    diff: proposal.diff,
  });
  expect(await service.resolveProposal(principal, rebased)).toMatchObject({
    outcome: "Applied",
    auditRecorded: true,
  });
  expect(upstream.mutations).toEqual([{ kind: "update", bugId, diff: proposal.diff }]);
  expect(
    await storage.listWriteAudits(
      principal.issuer,
      principal.principalId,
      principal.instanceUrl,
      bugId,
    ),
  ).toEqual([
    expect.objectContaining({
      issuer: principal.issuer,
      principalId: principal.principalId,
      instanceUrl: principal.instanceUrl,
      bugId,
      proposalId: rebased.proposalId,
      revision: rebased.revision,
      expectedLastChangeTime: version,
      updatedLastChangeTime: iso(epoch + 1000),
      diff: proposal.diff,
    }),
  ]);
});

// EVIDENCE-OF: R-462339
test("new keys and event IDs cannot evade a per-bug budget, which becomes available again after its window", async () => {
  await fc.assert(
    fc.asyncProperty(fc.uniqueArray(fc.uuid(), { minLength: 4, maxLength: 7 }), async (keys) => {
      const upstream = bugzilla();
      const clock = manualClock();
      const service = createWriteGuardService(
        dependencies(upstream.client, {
          clock: clock.now,
          causalBudgetPerBug: 2,
          causalBudgetWindowMs: 1000,
        }),
      );
      for (const [index, idempotencyKey] of keys.entries()) {
        const result = await service.postAnalysis(principal, {
          ...analysis,
          idempotencyKey,
          causalEventId: `source-event-${index}`,
        });
        expect(result).toMatchObject(
          index < 2
            ? { outcome: "Applied" }
            : { outcome: "CausalBudgetExhausted", bugId, retryAfterMs: expect.any(Number) },
        );
        expect(upstream.mutations).toHaveLength(Math.min(index + 1, 2));
      }
      expect(
        await service.postAnalysis(principal, {
          ...analysis,
          bugId: 42,
          causalEventId: "separate-bug",
        }),
      ).toMatchObject({ outcome: "Applied" });
      clock.advance(1001);
      expect(
        await service.postAnalysis(principal, {
          ...analysis,
          idempotencyKey: "next-window",
          causalEventId: "next-window",
        }),
      ).toMatchObject({ outcome: "Applied" });
      expect(upstream.mutations.map((entry) => entry.bugId)).toEqual([bugId, bugId, 42, bugId]);
    }),
    { seed: 679, numRuns: 24 },
  );
});

// EVIDENCE-OF: R-d31426
// EVIDENCE-OF: R-68841d
// EVIDENCE-OF: R-e49910
test("matches a receipt history by principal, instance, key and canonical intent across generated traces", async () => {
  const request = fc.record({
    user: fc.constantFrom("alice", "bob"),
    site: fc.constantFrom("first", "second"),
    key: fc.integer({ min: 1, max: 3 }),
    intent: fc.constantFrom("first analysis", "second analysis"),
  });
  await fc.assert(
    fc.asyncProperty(fc.array(request, { minLength: 1, maxLength: 25 }), async (trace) => {
      const upstream = bugzilla();
      const storage = memoryStorage();
      const service = createWriteGuardService(dependencies(upstream.client, { storage }));
      const accepted: Array<{ request: (typeof trace)[number]; artifact: string }> = [];
      for (const operation of trace) {
        const prior = accepted.find(
          ({ request }) =>
            request.user === operation.user &&
            request.site === operation.site &&
            request.key === operation.key,
        );
        const ctx = {
          ...principal,
          principalId: operation.user,
          instanceUrl: `https://${operation.site}.example`,
        };
        const input = {
          ...analysis,
          idempotencyKey: `trace-key-${operation.key}`,
          analysisMarkdown: operation.intent,
        };
        const outcome = await service.postAnalysis(ctx, input);
        if (!prior) {
          expect(outcome).toMatchObject({ outcome: "Applied", bugId });
          if (outcome.outcome !== "Applied") throw new Error("Expected an accepted analysis");
          accepted.push({ request: operation, artifact: outcome.artifactId });
          expect(
            await storage.hasSelfWrite({
              instanceUrl: ctx.instanceUrl,
              bugId,
              commentId: 99 + accepted.length,
            }),
          ).toBe(true);
        } else if (prior.request.intent === operation.intent) {
          expect(outcome).toEqual({ outcome: "DuplicateNoOp", originalArtifactId: prior.artifact });
        } else {
          expect(outcome).toEqual({
            outcome: "IdempotencyConflict",
            idempotencyKey: input.idempotencyKey,
          });
        }
        expect(upstream.mutations).toEqual(
          accepted.map(({ request }, index) => ({
            kind: "private",
            bugId,
            text: expect.stringContaining(request.intent),
            commentId: index + 100,
          })),
        );
      }
    }),
    { seed: 31426, numRuns: 40 },
  );
});

// EVIDENCE-OF: R-d31426
// EVIDENCE-OF: R-68841d
// EVIDENCE-OF: R-e49910
test.each([false, true])(
  "overlapping calls expose pending and reconcile a lost response without redispatch (response lost %s)",
  async (lost) => {
    const entered = deferred<void>();
    const release = deferred<void>();
    const upstream = bugzilla();
    const service = createWriteGuardService(
      dependencies({
        ...upstream.client,
        async postPrivateComment(id, text) {
          const result = await upstream.client.postPrivateComment(id, text);
          entered.resolve();
          await release.promise;
          if (lost)
            throw new DOMException("Synthetic upstream write response timeout", "TimeoutError");
          return result;
        },
      }),
    );
    const first = service.postAnalysis(principal, analysis);
    try {
      await Promise.race([
        entered.promise,
        first.then(() => {
          throw new Error("Write ended before dispatch");
        }),
      ]);
      expect(await service.postAnalysis(principal, analysis)).toEqual({
        outcome: "OperationPending",
        idempotencyKey: analysis.idempotencyKey,
      });
      expect(
        await service.postAnalysis(principal, { ...analysis, analysisMarkdown: "different" }),
      ).toMatchObject({
        outcome: "IdempotencyConflict",
      });
      expect(upstream.mutations).toHaveLength(1);
    } finally {
      release.resolve();
      await first;
    }
    const result = await first;
    const replay = await service.postAnalysis(principal, analysis);
    if (lost) {
      expect(result).toMatchObject({
        outcome: "OperationIndeterminate",
        idempotencyKey: analysis.idempotencyKey,
      });
      expect(replay).toEqual(result);
      expect(
        await service.postAnalysis(principal, { ...analysis, analysisMarkdown: "different" }),
      ).toMatchObject({
        outcome: "IdempotencyConflict",
      });
    } else {
      expect(result).toMatchObject({ outcome: "Applied" });
      expect(replay).toEqual({
        outcome: "DuplicateNoOp",
        originalArtifactId: "artifactId" in result ? result.artifactId : undefined,
      });
    }
    expect(upstream.mutations).toHaveLength(1);
  },
);

// EVIDENCE-OF: R-d31426
test("a definitely failed receipt can be reserved and executed again without sharing another operation's receipt", async () => {
  const upstream = bugzilla();
  const storage = memoryStorage();
  const scope = {
    issuer: principal.issuer,
    principalId: principal.principalId,
    instanceUrl: principal.instanceUrl,
    operation: "bugzilla_post_analysis",
    key: analysis.idempotencyKey,
  };
  await storage.finalizeReceipt(scope, {
    status: "failed",
    intentHash: "failed-intent",
    errorCode: "definite_rejection",
  });
  const service = createWriteGuardService(dependencies(upstream.client, { storage }));
  expect(await service.postAnalysis(principal, analysis)).toMatchObject({ outcome: "Applied" });
  const createInput = {
    idempotencyKey: analysis.idempotencyKey,
    product: "Browser",
    component: "Layout",
    version: "1",
    summary: "New regression",
    description: "Found in the test build",
  };
  const created = await service.createBug(principal, createInput);
  expect(created).toMatchObject({ outcome: "Applied" });
  expect(await service.createBug(principal, { ...createInput })).toEqual({
    outcome: "DuplicateNoOp",
    originalArtifactId: "artifactId" in created ? created.artifactId : undefined,
  });
  expect(
    await service.createBug(principal, { ...createInput, summary: "Another regression" }),
  ).toMatchObject({
    outcome: "IdempotencyConflict",
  });
  expect(upstream.mutations.map(({ kind }) => kind)).toEqual(["private", "create"]);
});

// EVIDENCE-OF: R-68841d
test("an applied receipt never discloses its artifact after upstream target access is lost", async () => {
  let visible = true;
  const upstream = bugzilla({
    async checkVisibility() {
      return visible ? "visible" : "restricted_or_missing";
    },
    async getBugDossierData(id) {
      return visible
        ? { bug: bugSummary(id), recentComments: [], recentHistory: [], attachments: [] }
        : null;
    },
  });
  const service = createWriteGuardService(dependencies(upstream.client));
  const applied = await service.postAnalysis(principal, analysis);
  expect(applied).toMatchObject({ outcome: "Applied" });
  visible = false;
  await expect(service.postAnalysis(principal, analysis)).rejects.toBeDefined();
  expect(upstream.mutations).toHaveLength(1);
});

// EVIDENCE-OF: R-80b183
// EVIDENCE-OF: R-d31426
test.each(["non_insider", "private_rejected"] as const)(
  "Safe-Auto saves only an internal note on %s",
  async (reason) => {
    const upstream = bugzilla();
    const storage = memoryStorage();
    const client: BugzillaClient = {
      ...upstream.client,
      async probeCapabilities() {
        return {
          ...(await upstream.client.probeCapabilities()),
          isInsider: reason !== "non_insider",
        };
      },
      async postPrivateComment() {
        expect(reason).toBe("private_rejected");
        return { kind: "private_rejected" };
      },
    };
    const service = createWriteGuardService(dependencies(client, { storage }));
    const result = await service.postAnalysis(principal, analysis);
    expect(result).toMatchObject({ outcome: "SavedAsInternalNote", bugId, reason });
    expect(
      await storage.listInternalNotes(
        principal.issuer,
        principal.principalId,
        principal.instanceUrl,
        bugId,
      ),
    ).toEqual([
      expect.objectContaining({
        id: "noteId" in result ? result.noteId : undefined,
        text: expect.stringContaining(analysis.analysisMarkdown),
      }),
    ]);
    expect(upstream.mutations).toEqual([]);
  },
);
