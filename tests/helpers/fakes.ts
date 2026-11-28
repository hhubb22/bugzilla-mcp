import { randomUUID } from "node:crypto";
import type {
  BugzillaClient,
  UpstreamBugzillaOccurrence,
} from "../../packages/bugzilla-client/src/index.js";
import type { BugSummary, PrincipalContext } from "../../packages/contracts/src/index.js";
import type { CoreDependencies } from "../../packages/core/src/index.js";
import {
  DEFAULT_RECEIPT_LEASE_MS,
  isValidProposalTransition,
  type IdempotencyScope,
  type SelfWriteProvenance,
  type StoragePorts,
  type StoredApprovalTicket,
  type StoredBindingTicket,
  type StoredBoundCredential,
  type StoredDraft,
  type StoredProposal,
  type StoredReceipt,
  type StoredReceiptApplied,
  type StoredReceiptIndeterminate,
  type StoredReceiptPending,
  type StoredWebhookRetryItem,
  type StoredWebhookSubscription,
  type WriteAuditEntry,
} from "../../packages/storage/src/index.js";

export const origin = "https://client.example";
export const epoch = Date.parse("2026-11-21T00:00:00Z");
export const iso = (ms: number) => new Date(ms).toISOString();
export const principal: PrincipalContext = {
  issuer: "https://identity.example",
  principalId: "alice",
  clientId: "https://client.example/id",
  instanceUrl: "https://bugzilla.example",
  credentialGeneration: 1,
  scopes: ["bz:read", "bz:write:safe", "bz:write:guarded", "bz:events"],
  deploymentMode: "cloud-multi-user",
};

export function manualClock(initial = epoch) {
  let now = initial;
  return { now: () => now, advance: (ms: number) => (now += ms) };
}

const key = (...parts: unknown[]) => JSON.stringify(parts);

