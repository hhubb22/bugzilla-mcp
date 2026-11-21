import { DatabaseSync } from "node:sqlite";
import type {
  BugId,
  DraftKind,
  DraftSaveResult,
  EventFilterArgs,
  EventName,
  InternalNote,
  ProposalDiff,
} from "@bugzilla-mcp/contracts";
import type {
  IdempotencyScope,
  SelfWriteProvenance,
  StoragePorts,
  StoredApprovalTicket,
  StoredBindingTicket,
  StoredBoundCredential,
  StoredDraft,
  StoredProposal,
  StoredReceipt,
  StoredWebhookRetryItem,
  StoredWebhookSubscription,
  WriteAuditEntry,
} from "./index.js";

const SCHEMA_SQL = `
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS receipts (
    principal_id TEXT NOT NULL,
    instance_url TEXT NOT NULL,
    operation TEXT NOT NULL,
    idem_key TEXT NOT NULL,
    receipt_json TEXT NOT NULL,
    PRIMARY KEY (principal_id, instance_url, operation, idem_key)
  );

  CREATE TABLE IF NOT EXISTS self_writes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_url TEXT NOT NULL,
    bug_id INTEGER NOT NULL,
    comment_id INTEGER,
    diff_key TEXT
  );

  CREATE TABLE IF NOT EXISTS write_audits (
    audit_id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    instance_url TEXT NOT NULL,
    bug_id INTEGER NOT NULL,
    entry_json TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS causal_budget (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    instance_url TEXT NOT NULL,
    bug_id INTEGER NOT NULL,
    at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS internal_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    principal_id TEXT NOT NULL,
    instance_url TEXT NOT NULL,
    bug_id INTEGER NOT NULL,
    text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS proposals (
    principal_id TEXT NOT NULL,
    instance_url TEXT NOT NULL,
    proposal_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    proposal_json TEXT NOT NULL,
    PRIMARY KEY (principal_id, instance_url, proposal_id, revision)
  );

  CREATE TABLE IF NOT EXISTS drafts (
    principal_id TEXT NOT NULL,
    instance_url TEXT NOT NULL,
    bug_id INTEGER NOT NULL,
    draft_kind TEXT NOT NULL,
    draft_revision INTEGER NOT NULL,
    content TEXT NOT NULL,
    saved_at TEXT NOT NULL,
    PRIMARY KEY (principal_id, instance_url, bug_id, draft_kind)
  );

  CREATE TABLE IF NOT EXISTS webhook_subscriptions (
    principal_id TEXT NOT NULL,
    url TEXT NOT NULL,
    name TEXT NOT NULL,
    canonical_args_json TEXT NOT NULL,
    sub_json TEXT NOT NULL,
    PRIMARY KEY (principal_id, url, name, canonical_args_json)
  );

  CREATE INDEX IF NOT EXISTS idx_self_writes_lookup
    ON self_writes (instance_url, bug_id, comment_id, diff_key);
  CREATE INDEX IF NOT EXISTS idx_write_audits_lookup
    ON write_audits (principal_id, instance_url, bug_id);
  CREATE INDEX IF NOT EXISTS idx_causal_budget_lookup
    ON causal_budget (instance_url, bug_id, at_ms);
  CREATE INDEX IF NOT EXISTS idx_internal_notes_lookup
    ON internal_notes (principal_id, instance_url, bug_id);

  CREATE TABLE IF NOT EXISTS consumed_jtis (
    jti TEXT PRIMARY KEY,
    expires_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS binding_tickets (
    ticket_id TEXT PRIMARY KEY,
    ticket_json TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS consumed_retry_states (
    state_hash TEXT PRIMARY KEY,
    expires_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bound_credentials (
    issuer TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    instance_url TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    iv TEXT NOT NULL,
    auth_tag TEXT NOT NULL,
    credential_generation INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (issuer, principal_id, instance_url)
  );

  CREATE TABLE IF NOT EXISTS approval_tickets (
    ticket_id TEXT PRIMARY KEY,
    ticket_json TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS webhook_retry_queue (
    subscription_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    next_attempt_at_ms INTEGER NOT NULL,
    PRIMARY KEY (subscription_id, event_id)
  );

  CREATE INDEX IF NOT EXISTS idx_webhook_retry_due
    ON webhook_retry_queue (subscription_id, next_attempt_at_ms);
`;

