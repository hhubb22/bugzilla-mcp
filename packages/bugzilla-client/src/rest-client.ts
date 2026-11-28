import {
  CUSTOM_FIELD_KEY_PATTERN,
  type AttachmentMeta,
  type BugDossier,
  type BugFlag,
  type BugId,
  type BugSummary,
  type BugzillaCreateBugInput,
  type FieldMetadata,
  type FieldStatusTransition,
  type FieldValueMetadata,
  type FlagStatus,
  type IsoTimestamp,
  type ProductComponentMetadata,
  type ProductMetadata,
  type ProductVersionMetadata,
  type ProposalDiff,
} from "@bugzilla-mcp/contracts";
import { Duration, Effect, Predicate, Schedule, Semaphore } from "effect";
import {
  type BugzillaHttpMethod,
  classifyResponse,
  isPrivateCommentRejection,
  parseRetryAfterMs,
  type RawHttpResponse,
} from "./classify.js";
import {
  type BugzillaClientError,
  BugzillaTransientError,
  BugzillaUnsupportedAttachmentError,
  BugzillaValidationError,
  redactErrorMessage,
} from "./errors.js";
import { normalizeBugzillaFieldName } from "./field-codec.js";
import { confirmedHistoryKey } from "./history.js";
import type {
  ApplyBugUpdateResult,
  AttachmentExcerptResult,
  BugzillaAuthMode,
  BugzillaClientConfig,
  BugzillaClientEffect,
  BugzillaInstanceCapabilities,
  BugzillaSearchParams,
  BugzillaSearchResult,
  EnterableProductSummary,
  ListChangesSinceResult,
  PostPrivateCommentResult,
  PostPublicCommentResult,
  UpstreamBugzillaOccurrence,
  VisibilityStatus,
} from "./types.js";

const MAX_ATTACHMENT_DOWNLOAD_BYTES = 2 * 1024 * 1024; // 2 MiB hard ceiling before fetching base64
const DEFAULT_INSIDER_GROUPS: readonly string[] = ["insidergroup", "insider"];
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_GET_RETRIES = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 200;
const DEFAULT_MAX_RETRY_DELAY_MS = 5_000;

const VALID_FLAG_STATUSES: ReadonlySet<string> = new Set(["?", "+", "-", "X"]);

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

interface RawBugFlag {
  id?: number;
  type_id?: number;
  name?: string;
  status?: string;
  requestee?: string;
  setter?: string;
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
  version?: string;
  op_sys?: string;
  platform?: string;
  creation_time?: string;
  creator?: string;
  flags?: RawBugFlag[];
  [key: string]: unknown;
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

interface RawProductComponent {
  id?: number;
  name?: string;
  description?: string;
  default_assigned_to?: string;
  is_active?: boolean | number;
}

interface RawProductVersion {
  id?: number;
  name?: string;
  is_active?: boolean | number;
}

interface RawProduct {
  id?: number;
  name?: string;
  description?: string;
  is_active?: boolean | number;
  default_milestone?: string;
  components?: RawProductComponent[];
  versions?: RawProductVersion[];
  milestones?: RawProductVersion[];
}

interface RawFieldValue {
  name?: unknown;
  sort_key?: unknown;
  is_active?: unknown;
  visibility_values?: unknown;
  can_change_to?: Array<{ name?: unknown; comment_required?: unknown }>;
}

interface RawField {
  id?: unknown;
  name?: unknown;
  display_name?: unknown;
  type?: unknown;
  is_custom?: unknown;
  is_mandatory?: unknown;
  is_on_bug_entry?: unknown;
  values?: RawFieldValue[];
}

function toBugFlags(rawFlags: readonly RawBugFlag[] | undefined): BugFlag[] | undefined {
  if (!Array.isArray(rawFlags)) return undefined;
  const out: BugFlag[] = [];
  for (const f of rawFlags) {
    if (
      !Predicate.isObject(f) ||
      !Predicate.isString(f.name) ||
      f.name.length === 0 ||
      !Predicate.isString(f.status) ||
      !VALID_FLAG_STATUSES.has(f.status)
    ) {
      continue;
    }
    out.push({
      ...(typeof f.id === "number" && Number.isInteger(f.id) && f.id >= 1 ? { id: f.id } : {}),
      ...(typeof f.type_id === "number" && Number.isInteger(f.type_id) && f.type_id >= 1
        ? { typeId: f.type_id }
        : {}),
      name: f.name,
      status: f.status as FlagStatus,
      ...(Predicate.isString(f.requestee) ? { requestee: f.requestee } : {}),
      ...(Predicate.isString(f.setter) ? { setter: f.setter } : {}),
    });
  }
  return out;
}

function toBugSummary(raw: RawBug): BugSummary {
  const flags = toBugFlags(raw.flags);
  const customFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.startsWith("cf_") && value !== undefined) {
      customFields[key] = value;
    }
  }
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
    ...(Predicate.isString(raw.version) ? { version: raw.version } : {}),
    ...(Predicate.isString(raw.op_sys) ? { opSys: raw.op_sys } : {}),
    ...(Predicate.isString(raw.platform) ? { platform: raw.platform } : {}),
    ...(Predicate.isString(raw.creator) ? { creator: raw.creator } : {}),
    ...(Predicate.isString(raw.creation_time) ? { creationTime: raw.creation_time } : {}),
    ...(flags !== undefined ? { flags } : {}),
    ...(Object.keys(customFields).length > 0 ? { customFields } : {}),
  };
}