export function memoryStorage(now = () => epoch): StoragePorts {
  let nextNote = 1;
  let nextBudgetToken = 1;
  const receipts = new Map<string, StoredReceipt>();
  const proposals = new Map<string, StoredProposal>();
  const drafts = new Map<string, StoredDraft>();
  const budgets = new Map<string, Array<{ id: number; at: number }>>();
  const subscriptions = new Map<string, StoredWebhookSubscription>();
  const selfWrites: Array<{
    issuer: string;
    principalId: string;
    instanceUrl: string;
    bugId: number;
    artifactKey: string;
  }> = [];
  const audits: WriteAuditEntry[] = [];
  const notes = new Map<string, Awaited<ReturnType<StoragePorts["listInternalNotes"]>>>();
  const consumedJtis = new Map<string, number>();
  const bindingTickets = new Map<string, StoredBindingTicket>();
  const retryStates = new Map<string, number>();
  const approvalTickets = new Map<string, StoredApprovalTicket>();
  const boundCredentials = new Map<string, StoredBoundCredential & { revoked: boolean }>();
  const webhookRetryItems = new Map<string, StoredWebhookRetryItem>();

  const receiptKey = (scope: IdempotencyScope) =>
    key(scope.issuer, scope.principalId, scope.instanceUrl, scope.operation, scope.key);
  const proposalKey = (
    issuer: string,
    principalId: string,
    instanceUrl: string,
    proposalId: string,
    revision: number,
  ) => key(issuer, principalId, instanceUrl, proposalId, revision);
  const draftKey = (scope: Parameters<StoragePorts["getDraft"]>[0]) =>
    key(scope.issuer, scope.principalId, scope.instanceUrl, scope.bugId, scope.draftKind);
  const subscriptionKey = (scope: Parameters<StoragePorts["getWebhookSubscription"]>[0]) =>
    key(
      scope.issuer,
      scope.principalId,
      scope.instanceUrl,
      scope.url,
      scope.name,
      scope.canonicalArgsJson,
    );
  const credentialKey = (issuer: string, principalId: string, instanceUrl: string) =>
    key(issuer, principalId, instanceUrl);

  function insertSelfWrites(entry: SelfWriteProvenance): void {
    if (!entry.issuer || !entry.principalId) return;
    for (const artifactKey of [
      entry.commentId === undefined ? undefined : `comment:${entry.commentId}`,
      entry.diffKey,
    ]) {
      if (artifactKey !== undefined) {
        selfWrites.push({
          issuer: entry.issuer,
          principalId: entry.principalId,
          instanceUrl: entry.instanceUrl,
          bugId: entry.bugId,
          artifactKey,
        });
      }
    }
  }

  function insertAudit(entry: WriteAuditEntry): void {
    const exists = audits.some(
      (existing) =>
        existing.issuer === entry.issuer &&
        existing.principalId === entry.principalId &&
        existing.instanceUrl === entry.instanceUrl &&
        existing.auditId === entry.auditId,
    );
    if (!exists) {
      audits.push(structuredClone(entry));
    }
  }

  function transitionProposalCasSync(params: {
    readonly issuer: string;
    readonly principalId: string;
    readonly instanceUrl: string;
    readonly proposalId: string;
    readonly revision: number;
    readonly fromStates: readonly StoredProposal["state"][];
    readonly toState: StoredProposal["state"];
  }): boolean {
    if (params.fromStates.length === 0) return false;
    const pKey = proposalKey(
      params.issuer,
      params.principalId,
      params.instanceUrl,
      params.proposalId,
      params.revision,
    );
    const current = proposals.get(pKey);
    if (!current) return false;
    if (!params.fromStates.includes(current.state)) return false;
    if (!isValidProposalTransition(current.state, params.toState)) return false;
    proposals.set(pKey, structuredClone({ ...current, state: params.toState }));
    return true;
  }

  return {
    durableWebhooks: false,
    async listWebhookGrants() {
      const grants: PrincipalContext[] = [];
      const seen = new Set<string>();
      for (const sub of subscriptions.values()) {
        if (!sub.verified || sub.revoked || !sub.grant) continue;
        const g = sub.grant;
        const gKey = key(
          g.issuer,
          g.principalId,
          g.instanceUrl,
          g.clientId,
          g.credentialGeneration,
          g.deploymentMode,
          [...g.scopes].sort(),
        );
        if (!seen.has(gKey)) {
          seen.add(gKey);
          grants.push(structuredClone(g));
        }
      }
      return grants;
    },
    async getReceipt(scope) {
      return structuredClone(receipts.get(receiptKey(scope)) ?? null);
    },
    async reservePending(scope, intentHash, opts) {
      const nowMs = opts?.nowMs ?? now();
      const leaseMs = opts?.leaseMs ?? DEFAULT_RECEIPT_LEASE_MS;
      const rKey = receiptKey(scope);
      const existing = receipts.get(rKey);
      if (existing) {
        if (existing.status === "pending") {
          if (nowMs >= existing.leaseExpiresAtMs) {
            if (existing.dispatchAttempted) {
              const indeterminateReceipt: StoredReceiptIndeterminate = {
                status: "indeterminate",
                intentHash: existing.intentHash,
                recordedAt: iso(nowMs),
              };
              receipts.set(rKey, indeterminateReceipt);
              return { kind: "existing", receipt: structuredClone(indeterminateReceipt) };
            }
            // Expired pre-dispatch lease: reclaim with a fresh leaseToken.
          } else {
            return { kind: "existing", receipt: structuredClone(existing) };
          }
        } else if (existing.status !== "failed") {
          return { kind: "existing", receipt: structuredClone(existing) };
        }
      }
      const leaseToken = randomUUID();
      const pending: StoredReceiptPending = {
        status: "pending",
        intentHash,
        createdAt: iso(nowMs),
        leaseToken,
        leaseExpiresAtMs: nowMs + leaseMs,
        dispatchAttempted: false,
      };
      receipts.set(rKey, pending);
      return { kind: "reserved", leaseToken };
    },
    async markDispatchStarted(scope, leaseToken, opts) {
      const rKey = receiptKey(scope);
      const existing = receipts.get(rKey);
      if (!existing || existing.status !== "pending") return false;
      if (existing.leaseToken !== leaseToken || existing.dispatchAttempted) return false;
      if (opts?.nowMs !== undefined && opts.nowMs >= existing.leaseExpiresAtMs) return false;
      receipts.set(rKey, { ...existing, dispatchAttempted: true });
      return true;
    },
    async finalizeReceipt(scope, receipt, opts) {
      const rKey = receiptKey(scope);
      const existing = receipts.get(rKey);
      if (existing?.status === "applied" && receipt.status !== "applied") {
        return false;
      }
      if (opts?.expectedLeaseToken !== undefined) {
        if (
          !existing ||
          existing.status !== "pending" ||
          existing.leaseToken !== opts.expectedLeaseToken
        ) {
          return false;
        }
        receipts.set(rKey, structuredClone(receipt));
        return true;
      }
      if (
        existing?.status === "indeterminate" &&
        (receipt.status === "pending" || receipt.status === "failed")
      ) {
        return false;
      }
      receipts.set(rKey, structuredClone(receipt));
      return true;
    },
    async commitAppliedMutation(params) {
      const rKey = receiptKey(params.scope);
      const existing = receipts.get(rKey);
      if (!existing || existing.status !== "pending" || existing.leaseToken !== params.leaseToken) {
        return { committed: false, reason: "lease_fenced" };
      }

      let nextProposal: { pKey: string; value: StoredProposal } | null = null;
      if (params.proposal) {
        const pIssuer = params.proposal.issuer ?? params.scope.issuer;
        const pPrincipalId = params.proposal.principalId ?? params.scope.principalId;
        const pInstanceUrl = params.proposal.instanceUrl ?? params.scope.instanceUrl;
        const pKey = proposalKey(
          pIssuer,
          pPrincipalId,
          pInstanceUrl,
          params.proposal.proposalId,
          params.proposal.revision,
        );
        const currentProposal = proposals.get(pKey);
        const allowedFrom = params.proposal.fromStates ?? ["executing"];
        if (
          !currentProposal ||
          !allowedFrom.includes(currentProposal.state) ||
          !isValidProposalTransition(currentProposal.state, "applied")
        ) {
          return { committed: false, reason: "proposal_conflict" };
        }
        nextProposal = { pKey, value: structuredClone({ ...currentProposal, state: "applied" }) };
      }

      const appliedReceipt: StoredReceiptApplied = {
        status: "applied",
        intentHash: params.intentHash,
        artifactId: params.artifactId,
      };
      receipts.set(rKey, appliedReceipt);
      if (nextProposal) {
        proposals.set(nextProposal.pKey, nextProposal.value);
      }
      if (params.writeAudit) {
        insertAudit(params.writeAudit);
      }
      if (params.selfWrite) {
        insertSelfWrites(params.selfWrite);
      }
      return { committed: true };
    },
    async recordSelfWrite(entry) {
      insertSelfWrites(entry);
    },
    async hasSelfWrite(entry) {
      if (!entry.issuer || !entry.principalId) return false;
      const artifactKey =
        entry.commentId === undefined ? entry.diffKey : `comment:${entry.commentId}`;
      if (!artifactKey) return false;
      let count = 0;
      for (const write of selfWrites) {
        if (
          write.issuer === entry.issuer &&
          write.principalId === entry.principalId &&
          write.instanceUrl === entry.instanceUrl &&
          write.bugId === entry.bugId &&
          write.artifactKey === artifactKey
        ) {
          count += 1;
          if (count >= 2) break;
        }
      }
      return artifactKey.startsWith("history:") ? count === 1 : count > 0;
    },
    async recordWriteAudit(entry) {
      insertAudit(entry);
    },
    async listWriteAudits(issuer, principalId, instanceUrl, bugId) {
      return structuredClone(
        audits.filter(
          (entry) =>
            entry.issuer === issuer &&
            entry.principalId === principalId &&
            entry.instanceUrl === instanceUrl &&
            entry.bugId === bugId,
        ),
      );
    },
    async consumeCausalBudget({
      issuer,
      principalId,
      instanceUrl,
      bugId,
      maxWrites,
      windowMs,
      nowMs,
    }) {
      if (maxWrites <= 0) {
        return { allowed: false, retryAfterMs: windowMs };
      }
      const scope = key(issuer, principalId, instanceUrl, bugId);
      const active = (budgets.get(scope) ?? []).filter((item) => item.at > nowMs - windowMs);
      const oldest = active[0];
      if (oldest !== undefined && active.length >= maxWrites) {
        budgets.set(scope, active);
        return { allowed: false, retryAfterMs: Math.max(1, oldest.at + windowMs - nowMs) };
      }
      const tokenId = nextBudgetToken++;
      budgets.set(scope, [...active, { id: tokenId, at: nowMs }]);
      return { allowed: true, tokenId };
    },
    async refundCausalBudget({ issuer, principalId, instanceUrl, bugId, tokenId }) {
      const scope = key(issuer, principalId, instanceUrl, bugId);
      const current = budgets.get(scope);
      if (!current) return;
      budgets.set(
        scope,
        current.filter((item) => item.id !== tokenId),
      );
    },
    async saveInternalNote(issuer, principalId, instanceUrl, bugId, text) {
      const scope = key(issuer, principalId, instanceUrl, bugId);
      const note = { id: String(nextNote++), bugId, text, createdAt: iso(now()) };
      notes.set(scope, [...(notes.get(scope) ?? []), note]);
      return structuredClone(note);
    },
    async listInternalNotes(issuer, principalId, instanceUrl, bugId) {
      return structuredClone(notes.get(key(issuer, principalId, instanceUrl, bugId)) ?? []);
    },
    async saveProposal(proposal) {
      const pKey = proposalKey(
        proposal.issuer,
        proposal.principalId,
        proposal.instanceUrl,
        proposal.proposalId,
        proposal.revision,
      );
      const existing = proposals.get(pKey);
      if (
        existing &&
        existing.state !== proposal.state &&
        !isValidProposalTransition(existing.state, proposal.state)
      ) {
        return;
      }
      proposals.set(pKey, structuredClone(proposal));
    },
    async getProposal(issuer, principalId, instanceUrl, proposalId, revision) {
      return structuredClone(
        proposals.get(proposalKey(issuer, principalId, instanceUrl, proposalId, revision)) ?? null,
      );
    },
    async listProposals(issuer, principalId, instanceUrl, filter) {
      return structuredClone(
        [...proposals.values()].filter(
          (p) =>
            p.issuer === issuer &&
            p.principalId === principalId &&
            p.instanceUrl === instanceUrl &&
            (filter?.bugId === undefined || p.bugId === filter.bugId) &&
            (filter?.state === undefined || p.state === filter.state),
        ),
      );
    },
    async transitionProposalCas(params) {
      return transitionProposalCasSync(params);
    },
    async claimProposalTransition(params) {
      return transitionProposalCasSync({
        issuer: params.issuer,
        principalId: params.principalId,
        instanceUrl: params.instanceUrl,
        proposalId: params.proposalId,
        revision: params.revision,
        fromStates: [params.fromState],
        toState: params.toState,
      });
    },
    async saveDraft(input) {
      const current = drafts.get(draftKey(input));
      if (current && current.draftRevision >= input.draftRevision) {
        return { status: "stale_revision", currentRevision: current.draftRevision };
      }
      const { bugId, draftKind, draftRevision, content } = input;
      const savedAt = iso(now());
      drafts.set(draftKey(input), { bugId, draftKind, draftRevision, content, savedAt });
      return { status: "acknowledged", draftRevision, savedAt };
    },
    async getDraft(input) {
      return structuredClone(drafts.get(draftKey(input)) ?? null);
    },
    async upsertWebhookSubscription(sub) {
      subscriptions.set(subscriptionKey(sub), structuredClone(sub));
    },
    async getWebhookSubscription(input) {
      return structuredClone(subscriptions.get(subscriptionKey(input)) ?? null);
    },
    async listWebhookSubscriptions(scope) {
      return structuredClone(
        [...subscriptions.values()].filter(
          (sub) =>
            sub.issuer === scope.issuer &&
            sub.principalId === scope.principalId &&
            sub.instanceUrl === scope.instanceUrl,
        ),
      );
    },
    async deleteWebhookSubscription(input) {
      return subscriptions.delete(subscriptionKey(input));
    },
    async consumeApprovalJti(jti, expiresAtMs, nowMs = now()) {
      if (nowMs >= expiresAtMs) return false;
      for (const [k, exp] of consumedJtis.entries()) {
        if (exp < nowMs) consumedJtis.delete(k);
      }
      if (consumedJtis.has(jti)) return false;
      consumedJtis.set(jti, expiresAtMs);
      return true;
    },
    async saveBindingTicket(ticket) {
      bindingTickets.set(ticket.ticketId, structuredClone(ticket));
    },
    async getBindingTicket(ticketId) {
      return structuredClone(bindingTickets.get(ticketId) ?? null);
    },
    async markBindingTicketCompleted(ticketId, credentialGeneration, nowMs = now()) {
      const ticket = bindingTickets.get(ticketId);
      if (!ticket || ticket.completed || nowMs >= ticket.expiresAtMs) return false;
      bindingTickets.set(
        ticketId,
        structuredClone({ ...ticket, completed: true, credentialGeneration }),
      );
      return true;
    },
    async consumeRetryState(stateHash, expiresAtMs, nowMs = now()) {
      if (nowMs >= expiresAtMs) return false;
      for (const [k, exp] of retryStates.entries()) {
        if (exp < nowMs) retryStates.delete(k);
      }
      if (retryStates.has(stateHash)) return false;
      retryStates.set(stateHash, expiresAtMs);
      return true;
    },
    async saveApprovalTicket(ticket) {
      approvalTickets.set(ticket.ticketId, structuredClone(ticket));
    },
    async getApprovalTicket(ticketId) {
      return structuredClone(approvalTickets.get(ticketId) ?? null);
    },
    async consumeApprovalTicket(ticketId, nowMs) {
      const ticket = approvalTickets.get(ticketId);
      if (!ticket || ticket.consumed || nowMs >= ticket.expiresAtMs) return false;
      approvalTickets.set(ticketId, structuredClone({ ...ticket, consumed: true }));
      return true;
    },
    async saveBoundCredential(entry) {
      const cKey = credentialKey(entry.issuer, entry.principalId, entry.instanceUrl);
      const existing = boundCredentials.get(cKey);
      const nextGen = (existing?.credentialGeneration ?? 0) + 1;
      boundCredentials.set(cKey, {
        ...structuredClone(entry),
        credentialGeneration: nextGen,
        updatedAt: iso(now()),
        revoked: false,
      });
      return { credentialGeneration: nextGen };
    },
    async getBoundCredential(issuer, principalId, instanceUrl) {
      const existing = boundCredentials.get(credentialKey(issuer, principalId, instanceUrl));
      if (!existing || existing.revoked) return null;
      const { revoked: _revoked, ...rest } = existing;
      return structuredClone(rest);
    },
    async revokeBoundCredential(issuer, principalId, instanceUrl) {
      const cKey = credentialKey(issuer, principalId, instanceUrl);
      const existing = boundCredentials.get(cKey);
      if (!existing || existing.revoked) return false;
      boundCredentials.set(cKey, {
        ...existing,
        ciphertext: "",
        iv: "",
        authTag: "",
        credentialGeneration: existing.credentialGeneration + 1,
        updatedAt: iso(now()),
        revoked: true,
      });
      return true;
    },
    async upsertWebhookRetryItem(item) {
      webhookRetryItems.set(key(item.subscriptionId, item.eventId), structuredClone(item));
    },
    async listWebhookRetryItems(subscriptionId) {
      const items = [...webhookRetryItems.values()].filter(
        (item) => subscriptionId === undefined || item.subscriptionId === subscriptionId,
      );
      items.sort((a, b) => a.nextAttemptAtMs - b.nextAttemptAtMs);
      return structuredClone(items);
    },
    async deleteWebhookRetryItem(subscriptionId, eventId) {
      webhookRetryItems.delete(key(subscriptionId, eventId));
    },
  };
}

