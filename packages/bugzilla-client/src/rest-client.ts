import type {
  AttachmentMeta,
  BugDossier,
  BugId,
  BugSummary,
  BugzillaCreateBugInput,
  IsoTimestamp,
  ProposalDiff,
} from "@bugzilla-mcp/contracts";
import {
  BugzillaAccessDeniedError,
  BugzillaCredentialRevokedError,
  BugzillaUnsupportedAttachmentError,
  type BugzillaClient,
  type BugzillaClientConfig,
  type BugzillaInstanceCapabilities,
  type UpstreamBugzillaOccurrence,
} from "./index.js";

const MAX_ATTACHMENT_DOWNLOAD_BYTES = 2 * 1024 * 1024; // 2 MiB hard ceiling before fetching base64

function isTextAttachmentMime(contentType: string): boolean {
  const mime = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/javascript" ||
    mime === "application/x-patch" ||
    mime === "application/x-diff" ||
    mime === "application/yaml" ||
    mime === "application/x-yaml" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}

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
  creation_time?: string;
  creator?: string;
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

  // Bugzilla 5.0/5.2 updates `user_api_keys.last_used` on every authenticated REST call;
  // serializing requests per API-key client prevents MariaDB row-lock deadlocks (HTTP 500).
  let keyChain: Promise<unknown> = Promise.resolve();
  function enqueueForKey<T>(fn: () => Promise<T>): Promise<T> {
    const run = keyChain.then(fn, fn);
    keyChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function requestJsonOnce<T>(
    path: string,
    init: {
      method?: "GET" | "POST" | "PUT";
      query?: Array<[string, string]>;
      body?: Record<string, unknown>;
      timeoutMs?: number;
    } = {},
  ): Promise<{ status: number; data: T | null; parseOk: boolean; bzErrorCode?: number }> {
    const method = init.method ?? "GET";
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
      const bodyPayload = config.allowQueryFallback
        ? { ...init.body, api_key: config.apiKey }
        : init.body;
      serializedBody = JSON.stringify(bodyPayload);
    } else if (config.allowQueryFallback && method === "GET") {
      url.searchParams.set("api_key", config.apiKey);
    }
    const response = await fetch(url.toString(), {
      method,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(init.timeoutMs ?? 15_000),
      ...(serializedBody !== undefined ? { body: serializedBody } : {}),
    });
    const text = await response.text();
    let parsed: T | null = null;
    let parseOk = true;
    let bzErrorCode: number | undefined;
    if (text.length > 0) {
      try {
        const raw = JSON.parse(text) as T & { error?: boolean; code?: number };
        parsed = raw;
        if (raw && typeof raw === "object" && raw.error === true && typeof raw.code === "number") {
          bzErrorCode = raw.code;
        }
      } catch {
        parsed = null;
        parseOk = false;
      }
    }
    return {
      status: response.status,
      data: parsed,
      parseOk,
      ...(bzErrorCode !== undefined ? { bzErrorCode } : {}),
    };
  }

  async function requestJson<T>(
    path: string,
    init: {
      method?: "GET" | "POST" | "PUT";
      query?: Array<[string, string]>;
      body?: Record<string, unknown>;
      timeoutMs?: number;
    } = {},
  ): Promise<{ status: number; data: T | null; parseOk: boolean; bzErrorCode?: number }> {
    const method = init.method ?? "GET";
    return enqueueForKey(async () => {
      const first = await requestJsonOnce<T>(path, init);
      if (method === "GET" && first.status >= 500) {
        return requestJsonOnce<T>(path, init);
      }
      return first;
    });
  }

  return {
    async probeCapabilities(): Promise<BugzillaInstanceCapabilities> {
      const versionResp = await requestJson<{ version?: string }>("/version");
      const version = versionResp.data?.version ?? "unknown";
      const whoamiResp = await requestJson<{
        id?: number;
        name?: string;
        groups?: Array<{ name: string }>;
      }>("/whoami");
      if (whoamiResp.status === 200 && whoamiResp.data?.name) {
        let groups = whoamiResp.data.groups;
        if (!groups && whoamiResp.data.id !== undefined) {
          const userResp = await requestJson<{
            users?: Array<{ groups?: Array<{ name: string }> }>;
          }>(`/user/${whoamiResp.data.id}`);
          groups = userResp.data?.users?.[0]?.groups ?? [];
        }
        const isInsider = (groups ?? []).some(
          (group) => group.name === "insidergroup" || group.name === "insider",
        );
        return {
          version,
          supportsHeaderAuth: true,
          authenticatedUser: whoamiResp.data.name,
          isInsider,
        };
      }

      // Stock Bugzilla 5.0/5.2 does not expose /rest/whoami (returns 404 / code 32614).
      // Identify the authenticated user via /rest/user?match=* using the self-only saved_searches marker.
      if (whoamiResp.status === 404 || whoamiResp.bzErrorCode === 32614) {
        const usersResp = await requestJson<{
          users?: Array<{
            id?: number;
            name?: string;
            groups?: Array<{ name: string }>;
            saved_searches?: unknown[];
            saved_reports?: unknown[];
          }>;
        }>("/user", { query: [["match", "*"]] });
        if (usersResp.status === 200 && usersResp.data?.users) {
          // Strict self-identification only: never guess from a sole directory match (REST-04)
          const selfUser = usersResp.data.users.find(
            (u) => u.saved_searches !== undefined || u.saved_reports !== undefined,
          );
          if (selfUser?.name) {
            const isInsider = (selfUser.groups ?? []).some(
              (group) => group.name === "insidergroup" || group.name === "insider",
            );
            return {
              version,
              supportsHeaderAuth: !config.allowQueryFallback,
              authenticatedUser: selfUser.name,
              isInsider,
            };
          }
        }
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
      if (resp.bzErrorCode === 306 || resp.bzErrorCode === 300) {
        throw new BugzillaCredentialRevokedError();
      }
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

      const commentsResp =
        opts.maxComments > 0
          ? await requestJson<{ bugs?: Record<string, { comments?: RawComment[] }> }>(
              `/bug/${bugId}/comment`,
            )
          : { status: 200, data: null, parseOk: true };
      if (commentsResp.status >= 500 || !commentsResp.parseOk) {
        throw new Error(`Bugzilla comments transient failure (${commentsResp.status})`);
      }
      const historyResp =
        opts.maxHistory > 0
          ? await requestJson<{ bugs?: Array<{ history?: RawHistoryEntry[] }> }>(
              `/bug/${bugId}/history`,
            )
          : { status: 200, data: null, parseOk: true };
      if (historyResp.status >= 500 || !historyResp.parseOk) {
        throw new Error(`Bugzilla history transient failure (${historyResp.status})`);
      }
      const attachments = await this.listAttachments(bugId);

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

    async getAttachmentExcerpt({ attachmentId, byteOffset, maxBytes }) {
      // 1. Inspect metadata FIRST without base64 data to reject binary or oversized attachments (REST-05)
      const metaResp = await requestJson<{
        attachments?: Record<
          string,
          {
            id: number;
            bug_id: number;
            file_name: string;
            content_type: string;
            size: number;
            is_private?: number | boolean;
          }
        >;
      }>(`/bug/attachment/${attachmentId}`, { query: [["exclude_fields", "data"]] });
      if (metaResp.bzErrorCode === 306 || metaResp.bzErrorCode === 300) {
        throw new BugzillaCredentialRevokedError();
      }
      if (
        metaResp.bzErrorCode === 101 ||
        metaResp.bzErrorCode === 102 ||
        metaResp.bzErrorCode === 110 ||
        metaResp.bzErrorCode === 111 ||
        metaResp.status === 401 ||
        metaResp.status === 403 ||
        metaResp.status === 404
      ) {
        return null;
      }
      if (metaResp.status >= 400 || !metaResp.parseOk) {
        throw new Error(`Bugzilla attachment metadata fetch failed (${metaResp.status})`);
      }
      const meta = metaResp.data?.attachments?.[String(attachmentId)];
      if (!meta) return null;
      if (!isTextAttachmentMime(meta.content_type) || meta.size > MAX_ATTACHMENT_DOWNLOAD_BYTES) {
        throw new BugzillaUnsupportedAttachmentError(
          `Attachment #${attachmentId} (${meta.content_type}, ${meta.size} bytes) cannot be excerpted as bounded text`,
        );
      }

      const resp = await requestJson<{
        attachments?: Record<
          string,
          {
            id: number;
            bug_id: number;
            file_name: string;
            content_type: string;
            size: number;
            is_private?: number | boolean;
            data?: string;
          }
        >;
      }>(`/bug/attachment/${attachmentId}`);
      if (resp.bzErrorCode === 306 || resp.bzErrorCode === 300) {
        throw new BugzillaCredentialRevokedError();
      }
      if (resp.status === 401 || resp.status === 403 || resp.status === 404) {
        return null;
      }
      if (resp.status >= 400 || !resp.parseOk) {
        throw new Error(`Bugzilla attachment fetch failed (${resp.status})`);
      }
      const att = resp.data?.attachments?.[String(attachmentId)];
      if (!att) return null;
      const rawBuf = att.data ? Buffer.from(att.data, "base64") : Buffer.alloc(0);
      const totalBytes = rawBuf.byteLength;
      const start = Math.min(byteOffset, totalBytes);
      const end = Math.min(start + maxBytes, totalBytes);
      const slice = rawBuf.subarray(start, end);
      return {
        attachmentId: att.id,
        bugId: att.bug_id,
        fileName: att.file_name,
        contentType: att.content_type,
        totalBytes,
        byteOffset: start,
        excerptText: slice.toString("utf8"),
        truncated: end < totalBytes,
        isPrivate: Boolean(att.is_private),
      };
    },

    async postPrivateComment(bugId: BugId, text: string) {
      const resp = await requestJson<{ id?: number; code?: number; message?: string }>(
        `/bug/${bugId}/comment`,
        {
          method: "POST",
          body: { comment: text, is_private: true },
        },
      );
      if (resp.bzErrorCode === 306 || resp.bzErrorCode === 300) {
        throw new BugzillaCredentialRevokedError(
          `Bugzilla API key invalid or revoked (code ${resp.bzErrorCode})`,
        );
      }
      if (resp.bzErrorCode === 101 || resp.bzErrorCode === 102) {
        throw new BugzillaAccessDeniedError();
      }
      // Code 113 is Bugzilla's exact non-insider private-comment rejection (REST-01)
      if (
        resp.bzErrorCode === 113 ||
        (resp.bzErrorCode === undefined && (resp.status === 400 || resp.status === 403))
      ) {
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
        bugs?: Array<{ id?: number; last_change_time?: IsoTimestamp }>;
      }>(`/bug/${bugId}`, { method: "PUT", body });
      if (resp.status >= 400 || !resp.parseOk) {
        throw new Error(`Bugzilla update failed (${resp.status})`);
      }
      let updatedLastChangeTime = resp.data?.bugs?.[0]?.last_change_time;
      if (!updatedLastChangeTime && resp.data?.bugs?.[0]?.id !== undefined) {
        const refreshed = await requestJson<{ bugs?: RawBug[] }>(`/bug/${bugId}`, {
          query: [["include_fields", "last_change_time"]],
        });
        updatedLastChangeTime = refreshed.data?.bugs?.[0]?.last_change_time;
      }
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
      const payload: Record<string, unknown> = {
        ...safeCustomFields,
        summary: input.summary,
        description: input.description,
        op_sys: "All",
        platform: "All",
      };
      if (input.product !== undefined) payload.product = input.product;
      if (input.component !== undefined) payload.component = input.component;
      if (input.version !== undefined) payload.version = input.version;
      if (input.severity !== undefined) payload.severity = input.severity;
      if (input.priority !== undefined) payload.priority = input.priority;
      const resp = await requestJson<{ id?: number }>("/bug", {
        method: "POST",
        body: payload,
      });
      if (resp.status >= 400 || !resp.parseOk || resp.data?.id === undefined) {
        throw new Error(`Bugzilla create bug failed (${resp.status})`);
      }
      return { bugId: resp.data.id };
    },

    async listChangesSince(params) {
      // Overlap by 1 second because Bugzilla 5.2 comment new_since uses strictly-greater comparison
      const overlapSince = new Date(Math.max(0, Date.parse(params.since) - 1_000)).toISOString();
      const query: Array<[string, string]> = [
        [
          "include_fields",
          "id,summary,product,component,status,resolution,priority,severity,assigned_to,last_change_time,creation_time,creator",
        ],
        ["limit", String(params.limit)],
        ["offset", String(params.offset)],
        ["last_change_time", overlapSince],
      ];
      const bugListResp = await requestJson<{ bugs?: RawBug[] }>("/bug", { query });
      if (bugListResp.bzErrorCode === 306 || bugListResp.bzErrorCode === 300) {
        throw new BugzillaCredentialRevokedError();
      }
      if (bugListResp.status >= 400 || !bugListResp.parseOk || !bugListResp.data) {
        return { occurrences: [], scanComplete: false };
      }
      const rawBugs = bugListResp.data.bugs ?? [];
      const occurrences: UpstreamBugzillaOccurrence[] = [];
      for (const rawBug of rawBugs) {
        const bug = toBugSummary(rawBug);
        // Synthesize bugzilla.bug.created when creation_time falls within the scanned window (EVENT-04)
        if (rawBug.creation_time && Date.parse(rawBug.creation_time) >= Date.parse(overlapSince)) {
          occurrences.push({
            kind: "bugzilla.bug.created",
            bugId: bug.id,
            changeKey: `created-${bug.id}`,
            timestamp: rawBug.creation_time,
            product: bug.product,
            component: bug.component,
            actor: rawBug.creator ?? bug.assignedTo,
            summaryText: bug.summary,
          });
        }
        const commentsResp = await requestJson<{
          bugs?: Record<string, { comments?: RawComment[] }>;
        }>(`/bug/${bug.id}/comment`, { query: [["new_since", overlapSince]] });
        if (commentsResp.bzErrorCode === 306 || commentsResp.bzErrorCode === 300) {
          throw new BugzillaCredentialRevokedError();
        }
        const historyResp = await requestJson<{
          bugs?: Array<{ history?: RawHistoryEntry[] }>;
        }>(`/bug/${bug.id}/history`, { query: [["new_since", overlapSince]] });
        if (historyResp.bzErrorCode === 306 || historyResp.bzErrorCode === 300) {
          throw new BugzillaCredentialRevokedError();
        }
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
          for (const ch of entry.changes) {
            if (ch.field_name === "flagtypes.name" && ch.added.includes("needinfo?")) {
              const reqMatch = /needinfo\?\(([^)]+)\)/.exec(ch.added);
              occurrences.push({
                kind: "bugzilla.flag.needinfo",
                bugId: bug.id,
                changeKey: `needinfo-${entry.when}-${entry.who}-${reqMatch?.[1] ?? ""}`,
                timestamp: entry.when,
                product: bug.product,
                component: bug.component,
                actor: entry.who,
                ...(reqMatch?.[1] ? { requestee: reqMatch[1] } : {}),
                summaryText: bug.summary,
              });
            }
          }
        }
      }
      // Confirm exhaustion only on an empty page so Bugzilla max_search_results caps cannot truncate scans (REST-02)
      return {
        occurrences,
        scanComplete: rawBugs.length === 0,
        nextOffset: params.offset + rawBugs.length,
      };
    },

    async checkVisibility(bugId: BugId, commentId?: number) {
      const resp = await requestJson<{ bugs?: RawBug[] }>(`/bug/${bugId}`, {
        query: [["include_fields", "id"]],
      });
      if (resp.status >= 500 || !resp.parseOk) {
        throw new Error(`Bugzilla visibility check transient failure (${resp.status})`);
      }
      // Bugzilla 5.2: code 306/300 = invalid/revoked credential; code 101/102/110/111/505 = access/lookup denied (REST-01)
      if (resp.bzErrorCode === 306 || resp.bzErrorCode === 300) {
        return "credential_revoked";
      }
      if (
        resp.bzErrorCode === 101 ||
        resp.bzErrorCode === 102 ||
        resp.bzErrorCode === 110 ||
        resp.bzErrorCode === 111 ||
        resp.bzErrorCode === 505
      ) {
        return "restricted_or_missing";
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
        if (cResp.bzErrorCode === 306 || cResp.bzErrorCode === 300) {
          return "credential_revoked";
        }
        if (
          cResp.bzErrorCode === 101 ||
          cResp.bzErrorCode === 102 ||
          cResp.bzErrorCode === 110 ||
          cResp.bzErrorCode === 111 ||
          cResp.bzErrorCode === 505
        ) {
          return "restricted_or_missing";
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
