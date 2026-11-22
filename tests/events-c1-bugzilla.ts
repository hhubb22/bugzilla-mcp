import { createServer, type IncomingMessage } from "node:http";
import { once } from "node:events";

// The fixture speaks Bugzilla REST. The MCP server uses its production client.
export const actor = "triage@example.test";
export const product = "C1 Product";
export const component = "Events";
export const iso = (ms: number) => new Date(ms).toISOString();

interface HistoryEntry {
  when: string;
  who: string;
  changes: { field_name: string; removed: string; added: string }[];
}

interface Comment {
  id: number;
  bug_id: number;
  creator: string;
  creation_time: string;
  time: string;
  text: string;
  is_private: boolean;
  count: number;
}

export interface Bug {
  id: number;
  creation_time: string;
  last_change_time: string;
  summary: string;
  product: string;
  component: string;
  severity?: string;
  status: string;
  resolution: string;
  assigned_to: string;
  creator: string;
  priority: string;
  version: string;
  flags?: { id: number; name: string; status: string; requestee: string; setter: string }[];
}

export async function readBody(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing loopback address");
  return `http://127.0.0.1:${address.port}`;
}

export const apiKey = (tenant: string) => `fixture-bugzilla-key-${tenant}`;

export class BugzillaFixture {
  readonly bugs = new Map<number, Bug>();
  readonly comments: Comment[] = [];
  readonly history = new Map<number, HistoryEntry[]>();
  readonly hiddenBugs = new Set<number>();
  readonly hiddenComments = new Set<number>();
  readonly revokedKeys = new Set<string>();
  readonly requests: { method: string; path: string; key: string }[] = [];
  // Fail a required detail read after the candidate search has succeeded.
  unreadableDetailsFor = new Set<number>();
  readonly failedDetails: number[] = [];
  candidatePageSize?: number;
  failCandidateContinuation = false;
  readonly candidatePages: (
    | { offset: number; status: 200; bugIds: number[] }
    | { offset: number; status: 503 }
  )[] = [];
  beforeBugUpdate?: (bug: Bug) => void;
  readonly visibleAt = new Map<number, number>();
  private nextId = 37001;
  private nextComment = 45001;

  constructor(readonly now: () => number) {}

  addBug(severity: string | null = "normal", time = this.now(), lagMs = 0) {
    const id = this.nextId++;
    const bug: Bug = {
      id,
      creator: actor,
      assigned_to: actor,
      creation_time: iso(time),
      last_change_time: iso(time),
      summary: `Fixture report ${id}`,
      product,
      component,
      status: "NEW",
      resolution: "",
      priority: "P2",
      version: "1",
      ...(severity === null ? {} : { severity }),
    };
    this.bugs.set(id, bug);
    this.visibleAt.set(id, time + lagMs);
    return bug;
  }

  addComment(bug: Bug, text: string, isPrivate = true) {
    const time = iso(this.now());
    const comment: Comment = {
      id: this.nextComment++,
      bug_id: bug.id,
      creator: actor,
      time,
      creation_time: time,
      text,
      is_private: isPrivate,
      count: this.comments.filter((c) => c.bug_id === bug.id).length + 1,
    };
    this.comments.push(comment);
    bug.last_change_time = time;
    return comment;
  }

  update(bug: Bug, field: "priority" | "status", added: string) {
    const removed = bug[field];
    const when = iso(this.now());
    bug[field] = added;
    bug.last_change_time = when;
    const entries = this.history.get(bug.id) ?? [];
    entries.push({ when, who: actor, changes: [{ field_name: field, removed, added }] });
    this.history.set(bug.id, entries);
    return { [field]: { removed, added } };
  }

  requestInfo(bug: Bug, requestee: string) {
    const when = iso(this.now());
    bug.last_change_time = when;
    const added = `needinfo?(${requestee})`;
    const entries = this.history.get(bug.id) ?? [];
    entries.push({
      when,
      who: actor,
      changes: [{ field_name: "flagtypes.name", removed: "", added }],
    });
    this.history.set(bug.id, entries);
    const flags = bug.flags ?? [];
    flags.push({ id: flags.length + 1, name: "needinfo", status: "?", requestee, setter: actor });
    bug.flags = flags;
    return { "flagtypes.name": { removed: "", added } };
  }

  private canRead(id: number) {
    return (
      this.bugs.has(id) && !this.hiddenBugs.has(id) && (this.visibleAt.get(id) ?? 0) <= this.now()
    );
  }