export function bugSummary(
  id = 41,
  summary = "Visible regression",
  lastChangeTime = iso(epoch),
): BugSummary {
  return {
    id,
    summary,
    lastChangeTime,
    product: "Browser",
    component: "Layout",
    status: "NEW",
    resolution: "",
    priority: "P2",
    severity: "normal",
    assignedTo: "alice@example.test",
    pendingProposalCount: 0,
  };
}

export function bugzilla(overrides: Partial<BugzillaClient> = {}) {
  const mutations: Array<
    | { kind: "private"; bugId: number; text: string; commentId: number }
    | { kind: "public"; bugId: number; text: string; commentId: number }
    | { kind: "update"; bugId: number; diff: Parameters<BugzillaClient["applyBugUpdate"]>[1] }
    | { kind: "create"; bugId: number }
  > = [];
  const client: BugzillaClient = {
    async probeCapabilities() {
      return {
        version: "5.2",
        supportsHeaderAuth: true,
        authMode: "header",
        authenticatedUser: "alice@example.test",
        isInsider: true,
      };
    },
    async searchBugs() {
      return { items: [bugSummary()], hasMore: false };
    },
    async getBugDossierData(id) {
      return { bug: bugSummary(id), recentComments: [], recentHistory: [], attachments: [] };
    },
    async listAttachments() {
      return [];
    },
    async postPrivateComment(bugId, text) {
      const commentId = 100 + mutations.length;
      mutations.push({ kind: "private", bugId, text, commentId });
      return { kind: "created", commentId };
    },
    async postPublicComment(bugId, text) {
      const commentId = 300 + mutations.length;
      mutations.push({ kind: "public", bugId, text, commentId });
      return { commentId, updatedLastChangeTime: iso(epoch + 1000) };
    },
    async applyBugUpdate(bugId, diff) {
      mutations.push({ kind: "update", bugId, diff });
      return { updatedLastChangeTime: iso(epoch + 1000) };
    },
    async createBug() {
      const bugId = 200 + mutations.length;
      mutations.push({ kind: "create", bugId });
      return { bugId };
    },
    async listChangesSince() {
      return { occurrences: [], scanComplete: true };
    },
    async checkVisibility() {
      return "visible";
    },
    async listEnterableProducts() {
      return [{ id: 1, name: "Browser", isActive: true }];
    },
    async getProductMetadata(productName) {
      return {
        id: 1,
        name: productName,
        isActive: true,
        components: [{ id: 1, name: "Layout", isActive: true }],
        versions: [
          { id: 1, name: "1", isActive: true },
          { id: 2, name: "1.0", isActive: true },
        ],
      };
    },
    async getBugFields() {
      return [];
    },
    ...overrides,
  };
  return { client, mutations };
}

export function dependencies(
  client: BugzillaClient,
  overrides: Partial<CoreDependencies> = {},
): CoreDependencies {
  return {
    storage: memoryStorage(),
    resolveClient: async () => client,
    eventsProfile: "sep-3415",
    causalBudgetPerBug: 100,
    lagWindowMs: 2000,
    clock: () => epoch,
    ...overrides,
  };
}

export function comment(
  commentId: number,
  timestamp: string,
  overrides: Partial<UpstreamBugzillaOccurrence> = {},
): UpstreamBugzillaOccurrence {
  return {
    kind: "bugzilla.bug.commented",
    bugId: 41,
    commentId,
    changeKey: `comment-${commentId}`,
    timestamp,
    product: "Browser",
    component: "Layout",
    actor: "human@example.test",
    commentText: `comment text ${commentId}`,
    ...overrides,
  };
}

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
