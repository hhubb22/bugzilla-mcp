import type {
  AttachmentMeta,
  BugDossier,
  BugId,
  BugSummary,
  BugzillaCreateBugInput,
  IsoTimestamp,
  ProposalDiff,
} from "@bugzilla-mcp/contracts";
import type {
  BugzillaClient,
  BugzillaClientConfig,
  BugzillaInstanceCapabilities,
  UpstreamBugzillaOccurrence,
} from "./index.js";

interface RawBug {
  id: number;
  summary: string;
  product: string;
  component: string;
  status: string;
  resolution?: string;
  priority: string;
  severity: string;
  assigned_to: string;
  last_change_time: string;
}

interface RawComment {
  id: number;
  creator: string;
  time: string;
  is_private?: boolean;
  text: string;
}

interface RawHistoryEntry {
  when: string;
  who: string;
  changes: Array<{ field_name: string; removed: string; added: string }>;
}

interface RawAttachment {
  id: number;
  file_name: string;
  content_type: string;
  size: number;
  is_obsolete?: number | boolean;
  is_private?: number | boolean;
  creator: string;
  creation_time: string;
}

function toBugSummary(raw: RawBug): BugSummary {
  return {
    id: raw.id,
    summary: raw.summary,
    product: raw.product,
    component: raw.component,
    status: raw.status,
    resolution: raw.resolution ?? "",
    priority: raw.priority,
    severity: raw.severity,
    assignedTo: raw.assigned_to,
    lastChangeTime: raw.last_change_time,
    pendingProposalCount: 0,
  };
}