function toProductMetadata(raw: RawProduct): ProductMetadata | null {
  if (!Predicate.isString(raw.name) || raw.name.length === 0) return null;
  const components: ProductComponentMetadata[] = [];
  for (const c of raw.components ?? []) {
    if (!Predicate.isString(c.name) || c.name.length === 0) continue;
    components.push({
      ...(typeof c.id === "number" && Number.isInteger(c.id) ? { id: c.id } : {}),
      name: c.name,
      ...(Predicate.isString(c.description) ? { description: c.description } : {}),
      ...(Predicate.isString(c.default_assigned_to)
        ? { defaultAssignedTo: c.default_assigned_to }
        : {}),
      isActive: c.is_active === undefined ? true : Boolean(c.is_active),
    });
  }
  const mapVersions = (
    items: readonly RawProductVersion[] | undefined,
  ): ProductVersionMetadata[] => {
    const res: ProductVersionMetadata[] = [];
    for (const v of items ?? []) {
      if (!Predicate.isString(v.name) || v.name.length === 0) continue;
      res.push({
        ...(typeof v.id === "number" && Number.isInteger(v.id) ? { id: v.id } : {}),
        name: v.name,
        isActive: v.is_active === undefined ? true : Boolean(v.is_active),
      });
    }
    return res;
  };
  const versions = mapVersions(raw.versions);
  const milestones = raw.milestones !== undefined ? mapVersions(raw.milestones) : undefined;
  return {
    ...(typeof raw.id === "number" && Number.isInteger(raw.id) ? { id: raw.id } : {}),
    name: raw.name,
    ...(Predicate.isString(raw.description) ? { description: raw.description } : {}),
    isActive: raw.is_active === undefined ? true : Boolean(raw.is_active),
    ...(Predicate.isString(raw.default_milestone)
      ? { defaultMilestone: raw.default_milestone }
      : {}),
    components,
    versions,
    ...(milestones !== undefined ? { milestones } : {}),
  };
}

function toFieldMetadata(raw: RawField): FieldMetadata | null {
  if (!Predicate.isString(raw.name) || raw.name.length === 0) return null;
  let values: FieldValueMetadata[] | undefined;
  if (Array.isArray(raw.values)) {
    values = raw.values.map((v) => {
      let canChangeTo: FieldStatusTransition[] | undefined;
      if (Array.isArray(v.can_change_to)) {
        canChangeTo = [];
        for (const t of v.can_change_to) {
          if (Predicate.isObject(t) && Predicate.isString(t.name) && t.name.length > 0) {
            canChangeTo.push({
              name: t.name,
              commentRequired: Boolean(t.comment_required),
            });
          }
        }
      }
      const visibilityValues = Array.isArray(v.visibility_values)
        ? v.visibility_values.filter(Predicate.isString)
        : undefined;
      return {
        name: Predicate.isString(v.name) ? v.name : String(v.name ?? ""),
        ...(typeof v.sort_key === "number" && Number.isInteger(v.sort_key)
          ? { sortKey: v.sort_key }
          : {}),
        ...(v.is_active !== undefined ? { isActive: Boolean(v.is_active) } : {}),
        ...(visibilityValues !== undefined ? { visibilityValues } : {}),
        ...(canChangeTo !== undefined ? { canChangeTo } : {}),
      };
    });
  }
  return {
    ...(typeof raw.id === "number" && Number.isInteger(raw.id) ? { id: raw.id } : {}),
    name: raw.name,
    displayName: Predicate.isString(raw.display_name) ? raw.display_name : raw.name,
    type: typeof raw.type === "number" && Number.isInteger(raw.type) ? raw.type : 0,
    isCustom: Boolean(raw.is_custom),
    isMandatory: Boolean(raw.is_mandatory),
    isOnBugEntry: Boolean(raw.is_on_bug_entry),
    ...(values !== undefined ? { values } : {}),
  };
}

