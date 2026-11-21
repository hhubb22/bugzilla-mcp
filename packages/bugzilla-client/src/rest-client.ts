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
  const parsedBase = new URL(config.baseUrl);
  const isLocal = parsedBase.hostname === "localhost" || parsedBase.hostname === "127.0.0.1";
  if (parsedBase.protocol !== "https:" && !isLocal) {
    throw new Error("Bugzilla baseUrl must use https:// outside localhost");
  }
  if (parsedBase.username || parsedBase.password) {
    throw new Error("Bugzilla baseUrl must not contain embedded credentials");
  }
  const baseUrl = config.baseUrl.replace(/\/+$/, "");

  async function requestJson<T>(
    path: string,
    init: {
      method?: "GET" | "POST" | "PUT";
      query?: Array<[string, string]>;
      body?: unknown;
      timeoutMs?: number;
    } = {},
  ): Promise<{ status: number; data: T | null; parseOk: boolean }> {
    const url = new URL(`${baseUrl}/rest${path}`);
    if (init.query) {
      for (const [k, v] of init.query) {
        url.searchParams.append(k, v);
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
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
      ...(serializedBody !== undefined ? { body: serializedBody } : {}),
    });
    const text = await response.text();
    let parsed: T | null = null;
    let parseOk = true;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text) as T;
      } catch {
        parsed = null;
        parseOk = false;
      }
    }
    return { status: response.status, data: parsed, parseOk };
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
      const query: Array<[string, string]> = [
        [
          "include_fields",
          "id,summary,product,component,status,resolution,priority,severity,assigned_to,last_change_time",
        ],
        ["limit", String(params.limit + 1)],
        ["offset", String(params.offset)],
      ];
      if (params.product) query.push(["product", params.product]);
      if (params.component) query.push(["component", params.component]);
      if (params.assignedTo) query.push(["assigned_to", params.assignedTo]);
      if (params.updatedSince) query.push(["last_change_time", params.updatedSince]);
      if (params.query) query.push(["summary", params.query]);
      if (params.status) {
        for (const s of params.status) {
          query.push(["status", s]);
        }
      }
      const resp = await requestJson<{ bugs?: RawBug[] }>("/bug", { query });
      if (resp.status >= 400 || !resp.parseOk || !resp.data) {
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
      if (bugResp.status >= 500 || !bugResp.parseOk) {
        throw new Error(`Bugzilla get bug transient failure (${bugResp.status})`);
      }
      const rawBug = bugResp.data?.bugs?.[0];
      if (!rawBug) return null;

      if (opts.maxComments === 0 && opts.maxHistory === 0) {
        return {
          bug: toBugSummary(rawBug),
          recentComments: [],
          recentHistory: [],
          attachments: [],
        };
      }

      const [commentsResp, historyResp, attachments] = await Promise.all([
        opts.maxComments > 0
          ? requestJson<{ bugs?: Record<string, { comments?: RawComment[] }> }>(
              `/bug/${bugId}/comment`,
            )
          : Promise.resolve({ status: 200, data: null, parseOk: true }),
        opts.maxHistory > 0
          ? requestJson<{ bugs?: Array<{ history?: RawHistoryEntry[] }> }>(`/bug/${bugId}/history`)
          : Promise.resolve({ status: 200, data: null, parseOk: true }),
        this.listAttachments(bugId),
      ]);

      const rawComments = commentsResp.data?.bugs?.[String(bugId)]?.comments ?? [];
      const rawHistory = historyResp.data?.bugs?.[0]?.history ?? [];

      return {
        bug: toBugSummary(rawBug),
        recentComments:
          opts.maxComments > 0
            ? rawComments.slice(-opts.maxComments).map((c) => ({
                id: c.id,
                creator: c.creator,
                time: c.time,
                isPrivate: Boolean(c.is_private),
                text: c.text,
                untrustedUserContent: true,
              }))
            : [],
        recentHistory:
          opts.maxHistory > 0
            ? rawHistory.slice(-opts.maxHistory).map((entry) => ({
                when: entry.when,
                who: entry.who,
                changes: entry.changes.map((ch) => ({
                  fieldName: ch.field_name,
                  removed: ch.removed,
                  added: ch.added,
                })),
              }))
            : [],
        attachments,
      };
    },

    async listAttachments(bugId: BugId): Promise<AttachmentMeta[]> {
      const resp = await requestJson<{ bugs?: Record<string, RawAttachment[]> }>(
        `/bug/${bugId}/attachment`,
        { query: [["exclude_fields", "data"]] },
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
      if (resp.status >= 400 || !resp.parseOk) {
        throw new Error(`Bugzilla update failed (${resp.status})`);
      }
      const updatedLastChangeTime = resp.data?.bugs?.[0]?.last_change_time;
      if (!updatedLastChangeTime) {
        throw new Error("Bugzilla update response missing last_change_time acknowledgement");
      }
      return { updatedLastChangeTime };
    },

    async createBug(input: Omit<BugzillaCreateBugInput, "idempotencyKey">) {
      const safeCustomFields: Record<string, unknown> = {};
      if (input.customFields) {
        for (const [key, value] of Object.entries(input.customFields)) {
          if (key.startsWith("cf_")) {
            safeCustomFields[key] = value;
          }
        }
      }
      const resp = await requestJson<{ id?: number }>("/bug", {
        method: "POST",
        body: {
          ...safeCustomFields,
          product: input.product,
          component: input.component,
          version: input.version,
          summary: input.summary,
          description: input.description,
          severity: input.severity,
          priority: input.priority,
        },
      });
      if (resp.status >= 400 || !resp.parseOk || resp.data?.id === undefined) {
        throw new Error(`Bugzilla create bug failed (${resp.status})`);
      }
      return { bugId: resp.data.id };
    },

    async listChangesSince(params) {
      // Overlap by 1 second because Bugzilla 5.2 comment new_since uses strictly-greater comparison
      const overlapSince = new Date(Math.max(0, Date.parse(params.since) - 1_000)).toISOString();
      const search = await this.searchBugs({
        updatedSince: overlapSince,
        limit: params.limit,
        offset: params.offset,
      });
      const occurrences: UpstreamBugzillaOccurrence[] = [];
      for (const bug of search.items) {
        const [commentsResp, historyResp] = await Promise.all([
          requestJson<{ bugs?: Record<string, { comments?: RawComment[] }> }>(
            `/bug/${bug.id}/comment`,
            { query: [["new_since", overlapSince]] },
          ),
          requestJson<{ bugs?: Array<{ history?: RawHistoryEntry[] }> }>(`/bug/${bug.id}/history`, {
            query: [["new_since", overlapSince]],
          }),
        ]);
        if (
          commentsResp.status >= 500 ||
          !commentsResp.parseOk ||
          historyResp.status >= 500 ||
          !historyResp.parseOk
        ) {
          return { occurrences: [], scanComplete: false };
        }
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
        const historyEntries = historyResp.data?.bugs?.[0]?.history ?? [];
        for (const entry of historyEntries) {
          const fieldsChanged = entry.changes.map((ch) => ch.field_name);
          occurrences.push({
            kind: "bugzilla.bug.updated",
            bugId: bug.id,
            changeKey: `history-${entry.when}-${entry.who}-${fieldsChanged.join(",")}`,
            timestamp: entry.when,
            product: bug.product,
            component: bug.component,
            actor: entry.who,
            fieldsChanged,
            summaryText: bug.summary,
          });
          if (
            entry.changes.some(
              (ch) => ch.field_name === "flagtypes.name" && ch.added.includes("needinfo?"),
            )
          ) {
            occurrences.push({
              kind: "bugzilla.flag.needinfo",
              bugId: bug.id,
              changeKey: `needinfo-${entry.when}-${entry.who}`,
              timestamp: entry.when,
              product: bug.product,
              component: bug.component,
              actor: entry.who,
              summaryText: bug.summary,
            });
          }
        }
      }
      return { occurrences, scanComplete: !search.hasMore };
    },

    async checkVisibility(bugId: BugId, commentId?: number) {
      const resp = await requestJson<{ bugs?: RawBug[] }>(`/bug/${bugId}`, {
        query: [["include_fields", "id"]],
      });
      if (resp.status >= 500 || !resp.parseOk) {
        throw new Error(`Bugzilla visibility check transient failure (${resp.status})`);
      }
      if (resp.status === 401) return "credential_revoked";
      if (resp.status === 403 || resp.status === 404 || !resp.data?.bugs?.length) {
        return "restricted_or_missing";
      }
      if (commentId !== undefined) {
        const cResp = await requestJson<{ comments?: Record<string, RawComment> }>(
          `/bug/comment/${commentId}`,
        );
        if (cResp.status >= 500 || !cResp.parseOk) {
          throw new Error(`Bugzilla comment visibility check transient failure (${cResp.status})`);
        }
        if (cResp.status === 401) return "credential_revoked";
        if (cResp.status >= 400 || !cResp.data?.comments?.[String(commentId)]) {
          return "restricted_or_missing";
        }
      }
      return "visible";
    },
  };
}