export function createRestBugzillaClient(config: BugzillaClientConfig): BugzillaClient {
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  async function requestJson<T>(
    path: string,
    init: { method?: "GET" | "POST" | "PUT"; query?: Record<string, string>; body?: unknown } = {},
  ): Promise<{ status: number; data: T | null }> {
    const url = new URL(`${baseUrl}/rest${path}`);
    if (init.query) {
      for (const [k, v] of Object.entries(init.query)) {
        url.searchParams.set(k, v);
      }
    }
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-BUGZILLA-API-KEY": config.apiKey,
    };
    let serializedBody: string | undefined;
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      serializedBody = JSON.stringify(init.body);
    }
    const response = await fetch(url.toString(), {
      method: init.method ?? "GET",
      headers,
      redirect: "error",
      ...(serializedBody !== undefined ? { body: serializedBody } : {}),
    });
    const text = await response.text();
    let parsed: T | null = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as T;
      } catch {
        parsed = null;
      }
    }
    return { status: response.status, data: parsed };
  }

  return {
    async probeCapabilities(): Promise<BugzillaInstanceCapabilities> {
      const versionResp = await requestJson<{ version?: string }>("/version");
      const version = versionResp.data?.version ?? "unknown";
      const whoamiResp = await requestJson<{ name?: string; groups?: Array<{ name: string }> }>(
        "/whoami",
      );
      if (whoamiResp.status === 200 && whoamiResp.data?.name) {
        const isInsider = (whoamiResp.data.groups ?? []).some(
          (group) => group.name === "insidergroup",
        );
        return {
          version,
          supportsHeaderAuth: true,
          authenticatedUser: whoamiResp.data.name,
          isInsider,
        };
      }
      throw new Error(
        `Bugzilla API key authentication probe failed with status ${whoamiResp.status}`,
      );
    },

    async searchBugs(params) {
      const query: Record<string, string> = {
        include_fields:
          "id,summary,product,component,status,resolution,priority,severity,assigned_to,last_change_time",
        limit: String(params.limit + 1),
        offset: String(params.offset),
      };
      if (params.product) query.product = params.product;
      if (params.component) query.component = params.component;
      if (params.assignedTo) query.assigned_to = params.assignedTo;
      if (params.updatedSince) query.last_change_time = params.updatedSince;
      if (params.query) query.summary = params.query;
      const resp = await requestJson<{ bugs?: RawBug[] }>("/bug", { query });
      if (resp.status >= 400 || !resp.data) {
        throw new Error(`Bugzilla search failed (${resp.status})`);
      }
      const bugs = resp.data.bugs ?? [];
      return {
        items: bugs.slice(0, params.limit).map(toBugSummary),
        hasMore: bugs.length > params.limit,
      };
    },

    async getBugDossierData(
      bugId: BugId,
      opts: { maxComments: number; maxHistory: number },
    ): Promise<Omit<BugDossier, "internalNotes"> | null> {
      const bugResp = await requestJson<{ bugs?: RawBug[] }>(`/bug/${bugId}`);
      if (bugResp.status === 401 || bugResp.status === 403 || bugResp.status === 404) {
        return null;
      }
      const rawBug = bugResp.data?.bugs?.[0];
      if (!rawBug) return null;

      const [commentsResp, historyResp, attachments] = await Promise.all([
        requestJson<{ bugs?: Record<string, { comments?: RawComment[] }> }>(
          `/bug/${bugId}/comment`,
        ),
        requestJson<{ bugs?: Array<{ history?: RawHistoryEntry[] }> }>(`/bug/${bugId}/history`),
        this.listAttachments(bugId),
      ]);

      const rawComments = commentsResp.data?.bugs?.[String(bugId)]?.comments ?? [];
      const rawHistory = historyResp.data?.bugs?.[0]?.history ?? [];

      return {
        bug: toBugSummary(rawBug),
        recentComments: rawComments.slice(-opts.maxComments).map((c) => ({
          id: c.id,
          creator: c.creator,
          time: c.time,
          isPrivate: Boolean(c.is_private),
          text: c.text,
          untrustedUserContent: true,
        })),
        recentHistory: rawHistory.slice(-opts.maxHistory).map((entry) => ({
          when: entry.when,
          who: entry.who,
          changes: entry.changes.map((ch) => ({
            fieldName: ch.field_name,
            removed: ch.removed,
            added: ch.added,
          })),
        })),
        attachments,
      };
    },

    async listAttachments(bugId: BugId): Promise<AttachmentMeta[]> {
      const resp = await requestJson<{ bugs?: Record<string, RawAttachment[]> }>(
        `/bug/${bugId}/attachment`,
        { query: { exclude_fields: "data" } },
      );
      if (resp.status >= 400) return [];
      const list = resp.data?.bugs?.[String(bugId)] ?? [];
      return list.map((att) => ({
        id: att.id,
        fileName: att.file_name,
        contentType: att.content_type,
        sizeBytes: att.size,
        isObsolete: Boolean(att.is_obsolete),
        isPrivate: Boolean(att.is_private),
        creator: att.creator,
        creationTime: att.creation_time,
      }));
    },

    async postPrivateComment(bugId: BugId, text: string) {
      const resp = await requestJson<{ id?: number; code?: number; message?: string }>(
        `/bug/${bugId}/comment`,
        {
          method: "POST",
          body: { comment: text, is_private: true },
        },
      );
      if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
        return { kind: "private_rejected" as const };
      }
      if (resp.status >= 400 || resp.data?.id === undefined) {
        throw new Error(`Bugzilla private comment failed (${resp.status})`);
      }
      return { kind: "created" as const, commentId: resp.data.id };
    },

    async applyBugUpdate(bugId: BugId, diff: ProposalDiff) {
      const body: Record<string, unknown> = {};
      if (diff.status !== undefined) body.status = diff.status;
      if (diff.resolution !== undefined) body.resolution = diff.resolution;
      if (diff.assignedTo !== undefined) body.assigned_to = diff.assignedTo;
      if (diff.priority !== undefined) body.priority = diff.priority;
      if (diff.severity !== undefined) body.severity = diff.severity;
      if (diff.publicComment !== undefined) {
        body.comment = { body: diff.publicComment, is_private: false };
      }
      if (diff.flags !== undefined) body.flags = diff.flags;
      const resp = await requestJson<{
        bugs?: Array<{ last_change_time?: IsoTimestamp }>;
      }>(`/bug/${bugId}`, { method: "PUT", body });
      if (resp.status >= 400) {
        throw new Error(`Bugzilla update failed (${resp.status})`);
      }
      const updatedLastChangeTime =
        resp.data?.bugs?.[0]?.last_change_time ?? new Date().toISOString();
      return { updatedLastChangeTime };
    },

    async createBug(input: Omit<BugzillaCreateBugInput, "idempotencyKey">) {
      const resp = await requestJson<{ id?: number }>("/bug", {
        method: "POST",
        body: {
          product: input.product,
          component: input.component,
          version: input.version,
          summary: input.summary,
          description: input.description,
          severity: input.severity,
          priority: input.priority,
          ...input.customFields,
        },
      });
      if (resp.status >= 400 || resp.data?.id === undefined) {
        throw new Error(`Bugzilla create bug failed (${resp.status})`);
      }
      return { bugId: resp.data.id };
    },

    async listChangesSince(params) {
      const search = await this.searchBugs({
        updatedSince: params.since,
        limit: params.limit,
        offset: params.offset,
      });
      const occurrences: UpstreamBugzillaOccurrence[] = [];
      for (const bug of search.items) {
        const commentsResp = await requestJson<{
          bugs?: Record<string, { comments?: RawComment[] }>;
        }>(`/bug/${bug.id}/comment`, { query: { new_since: params.since } });
        const comments = commentsResp.data?.bugs?.[String(bug.id)]?.comments ?? [];
        for (const c of comments) {
          occurrences.push({
            kind: "bugzilla.bug.commented",
            bugId: bug.id,
            commentId: c.id,
            changeKey: `comment-${c.id}`,
            timestamp: c.time,
            product: bug.product,
            component: bug.component,
            actor: c.creator,
            commentText: c.text,
          });
        }
      }
      return { occurrences, scanComplete: !search.hasMore };
    },

    async checkVisibility(bugId: BugId, commentId?: number) {
      const resp = await requestJson<{ bugs?: RawBug[] }>(`/bug/${bugId}`, {
        query: { include_fields: "id" },
      });
      if (resp.status === 401) return "credential_revoked";
      if (resp.status === 403 || resp.status === 404 || !resp.data?.bugs?.length) {
        return "restricted_or_missing";
      }
      if (commentId !== undefined) {
        const cResp = await requestJson<{ comments?: Record<string, RawComment> }>(
          `/bug/comment/${commentId}`,
        );
        if (cResp.status === 401) return "credential_revoked";
        if (cResp.status >= 400 || !cResp.data?.comments?.[String(commentId)]) {
          return "restricted_or_missing";
        }
      }
      return "visible";
    },
  };
}