export function createRestBugzillaClientEffect(config: BugzillaClientConfig): BugzillaClientEffect {
  const parsedBase = new URL(config.baseUrl);
  const isLocal =
    parsedBase.hostname === "localhost" ||
    parsedBase.hostname === "127.0.0.1" ||
    parsedBase.hostname === "[::1]";
  if (parsedBase.protocol !== "https:" && !isLocal) {
    throw new Error("Bugzilla baseUrl must use https:// outside localhost");
  }
  if (parsedBase.username || parsedBase.password) {
    throw new Error("Bugzilla baseUrl must not contain embedded credentials");
  }

  const baseUrl = config.baseUrl.replace(/\/+$/, "");
  const secrets = config.apiKey.length > 0 ? [config.apiKey] : [];
  const insiderGroups = new Set(config.insiderGroupNames ?? DEFAULT_INSIDER_GROUPS);
  const defaultTimeoutMs = config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const maxGetRetries = config.maxGetRetries ?? DEFAULT_MAX_GET_RETRIES;
  const retryBaseDelayMs = config.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const maxRetryDelayMs = config.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;

  let activeAuthMode: BugzillaAuthMode = config.allowQueryFallback ? "query_fallback" : "header";

  // Bugzilla 5.0/5.2 updates `user_api_keys.last_used` on every authenticated REST call;
  // serializing in-flight HTTP calls per API-key client prevents MariaDB row-lock deadlocks (HTTP 500).
  const keySemaphore = Semaphore.makeUnsafe(1);

  const getRetrySchedule = Schedule.min([
    Schedule.exponential(Duration.millis(retryBaseDelayMs)),
    Schedule.spaced(Duration.millis(maxRetryDelayMs)),
  ]).pipe(
    Schedule.upTo({ times: maxGetRetries }),
    Schedule.setInputType<BugzillaClientError>(),
    Schedule.while(({ input }) => {
      if (input._tag === "BugzillaTransientError") return true;
      if (input._tag === "BugzillaRateLimitError") {
        return input.retryAfterMs === undefined || input.retryAfterMs <= maxRetryDelayMs;
      }
      return false;
    }),
    Schedule.modifyDelay(({ duration, input }) => {
      if (input._tag === "BugzillaRateLimitError" && input.retryAfterMs !== undefined) {
        return Effect.succeed(Duration.millis(Math.max(0, input.retryAfterMs)));
      }
      return Effect.succeed(duration);
    }),
  );

  interface RequestInitOptions {
    readonly method?: BugzillaHttpMethod;
    readonly query?: ReadonlyArray<readonly [string, string]>;
    readonly body?: Record<string, unknown>;
    readonly timeoutMs?: number;
    readonly authMode?: BugzillaAuthMode;
  }

  function requestJsonOnce<T>(
    path: string,
    init: RequestInitOptions = {},
  ): Effect.Effect<T, BugzillaClientError> {
    const method: BugzillaHttpMethod = init.method ?? "GET";
    const isWrite = method !== "GET";
    const authMode = init.authMode ?? activeAuthMode;

    const doRequest = Effect.gen(function* () {
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
        const bodyPayload =
          authMode === "query_fallback" ? { ...init.body, api_key: config.apiKey } : init.body;
        serializedBody = JSON.stringify(bodyPayload);
      } else if (authMode === "query_fallback" && method === "GET") {
        url.searchParams.set("api_key", config.apiKey);
      }

      const fetchFn = config.fetchImpl ?? globalThis.fetch;
      const timeoutMs = init.timeoutMs ?? defaultTimeoutMs;

      // CRITICAL (#21 #1): Zero-argument thunk so Effect NEVER passes an interruption
      // AbortSignal into non-idempotent POST/PUT fetch calls; use ONLY AbortSignal.timeout.
      const rawResp = yield* Effect.tryPromise({
        try: async (): Promise<RawHttpResponse<T>> => {
          const response = await fetchFn(url.toString(), {
            method,
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(timeoutMs),
            ...(serializedBody !== undefined ? { body: serializedBody } : {}),
          });
          const retryAfterMs = parseRetryAfterMs(response.headers?.get?.("retry-after"));
          const text = await response.text();
          let parsed: T | null = null;
          let parseOk = true;
          let bzError = false;
          let bzErrorCode: number | undefined;
          let bzMessage: string | undefined;
          if (text.length > 0) {
            try {
              const raw = JSON.parse(text) as unknown;
              parsed = raw as T;
              if (Predicate.isObject(raw)) {
                const record = raw as Record<string, unknown>;
                if (record.error === true) {
                  bzError = true;
                }
                if (typeof record.code === "number" && Number.isFinite(record.code)) {
                  bzErrorCode = record.code;
                }
                if (Predicate.isString(record.message) && record.message.length > 0) {
                  bzMessage = record.message;
                }
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
            bzError,
            ...(bzErrorCode !== undefined ? { bzErrorCode } : {}),
            ...(bzMessage !== undefined ? { bzMessage } : {}),
            ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
          };
        },
        catch: (cause) =>
          new BugzillaTransientError({
            effectCertainty: isWrite ? "uncertain" : "none",
            message: redactErrorMessage(
              cause instanceof Error ? cause.message : String(cause),
              secrets,
            ),
          }),
      });

      return yield* classifyResponse<T>(method, rawResp, secrets);
    });

    const guarded = keySemaphore.withPermits(1)(doRequest);
    return isWrite ? Effect.uninterruptible(guarded) : guarded;
  }

  function requestJson<T>(
    path: string,
    init: RequestInitOptions = {},
  ): Effect.Effect<T, BugzillaClientError> {
    const method: BugzillaHttpMethod = init.method ?? "GET";
    const singleAttempt = requestJsonOnce<T>(path, init);
    // Strictly GET-only retry; NEVER retry non-idempotent POST/PUT!
    if (method === "GET" && maxGetRetries > 0) {
      return singleAttempt.pipe(Effect.retry(getRetrySchedule));
    }
    return singleAttempt;
  }

  function probeAuthWithMode(mode: BugzillaAuthMode): Effect.Effect<
    {
      readonly authenticatedUser: string;
      readonly isInsider: boolean;
      readonly supportsHeaderAuth: boolean;
      readonly authMode: BugzillaAuthMode;
    },
    BugzillaClientError
  > {
    return Effect.gen(function* () {
      const whoamiOutcome = yield* requestJson<{
        id?: number;
        name?: string;
        groups?: Array<{ name: string }>;
      }>("/whoami", { authMode: mode }).pipe(
        Effect.map((data) => ({ kind: "ok" as const, data })),
        Effect.catchTag("BugzillaAccessDeniedError", (err) => {
          // Stock Bugzilla 5.0/5.2 does not expose /rest/whoami (returns 404 / code 32614).
          if (err.httpStatus === 404 || err.bzErrorCode === 32614) {
            return Effect.succeed({ kind: "whoami_missing" as const });
          }
          return Effect.fail(err);
        }),
      );

      if (whoamiOutcome.kind === "ok") {
        const whoami = whoamiOutcome.data;
        if (!Predicate.isString(whoami.name) || whoami.name.length === 0) {
          return yield* new BugzillaTransientError({
            effectCertainty: "none",
            httpStatus: 200,
            message: "Bugzilla /whoami response missing authenticated user name",
          });
        }
        let groups = whoami.groups;
        if (!groups && whoami.id !== undefined) {
          // Check /user/{id} errors strictly — never silently downgrade isInsider to false
          const userData = yield* requestJson<{
            users?: Array<{ groups?: Array<{ name: string }> }>;
          }>(`/user/${whoami.id}`, { authMode: mode });
          groups = userData.users?.[0]?.groups ?? [];
        }
        const isInsider = (groups ?? []).some((group) => insiderGroups.has(group.name));
        return {
          authenticatedUser: whoami.name,
          isInsider,
          supportsHeaderAuth: mode === "header",
          authMode: mode,
        };
      }

      // Fallback for stock Bugzilla 5.0/5.2: identify self via /rest/user?match=* using self-only markers
      const usersData = yield* requestJson<{
        users?: Array<{
          id?: number;
          name?: string;
          groups?: Array<{ name: string }>;
          saved_searches?: unknown[];
          saved_reports?: unknown[];
        }>;
      }>("/user", { query: [["match", "*"]], authMode: mode });

      // Strict self-identification only: never guess from a sole directory match (REST-04)
      const selfUser = (usersData.users ?? []).find(
        (u) => u.saved_searches !== undefined || u.saved_reports !== undefined,
      );
      if (!selfUser?.name) {
        return yield* new BugzillaTransientError({
          effectCertainty: "none",
          httpStatus: 200,
          message: "Bugzilla /user authentication probe could not identify self user",
        });
      }
      const isInsider = (selfUser.groups ?? []).some((group) => insiderGroups.has(group.name));
      return {
        authenticatedUser: selfUser.name,
        isInsider,
        supportsHeaderAuth: mode === "header",
        authMode: mode,
      };
    });
  }

  const client: BugzillaClientEffect = {
    probeCapabilities: Effect.fnUntraced(function* () {
      const version = yield* requestJson<{ version?: string }>("/version", {
        authMode: "header",
      }).pipe(
        Effect.map((data) => (Predicate.isString(data.version) ? data.version : "unknown")),
        Effect.catchTag("BugzillaAccessDeniedError", () => Effect.succeed("unknown")),
      );

      // Always probe header-only auth first so supportsHeaderAuth & authMode are accurate.
      const authResult = yield* probeAuthWithMode("header").pipe(
        Effect.catchTags({
          BugzillaCredentialRevokedError: (err) =>
            config.allowQueryFallback ? probeAuthWithMode("query_fallback") : Effect.fail(err),
          BugzillaAccessDeniedError: (err) =>
            config.allowQueryFallback ? probeAuthWithMode("query_fallback") : Effect.fail(err),
        }),
      );

      activeAuthMode = authResult.authMode;
      const result: BugzillaInstanceCapabilities = {
        version,
        supportsHeaderAuth: authResult.supportsHeaderAuth,
        authMode: authResult.authMode,
        authenticatedUser: authResult.authenticatedUser,
        isInsider: authResult.isInsider,
      };
      return result;
    }),

    searchBugs: Effect.fnUntraced(function* (params: BugzillaSearchParams) {
      const query: Array<[string, string]> = [
        [
          "include_fields",
          "id,summary,product,component,status,resolution,priority,severity,assigned_to,last_change_time,version,op_sys,platform,creator,creation_time,flags",
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
      const data = yield* requestJson<{ bugs?: RawBug[] }>("/bug", { query });
      const bugs = data.bugs ?? [];
      const result: BugzillaSearchResult = {
        items: bugs.slice(0, params.limit).map(toBugSummary),
        hasMore: bugs.length > params.limit,
      };
      return result;
    }),

    getBugDossierData: Effect.fnUntraced(function* (
      bugId: BugId,
      opts: { readonly maxComments: number; readonly maxHistory: number },
    ): Effect.fn.Return<Omit<BugDossier, "internalNotes"> | null, BugzillaClientError> {
      const bugData = yield* requestJson<{ bugs?: RawBug[] }>(`/bug/${bugId}`).pipe(
        Effect.catchTag("BugzillaAccessDeniedError", () => Effect.succeed(null)),
      );
      if (bugData === null) return null;
      const rawBug = bugData.bugs?.[0];
      if (!rawBug) return null;

      if (opts.maxComments === 0 && opts.maxHistory === 0) {
        return {
          bug: toBugSummary(rawBug),
          recentComments: [],
          recentHistory: [],
          attachments: [],
        };
      }

      const commentsData =
        opts.maxComments > 0
          ? yield* requestJson<{ bugs?: Record<string, { comments?: RawComment[] }> }>(
              `/bug/${bugId}/comment`,
            ).pipe(Effect.catchTag("BugzillaAccessDeniedError", () => Effect.succeed(null)))
          : {};
      if (commentsData === null) return null;

      const historyData =
        opts.maxHistory > 0
          ? yield* requestJson<{ bugs?: Array<{ history?: RawHistoryEntry[] }> }>(
              `/bug/${bugId}/history`,
            ).pipe(Effect.catchTag("BugzillaAccessDeniedError", () => Effect.succeed(null)))
          : {};
      if (historyData === null) return null;

      const attachments = yield* client.listAttachments(bugId);
      if (attachments === null) return null;

      const rawComments =
        "bugs" in commentsData ? (commentsData.bugs?.[String(bugId)]?.comments ?? []) : [];
      const rawHistory = "bugs" in historyData ? (historyData.bugs?.[0]?.history ?? []) : [];

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
                untrustedUserContent: true as const,
              }))
            : [],
        recentHistory:
          opts.maxHistory > 0
            ? rawHistory.slice(-opts.maxHistory).map((entry) => ({
                when: entry.when,
                who: entry.who,
                changes: entry.changes.map((ch) => ({
                  fieldName: normalizeBugzillaFieldName(ch.field_name),
                  removed: ch.removed,
                  added: ch.added,
                })),
              }))
            : [],
        attachments,
      };
    }),

    listAttachments: Effect.fnUntraced(function* (
      bugId: BugId,
    ): Effect.fn.Return<AttachmentMeta[] | null, BugzillaClientError> {
      const data = yield* requestJson<{ bugs?: Record<string, RawAttachment[]> }>(
        `/bug/${bugId}/attachment`,
        { query: [["exclude_fields", "data"]] },
      ).pipe(Effect.catchTag("BugzillaAccessDeniedError", () => Effect.succeed(null)));
      if (data === null) return null;
      const list = data.bugs?.[String(bugId)] ?? [];
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
    }),

    getAttachmentExcerpt: Effect.fnUntraced(function* ({
      attachmentId,
      byteOffset,
      maxBytes,
    }: {
      readonly attachmentId: number;
      readonly byteOffset: number;
      readonly maxBytes: number;
    }): Effect.fn.Return<AttachmentExcerptResult | null, BugzillaClientError> {
      // 1. Inspect metadata FIRST without base64 data to reject binary or oversized attachments (REST-05)
      const metaData = yield* requestJson<{
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
      }>(`/bug/attachment/${attachmentId}`, { query: [["exclude_fields", "data"]] }).pipe(
        Effect.catchTag("BugzillaAccessDeniedError", () => Effect.succeed(null)),
      );
      if (metaData === null) return null;
      const meta = metaData.attachments?.[String(attachmentId)];
      if (!meta) return null;
      if (!isTextAttachmentMime(meta.content_type) || meta.size > MAX_ATTACHMENT_DOWNLOAD_BYTES) {
        return yield* new BugzillaUnsupportedAttachmentError({
          contentType: meta.content_type,
          sizeBytes: meta.size,
          message: `Attachment #${attachmentId} (${meta.content_type}, ${meta.size} bytes) cannot be excerpted as bounded text`,
        });
      }

      // 2. Fetch full payload using the EXACT same unified classifier & access-denied semantics
      const fullData = yield* requestJson<{
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
      }>(`/bug/attachment/${attachmentId}`).pipe(
        Effect.catchTag("BugzillaAccessDeniedError", () => Effect.succeed(null)),
      );
      if (fullData === null) return null;
      const att = fullData.attachments?.[String(attachmentId)];
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
    }),

    postPrivateComment: Effect.fnUntraced(function* (
      bugId: BugId,
      text: string,
    ): Effect.fn.Return<PostPrivateCommentResult, BugzillaClientError> {
      return yield* requestJson<{ id?: number }>(`/bug/${bugId}/comment`, {
        method: "POST",
        body: { comment: text, is_private: true },
      }).pipe(
        Effect.flatMap((data): Effect.Effect<PostPrivateCommentResult, BugzillaClientError> => {
          if (data.id === undefined) {
            return Effect.fail(
              new BugzillaTransientError({
                effectCertainty: "uncertain",
                httpStatus: 200,
                message: "Bugzilla private comment response missing comment id",
              }),
            );
          }
          return Effect.succeed({ kind: "created" as const, commentId: data.id });
        }),
        Effect.catchTags({
          // Return private_rejected ONLY on code 113 or explicit insider-group rejection message
          BugzillaAccessDeniedError: (err) =>
            isPrivateCommentRejection(err)
              ? Effect.succeed({ kind: "private_rejected" as const })
              : Effect.fail(err),
          BugzillaValidationError: (err) =>
            isPrivateCommentRejection(err)
              ? Effect.succeed({ kind: "private_rejected" as const })
              : Effect.fail(err),
        }),
      );
    }),

    postPublicComment: Effect.fnUntraced(function* (
      bugId: BugId,
      text: string,
    ): Effect.fn.Return<PostPublicCommentResult, BugzillaClientError> {
      const data = yield* requestJson<{ id?: number }>(`/bug/${bugId}/comment`, {
        method: "POST",
        body: { comment: text, is_private: false },
      });
      if (data.id === undefined) {
        return yield* new BugzillaTransientError({
          effectCertainty: "uncertain",
          httpStatus: 200,
          message: "Bugzilla public comment response missing comment id",
        });
      }
      // POST succeeded (200 committed). Best-effort follow-up GET for updated last_change_time;
      // NEVER turn a committed POST into an uncertain failure if this metadata fetch fails.
      const updatedLastChangeTime = yield* requestJson<{ bugs?: RawBug[] }>(`/bug/${bugId}`, {
        query: [["include_fields", "last_change_time"]],
      }).pipe(
        Effect.map((refreshed) => refreshed.bugs?.[0]?.last_change_time),
        Effect.catch(() => Effect.succeed(undefined)),
      );
      return {
        commentId: data.id,
        ...(updatedLastChangeTime !== undefined ? { updatedLastChangeTime } : {}),
      };
    }),

    applyBugUpdate: Effect.fnUntraced(function* (
      bugId: BugId,
      diff: ProposalDiff,
    ): Effect.fn.Return<ApplyBugUpdateResult, BugzillaClientError> {
      const body: Record<string, unknown> = {};
      if (diff.status !== undefined) body.status = diff.status;
      if (diff.resolution !== undefined) body.resolution = diff.resolution;
      if (diff.assignedTo !== undefined) body.assigned_to = diff.assignedTo;
      if (diff.priority !== undefined) body.priority = diff.priority;
      if (diff.severity !== undefined) body.severity = diff.severity;
      if (diff.dupeOf !== undefined) body.dupe_of = diff.dupeOf;
      if (diff.publicComment !== undefined) {
        body.comment = { body: diff.publicComment, is_private: false };
      }
      if (diff.flags !== undefined) {
        body.flags = diff.flags.map((flag) => ({
          name: flag.name,
          status: flag.status,
          ...(flag.requestee !== undefined ? { requestee: flag.requestee } : {}),
          ...(flag.id !== undefined ? { id: flag.id } : {}),
          ...(flag.typeId !== undefined ? { type_id: flag.typeId } : {}),
          ...(flag.new !== undefined ? { new: flag.new } : {}),
        }));
      }

      const data = yield* requestJson<{
        bugs?: Array<{
          id?: number;
          last_change_time?: IsoTimestamp;
          changes?: Record<string, { removed?: unknown; added?: unknown }>;
        }>;
      }>(`/bug/${bugId}`, { method: "PUT", body });

      // PUT returned 200 — the Bugzilla mutation is COMMITTED.
      const acknowledgement = data.bugs?.[0];
      const changes = Object.entries(acknowledgement?.changes ?? {});
      const confirmed =
        acknowledgement?.id === bugId &&
        acknowledgement.last_change_time &&
        changes.every(
          ([, change]) => typeof change?.removed === "string" && typeof change?.added === "string",
        )
          ? confirmedHistoryKey(
              acknowledgement.last_change_time,
              changes.map(([field, change]) => ({
                field,
                removed: String(change.removed),
                added: String(change.added),
              })),
            )
          : undefined;

      let updatedLastChangeTime = acknowledgement?.last_change_time;
      let metadataDegraded = false;

      if (!updatedLastChangeTime) {
        // Best-effort metadata fetch; NEVER turn a committed 200 PUT into an uncertain error!
        const refreshed = yield* requestJson<{ bugs?: RawBug[] }>(`/bug/${bugId}`, {
          query: [["include_fields", "last_change_time"]],
        }).pipe(
          Effect.map((res) => res.bugs?.[0]?.last_change_time),
          Effect.catch(() => Effect.succeed(undefined)),
        );
        if (refreshed) {
          updatedLastChangeTime = refreshed;
        } else {
          metadataDegraded = true;
        }
      }

      return {
        ...(updatedLastChangeTime !== undefined ? { updatedLastChangeTime } : {}),
        ...(confirmed !== undefined ? { confirmedHistoryKey: confirmed } : {}),
        ...(metadataDegraded ? { metadataDegraded: true } : {}),
      };
    }),

    createBug: Effect.fnUntraced(function* (
      input: Omit<BugzillaCreateBugInput, "idempotencyKey">,
    ): Effect.fn.Return<{ readonly bugId: BugId }, BugzillaClientError> {
      const safeCustomFields: Record<string, unknown> = {};
      if (input.customFields) {
        const invalidKeys: string[] = [];
        for (const [key, value] of Object.entries(input.customFields)) {
          if (!CUSTOM_FIELD_KEY_PATTERN.test(key)) {
            invalidKeys.push(key);
          } else {
            safeCustomFields[key] = value;
          }
        }
        if (invalidKeys.length > 0) {
          return yield* new BugzillaValidationError({
            httpStatus: 400,
            bzMessage: `Invalid custom field key(s): ${invalidKeys.join(", ")} (must match /^cf_[a-z0-9_]+$/)`,
            missingFields: invalidKeys,
          });
        }
      }

      const payload: Record<string, unknown> = {
        ...safeCustomFields,
        product: input.product,
        component: input.component,
        version: input.version,
        summary: input.summary,
        description: input.description,
        op_sys: input.opSys ?? "All",
        platform: input.platform ?? "All",
      };
      if (input.severity !== undefined) payload.severity = input.severity;
      if (input.priority !== undefined) payload.priority = input.priority;
      if (input.assignedTo !== undefined) payload.assigned_to = input.assignedTo;
      if (input.targetMilestone !== undefined) payload.target_milestone = input.targetMilestone;
      if (input.cc !== undefined) payload.cc = [...input.cc];
      if (input.groups !== undefined) payload.groups = [...input.groups];
      if (input.keywords !== undefined) payload.keywords = [...input.keywords];

      const data = yield* requestJson<{ id?: number }>("/bug", {
        method: "POST",
        body: payload,
      });
      if (data.id === undefined) {
        return yield* new BugzillaTransientError({
          effectCertainty: "uncertain",
          httpStatus: 200,
          message: "Bugzilla create bug response missing bug id",
        });
      }
      return { bugId: data.id };
    }),

    listChangesSince: Effect.fnUntraced(function* (params: {
      readonly since: IsoTimestamp;
      readonly limit: number;
      readonly offset: number;
    }): Effect.fn.Return<ListChangesSinceResult, BugzillaClientError> {
      const sinceMs = Date.parse(params.since);
      if (!Number.isFinite(sinceMs)) {
        return yield* new BugzillaValidationError({
          httpStatus: 400,
          bzMessage: `Invalid "since" timestamp: ${params.since}`,
        });
      }
      // Overlap by 1 second because Bugzilla 5.2 comment new_since uses strictly-greater comparison
      const overlapMs = Math.max(0, sinceMs - 1_000);
      const overlapSince = new Date(overlapMs).toISOString();

      const query: Array<[string, string]> = [
        [
          "include_fields",
          "id,summary,product,component,status,resolution,priority,severity,assigned_to,last_change_time,creation_time,creator,version,op_sys,platform,flags",
        ],
        ["limit", String(params.limit)],
        ["offset", String(params.offset)],
        ["last_change_time", overlapSince],
      ];

      const bugListData = yield* requestJson<{ bugs?: RawBug[] }>("/bug", { query });
      if (!Array.isArray(bugListData.bugs)) {
        return yield* new BugzillaTransientError({
          effectCertainty: "none",
          httpStatus: 200,
          message: "Bugzilla listChangesSince response missing bugs array",
        });
      }

      const rawBugs = bugListData.bugs;
      const occurrences: UpstreamBugzillaOccurrence[] = [];

      for (const rawBug of rawBugs) {
        const bug = toBugSummary(rawBug);

        // Verify bug comments & history accessibility BEFORE emitting bugzilla.bug.created (#8 P0.5).
        const commentsData = yield* requestJson<{
          bugs?: Record<string, { comments?: RawComment[] }>;
        }>(`/bug/${bug.id}/comment`, { query: [["new_since", overlapSince]] }).pipe(
          Effect.catchTag("BugzillaAccessDeniedError", () => Effect.succeed(null)),
        );
        if (commentsData === null) continue;

        const historyData = yield* requestJson<{
          bugs?: Array<{ history?: RawHistoryEntry[] }>;
        }>(`/bug/${bug.id}/history`, { query: [["new_since", overlapSince]] }).pipe(
          Effect.catchTag("BugzillaAccessDeniedError", () => Effect.succeed(null)),
        );
        if (historyData === null) continue;

        const comments = commentsData.bugs?.[String(bug.id)]?.comments;
        const historyEntries = historyData.bugs?.[0]?.history;
        if (!Array.isArray(comments) || !Array.isArray(historyEntries)) {
          return yield* new BugzillaTransientError({
            effectCertainty: "none",
            httpStatus: 200,
            message: `Bugzilla detail response malformed for bug #${bug.id}`,
          });
        }

        // Synthesize bugzilla.bug.created only AFTER comments/history accessibility is confirmed
        if (rawBug.creation_time) {
          const createdMs = Date.parse(rawBug.creation_time);
          if (Number.isFinite(createdMs) && createdMs >= overlapMs) {
            occurrences.push({
              kind: "bugzilla.bug.created",
              bugId: bug.id,
              changeKey: `created-${bug.id}`,
              timestamp: rawBug.creation_time,
              product: bug.product,
              component: bug.component,
              actor: rawBug.creator ?? bug.assignedTo,
              ...(Predicate.isString(rawBug.severity) ? { severity: rawBug.severity } : {}),
              summaryText: bug.summary,
            });
          }
        }

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

        const rows = historyEntries.map((entry) => ({
          entry,
          key: confirmedHistoryKey(
            entry.when,
            entry.changes.map(({ field_name, removed, added }) => ({
              field: field_name,
              removed,
              added,
            })),
          ),
        }));

        const counts = new Map<string, number>();
        const positions = new Map<string, number>();
        for (const { key } of rows) {
          if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
        }

        for (const { entry, key } of rows) {
          if (!key) continue;
          const position = (positions.get(key) ?? 0) + 1;
          positions.set(key, position);
          const rowKey = `${key}:${position}`;
          const proof = counts.get(key) === 1 ? { confirmedHistoryKey: key } : {};
          const fieldsChanged = entry.changes.map((ch) =>
            normalizeBugzillaFieldName(ch.field_name),
          );
          occurrences.push({
            kind: "bugzilla.bug.updated",
            bugId: bug.id,
            changeKey: rowKey,
            timestamp: entry.when,
            product: bug.product,
            component: bug.component,
            actor: entry.who,
            fieldsChanged,
            summaryText: bug.summary,
            ...proof,
          });

          for (const [index, ch] of entry.changes.entries()) {
            const normalizedField = normalizeBugzillaFieldName(ch.field_name);
            if (normalizedField === "flags" && ch.added.includes("needinfo?")) {
              const reqMatch = /needinfo\?\(([^)]+)\)/.exec(ch.added);
              occurrences.push({
                kind: "bugzilla.flag.needinfo",
                bugId: bug.id,
                changeKey: `${rowKey}:needinfo:${index}`,
                timestamp: entry.when,
                product: bug.product,
                component: bug.component,
                actor: entry.who,
                ...(reqMatch?.[1] ? { requestee: reqMatch[1] } : {}),
                summaryText: bug.summary,
                ...proof,
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
    }),

    checkVisibility: Effect.fnUntraced(function* (
      bugId: BugId,
      commentId?: number,
    ): Effect.fn.Return<VisibilityStatus, BugzillaClientError> {
      const bugCheck = yield* requestJson<{ bugs?: RawBug[] }>(`/bug/${bugId}`, {
        query: [["include_fields", "id"]],
      }).pipe(
        Effect.map((data) =>
          data.bugs && data.bugs.length > 0
            ? ("visible" as const)
            : ("restricted_or_missing" as const),
        ),
        Effect.catchTags({
          BugzillaCredentialRevokedError: () => Effect.succeed("credential_revoked" as const),
          BugzillaAccessDeniedError: () => Effect.succeed("restricted_or_missing" as const),
        }),
      );

      if (bugCheck !== "visible") {
        return bugCheck;
      }

      if (commentId !== undefined) {
        return yield* requestJson<{ comments?: Record<string, RawComment> }>(
          `/bug/comment/${commentId}`,
        ).pipe(
          Effect.map((data) =>
            data.comments?.[String(commentId)]
              ? ("visible" as const)
              : ("restricted_or_missing" as const),
          ),
          Effect.catchTags({
            BugzillaCredentialRevokedError: () => Effect.succeed("credential_revoked" as const),
            BugzillaAccessDeniedError: () => Effect.succeed("restricted_or_missing" as const),
          }),
        );
      }

      return "visible";
    }),

    listEnterableProducts: Effect.fnUntraced(function* (): Effect.fn.Return<
      readonly EnterableProductSummary[],
      BugzillaClientError
    > {
      const data = yield* requestJson<{ products?: RawProduct[] }>("/product", {
        query: [
          ["type", "enterable"],
          ["include_fields", "id,name,is_active"],
        ],
      });
      const out: EnterableProductSummary[] = [];
      for (const p of data.products ?? []) {
        if (!Predicate.isString(p.name) || p.name.length === 0) continue;
        out.push({
          ...(typeof p.id === "number" && Number.isInteger(p.id) ? { id: p.id } : {}),
          name: p.name,
          isActive: p.is_active === undefined ? true : Boolean(p.is_active),
        });
      }
      return out;
    }),

    getProductMetadata: Effect.fnUntraced(function* (
      productName: string,
    ): Effect.fn.Return<ProductMetadata | null, BugzillaClientError> {
      const data = yield* requestJson<{ products?: RawProduct[] }>(
        `/product/${encodeURIComponent(productName)}`,
        {
          query: [
            [
              "include_fields",
              "id,name,description,is_active,default_milestone,components,versions,milestones",
            ],
          ],
        },
      ).pipe(Effect.catchTag("BugzillaAccessDeniedError", () => Effect.succeed(null)));
      if (data === null) return null;
      const first = data.products?.[0];
      return first ? toProductMetadata(first) : null;
    }),

    getBugFields: Effect.fnUntraced(function* (): Effect.fn.Return<
      readonly FieldMetadata[],
      BugzillaClientError
    > {
      const data = yield* requestJson<{ fields?: RawField[] }>("/field/bug");
      const out: FieldMetadata[] = [];
      for (const f of data.fields ?? []) {
        const mapped = toFieldMetadata(f);
        if (mapped) out.push(mapped);
      }
      return out;
    }),
  };

  return client;
}

export {
  classifyResponse,
  classifyResponseOutcome,
  extractMissingFields,
  isPrivateCommentRejection,
  parseRetryAfterMs,
  type BugzillaHttpMethod,
  type RawHttpResponse,
} from "./classify.js";
