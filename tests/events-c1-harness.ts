import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vite-plus/test";
import type { WebhookPinnedRequest } from "../packages/core/src/index.js";
import { BugzillaFixture, listen, readBody } from "./events-c1-bugzilla.js";
import type { FixtureOptions } from "./events-c1-server.js";

export type Obj = Record<string, unknown>;
export function obj(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Expected object, received ${JSON.stringify(value)}`);
  return value as Obj;
}
export function rows(value: unknown): Obj[] {
  if (!Array.isArray(value)) throw new Error(`Expected array, received ${JSON.stringify(value)}`);
  return value.map(obj);
}
export function str(value: unknown): string {
  if (typeof value !== "string" || value.length === 0)
    throw new Error(`Expected nonempty string, received ${JSON.stringify(value)}`);
  return value;
}

export const created = "bugzilla.bug.created";
export const updated = "bugzilla.bug.updated";
export const commented = "bugzilla.bug.commented";
export const needinfo = "bugzilla.flag.needinfo";
export const callback = "https://receiver.example.test/events";
export const secret = "whsec_" + Buffer.alloc(32, 31).toString("base64");
export const newSecret = "whsec_" + Buffer.alloc(32, 97).toString("base64");
export function subscribe(name = created, args: Obj = {}, url = callback, key = secret) {
  return { name, arguments: args, delivery: { mode: "webhook", url, secret: key } };
}

export interface Send {
  request: WebhookPinnedRequest;
  body: Obj;
  headers: Headers;
  logicalTime: number;
  receivedAt: number;
}
export function occurrence(send: Send): Obj | undefined {
  // Accept an occurrence directly or as the event member of a transport envelope.
  const values = [send.body, ...Object.values(send.body)];
  return values.find(
    (v): v is Obj => !!v && typeof v === "object" && "eventId" in v && "name" in v,
  );
}
export interface Caller {
  tenant?: "alice" | "bob";
  session?: string;
}
export interface Reply {
  message: Obj;
  headers: Headers;
}
export function success({ message }: Reply): Obj {
  expect(message.error).toBeUndefined();
  return obj(message.result);
}
export function failure({ message }: Reply, code: number, reason?: string) {
  expect(message.error).toMatchObject(reason ? { code, data: { reason } } : { code });
  expect(message).not.toHaveProperty("result");
}

export async function until(check: () => void, label: string) {
  await expect
    .poll(
      () => {
        check();
        return true;
      },
      { timeout: 15_000, interval: 40, message: label },
    )
    .toBe(true);
}

export class Rig {
  readonly dir = mkdtempSync(join(tmpdir(), "events-c1-"));
  now = Math.floor(Date.now() / 1000) * 1000;
  readonly bz = new BugzillaFixture(() => this.now);
  readonly sends: Send[] = [];
  onSend: (send: Send) => { status: number; body?: string } | "hold" | "disconnect" = () => ({
    status: 204,
  });
  readonly receiver = createServer(async (req, res) => {
    const request: WebhookPinnedRequest = JSON.parse(await readBody(req));
    const send = {
      request,
      body: obj(JSON.parse(request.rawBody)),
      headers: new Headers(request.headers),
      logicalTime: this.now,
      receivedAt: Date.now(),
    };
    this.sends.push(send);
    const reply = this.onSend(send);
    if (reply === "hold") return; // intentionally unknown until the child is killed
    if (reply === "disconnect") return res.destroy();
    const body =
      reply.body ??
      (send.body.type === "verification" ? JSON.stringify({ challenge: send.body.challenge }) : "");
    res.writeHead(
      send.body.type === "verification" && reply.status === 204 && reply.body === undefined
        ? 200
        : reply.status,
      { "content-type": "application/json" },
    );
    res.end(body);
  });
  bugzilla = "";
  private receiverUrl = "";
  private child?: ChildProcess;
  private exited: Promise<void> = Promise.resolve();
  private output = "";
  logs = "";
  stderr = "";
  endpoint = "";
  private nextId = 1;
  constructor(public options: FixtureOptions) {
    this.tick(0);
  }

  tick(ms: number) {
    this.now += ms;
    writeFileSync(join(this.dir, "clock.next"), String(this.now));
    renameSync(join(this.dir, "clock.next"), join(this.dir, "clock"));
  }
  async open() {
    this.bugzilla = await listen(this.bz.server);
    this.receiverUrl = await listen(this.receiver);
  }
  async start() {
    this.output = "";
    this.endpoint = "";
    const launch = {
      ...this.options,
      directory: this.dir,
      bugzilla: this.bugzilla,
      receiver: this.receiverUrl,
    };
    const path = fileURLToPath(new URL("./events-c1-server.ts", import.meta.url));
    const child = spawn("bun", [path], {
      env: { PATH: process.env.PATH, NO_COLOR: "1", C1_LAUNCH: JSON.stringify(launch) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.exited = new Promise((resolve) => child.once("close", () => resolve()));
    const capture = (chunk: Buffer | string) => {
      const text = chunk.toString();
      this.output += text;
      this.logs += text;
    };
    child.stdout.on("data", capture);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      capture(chunk);
      this.stderr += chunk;
    });
    let launchError = "";
    child.on("error", (err) => {
      launchError = String(err);
    });
    await until(
      () =>
        expect(
          launchError ||
            this.output.includes("C1_READY ") ||
            child.exitCode !== null ||
            child.signalCode !== null,
        ).toBeTruthy(),
      "MCP process startup",
    );
    const failed = /^C1_START_FAILED (.+)$/m.exec(this.output);
    if (failed) throw Object.assign(new Error(failed[1]), obj(JSON.parse(str(failed[1]))));
    const ready = /^C1_READY (.+)$/m.exec(this.output);
    if (!ready) throw new Error(launchError || this.output);
    const info = obj(JSON.parse(str(ready[1])));
    const base = new URL(str(info.baseUrl));
    this.endpoint = new URL(
      base.pathname === "/" ? "/mcp" : base.pathname,
      `http://127.0.0.1:${info.port}`,
    ).href;
  }
  async stop(crash = false) {
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      if (crash) child.kill("SIGKILL");
      else child.stdin?.end();
      try {
        await until(
          () => expect(child.exitCode !== null || child.signalCode !== null).toBe(true),
          "MCP process exit",
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    }
    await this.exited;
  }
  async restart(crash = false) {
    await this.stop(crash);
    await this.start();
  }
  async dispose() {
    try {
      await this.stop(true);
    } finally {
      for (const server of [this.receiver, this.bz.server]) {
        if (!server.listening) continue;
        const closed = once(server, "close");
        server.close();
        server.closeAllConnections();
        await closed;
      }
      rmSync(this.dir, { recursive: true, force: true });
    }
  }

  async rpc(method: string, params: Obj = {}, caller: Caller = {}): Promise<Reply> {
    const modern = caller.session === undefined && method !== "initialize";
    const headers = new Headers({
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      origin: "https://triage.example.test",
      authorization: `Bearer fixture-token-${caller.tenant ?? "alice"}`,
    });
    if (modern) {
      headers.set("MCP-Protocol-Version", "2026-07-28");
      headers.set("Mcp-Method", method);
      if (typeof params.name === "string") headers.set("Mcp-Name", params.name);
      params = {
        ...params,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": capabilities(this.options.profile),
        },
      };
    }
    if (caller.session) {
      headers.set("Mcp-Session-Id", caller.session);
      headers.set("MCP-Protocol-Version", "2025-11-25");
    }
    const id = this.nextId++;
    const notification = method === "notifications/initialized";
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers,
      signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ jsonrpc: "2.0", ...(notification ? {} : { id }), method, params }),
    });
    const body = await response.text();
    if (notification && response.ok && !body) return { message: {}, headers: response.headers };
    const json = response.headers.get("content-type")?.includes("text/event-stream")
      ? body
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5)))
          .find((item) => item.id === id)
      : JSON.parse(body);
    const message = obj(json);
    if (!notification) expect(message).toMatchObject({ jsonrpc: "2.0", id });
    return { message, headers: response.headers };
  }

  async legacy(tenant: Caller["tenant"] = "alice") {
    const reply = await this.rpc(
      "initialize",
      {
        protocolVersion: "2025-11-25",
        capabilities: capabilities(this.options.profile),
        clientInfo: { name: "contract-test", version: "1" },
      },
      { tenant },
    );
    const result = success(reply);
    expect(result.protocolVersion).toBe("2025-11-25");
    const caller = { tenant, session: str(reply.headers.get("mcp-session-id")) };
    await this.rpc("notifications/initialized", {}, caller);
    return { caller, capabilities: obj(result.capabilities) };
  }
  async poll(
    name: string,
    args: Obj,
    cursor?: string | null,
    options: Obj = {},
    caller: Caller = {},
  ) {
    return success(
      await this.rpc(
        "events/poll",
        {
          name,
          arguments: args,
          ...(cursor === undefined ? {} : { cursor }),
          ...options,
        },
        caller,
      ),
    );
  }
  async tool(name: string, args: Obj, caller: Caller = {}) {
    const result = success(await this.rpc("tools/call", { name, arguments: args }, caller));
    expect(result.isError).not.toBe(true);
    if (result.structuredContent !== undefined) return obj(result.structuredContent);
    const text = rows(result.content).find((item) => item.type === "text")?.text;
    return obj(JSON.parse(str(text)));
  }
  events(url = callback) {
    return this.sends.filter((s) => s.request.url === url && occurrence(s) !== undefined);
  }
  async sent(count: number, url = callback) {
    await until(
      () => expect(this.events(url).length).toBeGreaterThanOrEqual(count),
      `${count} event callbacks at ${url}`,
    );
    return this.events(url);
  }
}

function capabilities(profile: FixtureOptions["profile"]) {
  return profile === "sep-3415"
    ? { extensions: { "io.modelcontextprotocol/events": {} } }
    : { events: {} };
}
