import type {
  BugzillaClient,
  UpstreamBugzillaOccurrence,
} from "../../packages/bugzilla-client/src/index.js";
import type { BugSummary, PrincipalContext } from "../../packages/contracts/src/index.js";
import type { CoreDependencies } from "../../packages/core/src/index.js";
import type {
  IdempotencyScope,
  SelfWriteProvenance,
  StoragePorts,
  StoredDraft,
  StoredProposal,
  StoredReceipt,
  StoredWebhookSubscription,
  WriteAuditEntry,
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
  const receipts = new Map<string, StoredReceipt>();
  const proposals = new Map<string, StoredProposal>();
  const drafts = new Map<string, StoredDraft>();
  const budgets = new Map<string, number[]>();
  const subscriptions = new Map<string, StoredWebhookSubscription>();
  const writes: SelfWriteProvenance[] = [];
  const audits: WriteAuditEntry[] = [];
  const notes = new Map<string, Awaited<ReturnType<StoragePorts["listInternalNotes"]>>>();
  const receiptKey = (scope: IdempotencyScope) =>
    key(scope.principalId, scope.instanceUrl, scope.operation, scope.key);
  const draftKey = (scope: Parameters<StoragePorts["getDraft"]>[0]) =>
    key(scope.principalId, scope.instanceUrl, scope.bugId, scope.draftKind);
  const subscriptionKey = (scope: Parameters<StoragePorts["getWebhookSubscription"]>[0]) =>
    key(scope.principalId, scope.url, scope.name, scope.canonicalArgsJson);

  return {
    async getReceipt(scope) {
      return structuredClone(receipts.get(receiptKey(scope)) ?? null);
    },
    async reservePending(scope, intentHash) {
      const existing = receipts.get(receiptKey(scope));
      if (existing && existing.status !== "failed") return structuredClone(existing);
      receipts.set(receiptKey(scope), { status: "pending", intentHash, createdAt: iso(now()) });
      return "reserved";
    },
    async finalizeReceipt(scope, receipt) {
      receipts.set(receiptKey(scope), structuredClone(receipt));
    },
    async recordSelfWrite(entry) {
      writes.push(structuredClone(entry));
    },
    async hasSelfWrite(entry) {
      return writes.some(
        (write) =>
          write.instanceUrl === entry.instanceUrl &&
          write.bugId === entry.bugId &&
          ((entry.commentId !== undefined && write.commentId === entry.commentId) ||
            (entry.diffKey !== undefined && write.diffKey === entry.diffKey)),
      );
    },
    async recordWriteAudit(entry) {
      audits.push(structuredClone(entry));
    },
    async listWriteAudits(principalId, instanceUrl, bugId) {
      return structuredClone(
        audits.filter(
          (entry) =>
            entry.principalId === principalId &&
            entry.instanceUrl === instanceUrl &&
            entry.bugId === bugId,
        ),
      );
    },
    async consumeCausalBudget({ instanceUrl, bugId, maxWrites, windowMs, nowMs }) {
      const scope = key(instanceUrl, bugId);
      const active = (budgets.get(scope) ?? []).filter((at) => at > nowMs - windowMs);
      const oldest = active[0];
      if (oldest !== undefined && active.length >= maxWrites) {
        return { allowed: false, retryAfterMs: oldest + windowMs - nowMs };
      }
      budgets.set(scope, [...active, nowMs]);
      return { allowed: true };
    },
    async saveInternalNote(principalId, instanceUrl, bugId, text) {
      const scope = key(principalId, instanceUrl, bugId);
      const note = { id: String(nextNote++), bugId, text, createdAt: iso(now()) };
      notes.set(scope, [...(notes.get(scope) ?? []), note]);
      return structuredClone(note);
    },
    async listInternalNotes(principalId, instanceUrl, bugId) {
      return structuredClone(notes.get(key(principalId, instanceUrl, bugId)) ?? []);
    },
    async saveProposal(proposal) {
      const { principalId, instanceUrl, proposalId, revision } = proposal;
      proposals.set(key(principalId, instanceUrl, proposalId, revision), structuredClone(proposal));
    },
    async getProposal(principalId, instanceUrl, proposalId, revision) {
      return structuredClone(
        proposals.get(key(principalId, instanceUrl, proposalId, revision)) ?? null,
      );
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
    async listWebhookSubscriptions(principalId) {
      return structuredClone(
        [...subscriptions.values()].filter(
          (sub) => principalId === undefined || sub.principalId === principalId,
        ),
      );
    },
    async deleteWebhookSubscription(input) {
      return subscriptions.delete(subscriptionKey(input));
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
    | { kind: "update"; bugId: number; diff: Parameters<BugzillaClient["applyBugUpdate"]>[1] }
    | { kind: "create"; bugId: number }
  > = [];
  const client: BugzillaClient = {
    async probeCapabilities() {
      return {
        version: "5.2",
        supportsHeaderAuth: true,
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