export function openSqliteStorage(dbPath: string): StoragePorts {
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);

  function readReceiptRow(scope: IdempotencyScope): StoredReceipt | null {
    const row = db
      .prepare(
        `SELECT receipt_json FROM receipts
         WHERE principal_id = ? AND instance_url = ? AND operation = ? AND idem_key = ?`,
      )
      .get(scope.principalId, scope.instanceUrl, scope.operation, scope.key) as
      | { receipt_json: string }
      | undefined;
    return row ? (JSON.parse(row.receipt_json) as StoredReceipt) : null;
  }

  return {
    async getReceipt(scope) {
      return readReceiptRow(scope);
    },

    async reservePending(scope, intentHash) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = readReceiptRow(scope);
        if (existing && existing.status !== "failed") {
          db.exec("COMMIT");
          return existing;
        }
        const pending: StoredReceipt = {
          status: "pending",
          intentHash,
          createdAt: new Date().toISOString(),
        };
        db.prepare(
          `INSERT INTO receipts (principal_id, instance_url, operation, idem_key, receipt_json)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (principal_id, instance_url, operation, idem_key)
           DO UPDATE SET receipt_json = excluded.receipt_json`,
        ).run(
          scope.principalId,
          scope.instanceUrl,
          scope.operation,
          scope.key,
          JSON.stringify(pending),
        );
        db.exec("COMMIT");
        return "reserved";
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async finalizeReceipt(scope, receipt) {
      db.prepare(
        `INSERT INTO receipts (principal_id, instance_url, operation, idem_key, receipt_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (principal_id, instance_url, operation, idem_key)
         DO UPDATE SET receipt_json = excluded.receipt_json`,
      ).run(
        scope.principalId,
        scope.instanceUrl,
        scope.operation,
        scope.key,
        JSON.stringify(receipt),
      );
    },

    async recordSelfWrite(entry: SelfWriteProvenance) {
      db.prepare(
        `INSERT INTO self_writes (instance_url, bug_id, comment_id, diff_key) VALUES (?, ?, ?, ?)`,
      ).run(entry.instanceUrl, entry.bugId, entry.commentId ?? null, entry.diffKey ?? null);
    },

    async hasSelfWrite(entry: SelfWriteProvenance) {
      if (entry.commentId !== undefined) {
        const row = db
          .prepare(
            `SELECT 1 FROM self_writes WHERE instance_url = ? AND bug_id = ? AND comment_id = ? LIMIT 1`,
          )
          .get(entry.instanceUrl, entry.bugId, entry.commentId);
        if (row) return true;
      }
      if (entry.diffKey !== undefined) {
        const row = db
          .prepare(
            `SELECT 1 FROM self_writes WHERE instance_url = ? AND bug_id = ? AND diff_key = ? LIMIT 1`,
          )
          .get(entry.instanceUrl, entry.bugId, entry.diffKey);
        if (row) return true;
      }
      return false;
    },

    async recordWriteAudit(entry: WriteAuditEntry) {
      db.prepare(
        `INSERT OR REPLACE INTO write_audits (audit_id, principal_id, instance_url, bug_id, entry_json)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(
        entry.auditId,
        entry.principalId,
        entry.instanceUrl,
        entry.bugId,
        JSON.stringify(entry),
      );
    },

    async listWriteAudits(principalId, instanceUrl, bugId) {
      const rows = db
        .prepare(
          `SELECT entry_json FROM write_audits
           WHERE principal_id = ? AND instance_url = ? AND bug_id = ?`,
        )
        .all(principalId, instanceUrl, bugId) as Array<{ entry_json: string }>;
      return rows.map((row) => JSON.parse(row.entry_json) as WriteAuditEntry);
    },

    async consumeCausalBudget({ instanceUrl, bugId, maxWrites, windowMs, nowMs }) {
      if (maxWrites <= 0) {
        return { allowed: false, retryAfterMs: windowMs };
      }
      const cutoff = nowMs - windowMs;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `DELETE FROM causal_budget WHERE instance_url = ? AND bug_id = ? AND at_ms <= ?`,
        ).run(instanceUrl, bugId, cutoff);
        const rows = db
          .prepare(
            `SELECT at_ms FROM causal_budget WHERE instance_url = ? AND bug_id = ? ORDER BY at_ms ASC`,
          )
          .all(instanceUrl, bugId) as Array<{ at_ms: number }>;
        if (rows.length >= maxWrites) {
          const oldest = rows[0];
          db.exec("COMMIT");
          return {
            allowed: false,
            retryAfterMs: oldest !== undefined ? oldest.at_ms + windowMs - nowMs : windowMs,
          };
        }
        db.prepare(`INSERT INTO causal_budget (instance_url, bug_id, at_ms) VALUES (?, ?, ?)`).run(
          instanceUrl,
          bugId,
          nowMs,
        );
        db.exec("COMMIT");
        return { allowed: true };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async saveInternalNote(principalId, instanceUrl, bugId, text) {
      const createdAt = new Date().toISOString();
      const result = db
        .prepare(
          `INSERT INTO internal_notes (principal_id, instance_url, bug_id, text, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(principalId, instanceUrl, bugId, text, createdAt);
      const note: InternalNote = {
        id: String(result.lastInsertRowid),
        bugId,
        text,
        createdAt,
      };
      return note;
    },

    async listInternalNotes(principalId, instanceUrl, bugId) {
      const rows = db
        .prepare(
          `SELECT id, bug_id, text, created_at FROM internal_notes
           WHERE principal_id = ? AND instance_url = ? AND bug_id = ? ORDER BY id ASC`,
        )
        .all(principalId, instanceUrl, bugId) as Array<{
        id: number;
        bug_id: number;
        text: string;
        created_at: string;
      }>;
      return rows.map((row) => ({
        id: String(row.id),
        bugId: row.bug_id as BugId,
        text: row.text,
        createdAt: row.created_at,
      }));
    },

    async saveProposal(proposal: StoredProposal) {
      db.prepare(
        `INSERT INTO proposals (principal_id, instance_url, proposal_id, revision, proposal_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (principal_id, instance_url, proposal_id, revision)
         DO UPDATE SET proposal_json = excluded.proposal_json`,
      ).run(
        proposal.principalId,
        proposal.instanceUrl,
        proposal.proposalId,
        proposal.revision,
        JSON.stringify(proposal),
      );
    },

    async getProposal(principalId, instanceUrl, proposalId, revision) {
      const row = db
        .prepare(
          `SELECT proposal_json FROM proposals
           WHERE principal_id = ? AND instance_url = ? AND proposal_id = ? AND revision = ?`,
        )
        .get(principalId, instanceUrl, proposalId, revision) as
        | { proposal_json: string }
        | undefined;
      return row
        ? (JSON.parse(row.proposal_json) as StoredProposal & { diff: ProposalDiff })
        : null;
    },

    async saveDraft(params): Promise<DraftSaveResult> {
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db
          .prepare(
            `SELECT draft_revision FROM drafts
             WHERE principal_id = ? AND instance_url = ? AND bug_id = ? AND draft_kind = ?`,
          )
          .get(params.principalId, params.instanceUrl, params.bugId, params.draftKind) as
          | { draft_revision: number }
          | undefined;
        if (existing && existing.draft_revision >= params.draftRevision) {
          db.exec("COMMIT");
          return { status: "stale_revision", currentRevision: existing.draft_revision };
        }
        const savedAt = new Date().toISOString();
        db.prepare(
          `INSERT INTO drafts (principal_id, instance_url, bug_id, draft_kind, draft_revision, content, saved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (principal_id, instance_url, bug_id, draft_kind)
           DO UPDATE SET draft_revision = excluded.draft_revision,
                         content = excluded.content,
                         saved_at = excluded.saved_at`,
        ).run(
          params.principalId,
          params.instanceUrl,
          params.bugId,
          params.draftKind,
          params.draftRevision,
          params.content,
          savedAt,
        );
        db.exec("COMMIT");
        return { status: "acknowledged", draftRevision: params.draftRevision, savedAt };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async getDraft(params): Promise<StoredDraft | null> {
      const row = db
        .prepare(
          `SELECT bug_id, draft_kind, draft_revision, content, saved_at FROM drafts
           WHERE principal_id = ? AND instance_url = ? AND bug_id = ? AND draft_kind = ?`,
        )
        .get(params.principalId, params.instanceUrl, params.bugId, params.draftKind) as
        | {
            bug_id: number;
            draft_kind: DraftKind;
            draft_revision: number;
            content: string;
            saved_at: string;
          }
        | undefined;
      if (!row) return null;
      return {
        bugId: row.bug_id,
        draftKind: row.draft_kind,
        draftRevision: row.draft_revision,
        content: row.content,
        savedAt: row.saved_at,
      };
    },

    async upsertWebhookSubscription(sub: StoredWebhookSubscription) {
      db.prepare(
        `INSERT INTO webhook_subscriptions (principal_id, url, name, canonical_args_json, sub_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (principal_id, url, name, canonical_args_json)
         DO UPDATE SET sub_json = excluded.sub_json`,
      ).run(sub.principalId, sub.url, sub.name, sub.canonicalArgsJson, JSON.stringify(sub));
    },

    async getWebhookSubscription(params) {
      const row = db
        .prepare(
          `SELECT sub_json FROM webhook_subscriptions
           WHERE principal_id = ? AND url = ? AND name = ? AND canonical_args_json = ?`,
        )
        .get(params.principalId, params.url, params.name, params.canonicalArgsJson) as
        | { sub_json: string }
        | undefined;
      return row
        ? (JSON.parse(row.sub_json) as StoredWebhookSubscription & {
            name: EventName;
            args: EventFilterArgs;
          })
        : null;
    },

    async listWebhookSubscriptions(principalId) {
      const rows = (
        principalId !== undefined
          ? db
              .prepare(`SELECT sub_json FROM webhook_subscriptions WHERE principal_id = ?`)
              .all(principalId)
          : db.prepare(`SELECT sub_json FROM webhook_subscriptions`).all()
      ) as Array<{ sub_json: string }>;
      return rows.map((row) => JSON.parse(row.sub_json) as StoredWebhookSubscription);
    },

    async deleteWebhookSubscription(params) {
      const result = db
        .prepare(
          `DELETE FROM webhook_subscriptions
           WHERE principal_id = ? AND url = ? AND name = ? AND canonical_args_json = ?`,
        )
        .run(params.principalId, params.url, params.name, params.canonicalArgsJson);
      return Number(result.changes) > 0;
    },

    async listProposals(principalId, instanceUrl, filter) {
      const rows = db
        .prepare(
          `SELECT proposal_json FROM proposals
           WHERE principal_id = ? AND instance_url = ?`,
        )
        .all(principalId, instanceUrl) as Array<{ proposal_json: string }>;
      const all = rows.map((row) => JSON.parse(row.proposal_json) as StoredProposal);
      return all.filter((p) => {
        if (filter?.bugId !== undefined && p.bugId !== filter.bugId) return false;
        if (filter?.state !== undefined && p.state !== filter.state) return false;
        return true;
      });
    },

    async claimProposalTransition({
      principalId,
      instanceUrl,
      proposalId,
      revision,
      fromState,
      toState,
    }) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare(
            `SELECT proposal_json FROM proposals
             WHERE principal_id = ? AND instance_url = ? AND proposal_id = ? AND revision = ?`,
          )
          .get(principalId, instanceUrl, proposalId, revision) as
          | { proposal_json: string }
          | undefined;
        if (!row) {
          db.exec("COMMIT");
          return false;
        }
        const proposal = JSON.parse(row.proposal_json) as StoredProposal;
        if (proposal.state !== fromState) {
          db.exec("COMMIT");
          return false;
        }
        const nextProposal: StoredProposal = { ...proposal, state: toState };
        db.prepare(
          `UPDATE proposals SET proposal_json = ?
           WHERE principal_id = ? AND instance_url = ? AND proposal_id = ? AND revision = ?`,
        ).run(JSON.stringify(nextProposal), principalId, instanceUrl, proposalId, revision);
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async consumeApprovalJti(jti, expiresAtMs, nowMs = Date.now()) {
      if (nowMs >= expiresAtMs) return false;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`DELETE FROM consumed_jtis WHERE expires_at_ms < ?`).run(nowMs);
        const existing = db.prepare(`SELECT 1 FROM consumed_jtis WHERE jti = ?`).get(jti);
        if (existing) {
          db.exec("COMMIT");
          return false;
        }
        db.prepare(`INSERT INTO consumed_jtis (jti, expires_at_ms) VALUES (?, ?)`).run(
          jti,
          expiresAtMs,
        );
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async saveBindingTicket(ticket: StoredBindingTicket) {
      db.prepare(
        `INSERT INTO binding_tickets (ticket_id, ticket_json, expires_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT (ticket_id)
         DO UPDATE SET ticket_json = excluded.ticket_json, expires_at_ms = excluded.expires_at_ms`,
      ).run(ticket.ticketId, JSON.stringify(ticket), ticket.expiresAtMs);
    },

    async getBindingTicket(ticketId) {
      const row = db
        .prepare(`SELECT ticket_json FROM binding_tickets WHERE ticket_id = ?`)
        .get(ticketId) as { ticket_json: string } | undefined;
      return row ? (JSON.parse(row.ticket_json) as StoredBindingTicket) : null;
    },

    async markBindingTicketCompleted(ticketId, credentialGeneration, nowMs = Date.now()) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare(`SELECT ticket_json FROM binding_tickets WHERE ticket_id = ?`)
          .get(ticketId) as { ticket_json: string } | undefined;
        if (!row) {
          db.exec("COMMIT");
          return false;
        }
        const ticket = JSON.parse(row.ticket_json) as StoredBindingTicket;
        if (ticket.completed || nowMs >= ticket.expiresAtMs) {
          db.exec("COMMIT");
          return false;
        }
        const updated: StoredBindingTicket = {
          ...ticket,
          completed: true,
          credentialGeneration,
        };
        db.prepare(`UPDATE binding_tickets SET ticket_json = ? WHERE ticket_id = ?`).run(
          JSON.stringify(updated),
          ticketId,
        );
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async consumeRetryState(stateHash, expiresAtMs, nowMs = Date.now()) {
      if (nowMs >= expiresAtMs) return false;
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(`DELETE FROM consumed_retry_states WHERE expires_at_ms < ?`).run(nowMs);
        const existing = db
          .prepare(`SELECT 1 FROM consumed_retry_states WHERE state_hash = ?`)
          .get(stateHash);
        if (existing) {
          db.exec("COMMIT");
          return false;
        }
        db.prepare(
          `INSERT INTO consumed_retry_states (state_hash, expires_at_ms) VALUES (?, ?)`,
        ).run(stateHash, expiresAtMs);
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async saveApprovalTicket(ticket: StoredApprovalTicket) {
      db.prepare(
        `INSERT INTO approval_tickets (ticket_id, ticket_json, expires_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT (ticket_id)
         DO UPDATE SET ticket_json = excluded.ticket_json, expires_at_ms = excluded.expires_at_ms`,
      ).run(ticket.ticketId, JSON.stringify(ticket), ticket.expiresAtMs);
    },

    async getApprovalTicket(ticketId) {
      const row = db
        .prepare(`SELECT ticket_json FROM approval_tickets WHERE ticket_id = ?`)
        .get(ticketId) as { ticket_json: string } | undefined;
      return row ? (JSON.parse(row.ticket_json) as StoredApprovalTicket) : null;
    },

    async consumeApprovalTicket(ticketId, nowMs) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = db
          .prepare(`SELECT ticket_json FROM approval_tickets WHERE ticket_id = ?`)
          .get(ticketId) as { ticket_json: string } | undefined;
        if (!row) {
          db.exec("COMMIT");
          return false;
        }
        const ticket = JSON.parse(row.ticket_json) as StoredApprovalTicket;
        if (ticket.consumed || nowMs >= ticket.expiresAtMs) {
          db.exec("COMMIT");
          return false;
        }
        const updated: StoredApprovalTicket = { ...ticket, consumed: true };
        db.prepare(`UPDATE approval_tickets SET ticket_json = ? WHERE ticket_id = ?`).run(
          JSON.stringify(updated),
          ticketId,
        );
        db.exec("COMMIT");
        return true;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async saveBoundCredential(entry) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const existing = db
          .prepare(
            `SELECT credential_generation FROM bound_credentials
             WHERE issuer = ? AND principal_id = ? AND instance_url = ?`,
          )
          .get(entry.issuer, entry.principalId, entry.instanceUrl) as
          | { credential_generation: number }
          | undefined;
        const nextGen = (existing?.credential_generation ?? 0) + 1;
        const updatedAt = new Date().toISOString();
        db.prepare(
          `INSERT INTO bound_credentials
           (issuer, principal_id, instance_url, ciphertext, iv, auth_tag, credential_generation, revoked, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
           ON CONFLICT (issuer, principal_id, instance_url)
           DO UPDATE SET ciphertext = excluded.ciphertext,
                         iv = excluded.iv,
                         auth_tag = excluded.auth_tag,
                         credential_generation = excluded.credential_generation,
                         revoked = 0,
                         updated_at = excluded.updated_at`,
        ).run(
          entry.issuer,
          entry.principalId,
          entry.instanceUrl,
          entry.ciphertext,
          entry.iv,
          entry.authTag,
          nextGen,
          updatedAt,
        );
        db.exec("COMMIT");
        return { credentialGeneration: nextGen };
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async getBoundCredential(issuer, principalId, instanceUrl) {
      const row = db
        .prepare(
          `SELECT issuer, principal_id, instance_url, ciphertext, iv, auth_tag, credential_generation, updated_at
           FROM bound_credentials
           WHERE issuer = ? AND principal_id = ? AND instance_url = ? AND revoked = 0`,
        )
        .get(issuer, principalId, instanceUrl) as
        | {
            issuer: string;
            principal_id: string;
            instance_url: string;
            ciphertext: string;
            iv: string;
            auth_tag: string;
            credential_generation: number;
            updated_at: string;
          }
        | undefined;
      if (!row) return null;
      return {
        issuer: row.issuer,
        principalId: row.principal_id,
        instanceUrl: row.instance_url,
        ciphertext: row.ciphertext,
        iv: row.iv,
        authTag: row.auth_tag,
        credentialGeneration: row.credential_generation,
        updatedAt: row.updated_at,
      } satisfies StoredBoundCredential;
    },

    async revokeBoundCredential(issuer, principalId, instanceUrl) {
      db.exec("BEGIN IMMEDIATE");
      try {
        // Retain monotonic credential_generation tombstone so rebind never reuses prior generation (AUTH-02)
        const result = db
          .prepare(
            `UPDATE bound_credentials
             SET ciphertext = '', iv = '', auth_tag = '', revoked = 1,
                 credential_generation = credential_generation + 1,
                 updated_at = ?
             WHERE issuer = ? AND principal_id = ? AND instance_url = ? AND revoked = 0`,
          )
          .run(new Date().toISOString(), issuer, principalId, instanceUrl);
        db.exec("COMMIT");
        return Number(result.changes) > 0;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    async upsertWebhookRetryItem(item: StoredWebhookRetryItem) {
      db.prepare(
        `INSERT INTO webhook_retry_queue (subscription_id, event_id, payload_json, attempts, next_attempt_at_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (subscription_id, event_id)
         DO UPDATE SET payload_json = excluded.payload_json,
                       attempts = excluded.attempts,
                       next_attempt_at_ms = excluded.next_attempt_at_ms`,
      ).run(
        item.subscriptionId,
        item.eventId,
        item.payloadJson,
        item.attempts,
        item.nextAttemptAtMs,
      );
    },

    async listWebhookRetryItems(subscriptionId) {
      const rows = (
        subscriptionId !== undefined
          ? db
              .prepare(
                `SELECT subscription_id, event_id, payload_json, attempts, next_attempt_at_ms
                 FROM webhook_retry_queue WHERE subscription_id = ? ORDER BY next_attempt_at_ms ASC`,
              )
              .all(subscriptionId)
          : db
              .prepare(
                `SELECT subscription_id, event_id, payload_json, attempts, next_attempt_at_ms
                 FROM webhook_retry_queue ORDER BY next_attempt_at_ms ASC`,
              )
              .all()
      ) as Array<{
        subscription_id: string;
        event_id: string;
        payload_json: string;
        attempts: number;
        next_attempt_at_ms: number;
      }>;
      return rows.map((row) => ({
        subscriptionId: row.subscription_id,
        eventId: row.event_id,
        payloadJson: row.payload_json,
        attempts: row.attempts,
        nextAttemptAtMs: row.next_attempt_at_ms,
      }));
    },

    async deleteWebhookRetryItem(subscriptionId, eventId) {
      db.prepare(`DELETE FROM webhook_retry_queue WHERE subscription_id = ? AND event_id = ?`).run(
        subscriptionId,
        eventId,
      );
    },
  };
}