  readonly server = createServer(async (req, res) => {
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname.replace(/^\/rest\/?/, "").replace(/\/$/, "");
      const key = String(
        req.headers["x-bugzilla-api-key"] ?? url.searchParams.get("api_key") ?? "",
      );
      const method = req.method ?? "GET";
      this.requests.push({ method, path, key });
      if (path === "version") return send(200, { version: "5.2.1" });
      if (![apiKey("alice"), apiKey("bob")].includes(key) || this.revokedKeys.has(key)) {
        return send(401, { error: true, code: 306, message: "API key unavailable" });
      }
      const user = {
        id: 17,
        name: actor,
        real_name: "Fixture user",
        login: actor,
        groups: [{ id: 9, name: "insidergroup" }],
      };
      if (path === "whoami" || path === "login") return send(200, user);
      if (path === "user" || path.startsWith("user/")) return send(200, { users: [user] });
      const q = url.searchParams;
      if (method === "GET" && path === "bug") {
        const since = q.get("last_change_time") ?? q.get("chfieldfrom");
        const items = [...this.bugs.values()]
          .filter(
            (bug) =>
              this.canRead(bug.id) &&
              (!since || Date.parse(bug.last_change_time) >= Date.parse(since)) &&
              (!q.has("id") ||
                q
                  .getAll("id")
                  .flatMap((s) => s.split(","))
                  .includes(String(bug.id))) &&
              (!q.has("product") || q.get("product") === bug.product),
          )
          .sort((a, b) => a.last_change_time.localeCompare(b.last_change_time) || a.id - b.id);
        const offset = Number(q.get("offset"));
        if (this.failCandidateContinuation && offset > 0) {
          this.candidatePages.push({ offset, status: 503 });
          return send(503, {
            error: true,
            code: 503,
            message: "Candidate page temporarily unavailable",
          });
        }
        const requested = Number(q.get("limit") ?? items.length);
        // Represent Bugzilla's server-side search result cap, not a client override.
        const limit = Math.min(requested, this.candidatePageSize ?? requested);
        const bugs = items.slice(offset, offset + limit);
        this.candidatePages.push({ offset, status: 200, bugIds: bugs.map((bug) => bug.id) });
        return send(200, { bugs });
      }
      if (method === "POST" && path === "bug") {
        const input = JSON.parse(await readBody(req));
        const bug = this.addBug(input.severity ?? "normal");
        bug.summary = input.summary;
        return send(200, { id: bug.id });
      }
      const byComment = /^bug\/comment\/(\d+)$/.exec(path);
      if (byComment) {
        const c = this.comments.find((item) => item.id === Number(byComment[1]));
        const visible = c && this.canRead(c.bug_id) && !this.hiddenComments.has(c.id);
        if (!visible) return send(404, { error: true, code: 111, message: "Comment unavailable" });
        return send(200, { comments: { [c.id]: c }, bugs: {} });
      }
      const route = /^bug\/(\d+)(?:\/(history|comment|attachment))?$/.exec(path);
      if (!route)
        return send(404, { error: true, code: 404, message: `Unknown fixture route ${path}` });
      const id = Number(route[1]);
      const bug = this.bugs.get(id);
      if (!bug || !this.canRead(id))
        return send(404, { error: true, code: 101, message: "Bug unavailable" });
      if (method === "POST" && route[2] === "comment") {
        const input = JSON.parse(await readBody(req));
        const comment = this.addComment(bug, input.comment, input.is_private === true);
        return send(200, { id: comment.id });
      }
      if (method === "PUT") {
        const input = JSON.parse(await readBody(req));
        this.beforeBugUpdate?.(bug);
        const field = typeof input.priority === "string" ? "priority" : "status";
        const changes = Array.isArray(input.flags)
          ? this.requestInfo(bug, input.flags[0].requestee)
          : this.update(bug, field, input[field]);
        return send(200, { bugs: [{ id, last_change_time: bug.last_change_time, changes }] });
      }
      if (this.unreadableDetailsFor.has(id) && ["history", "comment"].includes(route[2] ?? "")) {
        this.failedDetails.push(id);
        return send(503, { error: true, code: 503, message: "Detail temporarily unavailable" });
      }
      if (route[2] === "history")
        return send(200, { bugs: [{ id, history: this.history.get(id) ?? [] }] });
      if (route[2] === "comment") {
        const comments = this.comments.filter(
          (c) => c.bug_id === id && !this.hiddenComments.has(c.id),
        );
        return send(200, { bugs: { [id]: { comments } }, comments: {} });
      }
      if (route[2] === "attachment") return send(200, { bugs: { [id]: [] }, attachments: {} });
      return send(200, { bugs: [bug] });
    } catch (error) {
      return send(500, { error: true, message: String(error) });
    }
  });
}
