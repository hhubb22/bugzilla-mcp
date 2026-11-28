import type { ClientCapabilities, PrincipalContext } from "../packages/contracts/src/index.js";
import { MCP_PROTOCOL_LEGACY, MCP_PROTOCOL_MODERN } from "../packages/contracts/src/index.js";
import { createDualEraHttpHandler } from "../packages/server/src/index.js";
import type {
  DualEraHttpRequest,
  DualEraHttpResponse,
  HttpServerConfig,
} from "../packages/server/src/index.js";
import { expect, test } from "vite-plus/test";
import {
  bugSummary,
  bugzilla,
  comment,
  dependencies,
  iso,
  manualClock,
  origin,
  principal,
} from "./helpers/fakes.js";

const bearer = "synthetic-mcp-bearer-alice";
const serviceUrl = "https://mcp.example";
const versionKey = "io.modelcontextprotocol/protocolVersion";
const capabilitiesKey = "io.modelcontextprotocol/clientCapabilities";
const authHeaders = {
  origin,
  authorization: `Bearer ${bearer}`,
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
};
const writeParams = {
  name: "bugzilla_post_analysis",
  arguments: {
    bugId: 41,
    idempotencyKey: "http-analysis",
    isPrivate: true,
    analysisMarkdown: "private test fixture",
  },
};

type RequestOptions = {
  id?: number;
  version?: string;
  capabilities?: ClientCapabilities;
  headers?: DualEraHttpRequest["headers"];
  name?: string;
  meta?: "none" | "no-version" | "no-capabilities";
};

function modern(
  method: string,
  params: Record<string, unknown> = {},
  options: RequestOptions = {},
): DualEraHttpRequest {
  const version = options.version ?? MCP_PROTOCOL_MODERN;
  const meta: Record<string, unknown> = {};
  if (options.meta !== "no-version") meta[versionKey] = version;
  if (options.meta !== "no-capabilities") meta[capabilitiesKey] = options.capabilities ?? {};
  const name = options.name ?? (typeof params.name === "string" ? params.name : undefined);
  return {
    method: "POST",
    path: "/mcp",
    headers: {
      ...authHeaders,
      "mcp-protocol-version": version,
      "mcp-method": method,
      "mcp-name": name,
      ...options.headers,
    },
    rawBody: JSON.stringify({
      jsonrpc: "2.0",
      id: options.id ?? 1,
      method,
      params: options.meta === "none" ? params : { ...params, _meta: meta },
    }),
  };
}

function rpc(response: DualEraHttpResponse): {
  jsonrpc?: string;
  id?: number;
  result?: {
    cursor?: string | null;
    ttlMs?: number;
    resultType?: string;
    requestState?: string;
    inputRequests?: Record<
      string,
      {
        method: string;
        params: { mode: string; url: string };
      }
    >;
  };
  error?: { code: number; data?: unknown };
} {
  const line = response.body.split("\n").find((entry) => entry.startsWith("data:"));
  return JSON.parse(line ? line.slice("data:".length) : response.body);
}

function header(response: DualEraHttpResponse, name: string) {
  return Object.entries(response.headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function server(overrides: Partial<HttpServerConfig> = {}) {
  const upstream = bugzilla();
  const config: HttpServerConfig = {
    mode: "cloud-multi-user",
    allowedOrigins: [origin],
    allowAbsentOrigin: true,
    eventsProfile: "sep-3415",
    publicBaseUrl: serviceUrl,
    core: dependencies(upstream.client),
    bindingSecret: "synthetic-binding-signing-key-used-only-in-tests",
    authenticateBearerToken: async (token) => (token === bearer ? principal : null),
    ...overrides,
  };
  return { handler: createDualEraHttpHandler(config), upstream };
}

function expectError(response: DualEraHttpResponse, code: number) {
  const envelope = rpc(response);
  expect(envelope).toMatchObject({ jsonrpc: "2.0", error: { code } });
  expect(envelope.result).toBeUndefined();
  return envelope.error;
}

// EVIDENCE-OF: R-d34daa
test.each(["https://different.example", "null"])(
  "Origin %s takes priority over malformed body, version and mirror headers",
  async (invalidOrigin) => {
    const { handler, upstream } = server();
    const write = modern("tools/call", writeParams, { headers: { origin: invalidOrigin } });
    for (const request of [
      write,
      { ...write, rawBody: "{" },
      modern("tools/call", writeParams, {
        version: "2099-01-01",
        headers: { origin: invalidOrigin, "mcp-name": undefined },
      }),
    ]) {
      expect((await handler.handleHttp(request)).status).toBe(403);
    }
    expect(upstream.mutations).toEqual([]);
  },
);

// EVIDENCE-OF: R-be7235
test("unsupported declared version precedes an invalid mirror header and reports supported and requested versions", async () => {
  const { handler, upstream } = server();
  const version = "2099-01-01";
  const response = await handler.handleHttp(
    modern("tools/call", writeParams, {
      version,
      headers: { "mcp-name": undefined, "mcp-protocol-version": MCP_PROTOCOL_MODERN },
    }),
  );
  expect(response.status).toBe(400);
  expect(expectError(response, -32022)?.data).toMatchObject({
    requested: version,
    supported: expect.arrayContaining([MCP_PROTOCOL_MODERN]),
  });
  expect(upstream.mutations).toEqual([]);
});

// EVIDENCE-OF: R-1120b2
test.each([
  {
    headerName: "mcp-protocol-version",
    malformed: "invalid version",
    mismatch: MCP_PROTOCOL_LEGACY,
  },
  { headerName: "mcp-method", malformed: "invalid method", mismatch: "tools/list" },
  { headerName: "mcp-name", malformed: "invalid tool", mismatch: "bugzilla_search" },
  { headerName: "mcp-param-isprivate", malformed: "not-a-boolean", mismatch: "false" },
])(
  "rejects each missing, malformed, and mismatched $headerName before a private write",
  async ({ headerName, malformed, mismatch }) => {
    const { handler, upstream } = server({
      headerRoutedParams: { bugzilla_post_analysis: ["isPrivate"] },
    });
    for (const value of [undefined, malformed, mismatch]) {
      const response = await handler.handleHttp(
        modern("tools/call", writeParams, {
          headers: { "mcp-param-isprivate": "true", [headerName]: value },
        }),
      );
      expect(response.status).toBe(400);
      expectError(response, -32020);
    }
    expect(upstream.mutations).toEqual([]);
    const valid = await handler.handleHttp(
      modern("tools/call", writeParams, { headers: { "mcp-param-isprivate": "true" } }),
    );
    expect(rpc(valid)).toMatchObject({ result: { resultType: "complete" } });
    expect(upstream.mutations.map(({ kind }) => kind)).toEqual(["private"]);
  },
);

// EVIDENCE-OF: R-80b183
test("public visibility on Safe-Auto is rejected at the HTTP input boundary", async () => {
  const { handler, upstream } = server();
  const response = await handler.handleHttp(
    modern("tools/call", {
      ...writeParams,
      arguments: { ...writeParams.arguments, isPrivate: false },
    }),
  );
  expect(response.status).toBe(200);
  expect(rpc(response)).toMatchObject({
    jsonrpc: "2.0",
    result: {
      isError: true,
      resultType: "complete",
      structuredContent: {
        error: true,
        code: "invalid_tool_input",
      },
    },
  });
  expect(upstream.mutations).toEqual([]);
});

// EVIDENCE-OF: R-8e6163
// EVIDENCE-OF: R-7c8831
test("legacy sessions are independent and cannot absorb malformed modern envelopes", async () => {
  const { handler, upstream } = server();
  function legacy(
    method: string,
    id: number | undefined,
    params: object,
    session?: string,
  ): DualEraHttpRequest {
    return {
      method: "POST",
      path: "/mcp",
      headers: {
        ...authHeaders,
        "mcp-protocol-version": MCP_PROTOCOL_LEGACY,
        "mcp-session-id": session,
      },
      rawBody: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    };
  }
  async function initialize(id: number) {
    const response = await handler.handleHttp(
      legacy("initialize", id, {
        protocolVersion: MCP_PROTOCOL_LEGACY,
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      }),
    );
    expect(rpc(response)).toMatchObject({ id, result: { protocolVersion: MCP_PROTOCOL_LEGACY } });
    const session = header(response, "mcp-session-id");
    expect(session).toEqual(expect.any(String));
    await handler.handleHttp(legacy("notifications/initialized", undefined, {}, session));
    return session;
  }
  const [first, second] = await Promise.all([initialize(11), initialize(12)]);
  expect(first).not.toBe(second);
  const [left, right, current] = await Promise.all([
    handler.handleHttp(legacy("tools/list", 13, {}, first)),
    handler.handleHttp(legacy("tools/list", 14, {}, second)),
    handler.handleHttp(modern("tools/list", {}, { id: 15, headers: { origin: undefined } })),
  ]);
  for (const [id, response] of [
    [13, left],
    [14, right],
  ] as const) {
    expect(rpc(response)).toMatchObject({ id, result: { tools: expect.any(Array) } });
    expect(rpc(response).result?.resultType).toBeUndefined();
  }
  expect(rpc(current)).toMatchObject({
    id: 15,
    result: { resultType: "complete", tools: expect.any(Array) },
  });
  for (const meta of ["none", "no-version", "no-capabilities"] as const) {
    const invalid = await handler.handleHttp(
      modern("tools/call", writeParams, { meta, headers: { "mcp-session-id": first } }),
    );
    expect(invalid.status).toBe(400);
    expectError(invalid, -32602);
  }
  expect(upstream.mutations).toEqual([]);
});

const resource = (id: number) =>
  modern("resources/read", { uri: `bugzilla://bug/${id}` }, { name: `bugzilla://bug/${id}` });
const dossier = (id: number, options: RequestOptions = {}) =>
  modern("tools/call", { name: "bugzilla_get_dossier", arguments: { bugId: id } }, options);

// EVIDENCE-OF: R-669595
test("private results and lookups are isolated by principal, instance and credential generation", async () => {
  const contexts: PrincipalContext[] = [
    principal,
    { ...principal, principalId: "bob" },
    { ...principal, instanceUrl: "https://other-bugzilla.example" },
    { ...principal, credentialGeneration: 2 },
  ];
  const upstreams = contexts.map(
    (_, index) =>
      bugzilla({
        async getBugDossierData(id) {
          return {
            bug: bugSummary(id, `authorized-view-${index}`),
            recentComments: [],
            recentHistory: [],
            attachments: [],
          };
        },
      }).client,
  );
  const tokens = contexts.map((_, index) => `synthetic-mcp-bearer-${index}`);
  const resolved: PrincipalContext[] = [];
  const { handler } = server({
    authenticateBearerToken: async (token) => contexts[tokens.indexOf(token)] ?? null,
    core: dependencies(bugzilla().client, {
      async resolveClient(...args) {
        const [ctx] = args;
        for (const token of tokens) expect(JSON.stringify(args)).not.toContain(token);
        resolved.push(ctx);
        const selected = contexts.findIndex(
          (candidate) =>
            candidate.principalId === ctx.principalId &&
            candidate.instanceUrl === ctx.instanceUrl &&
            candidate.credentialGeneration === ctx.credentialGeneration,
        );
        return upstreams[selected] ?? null;
      },
    }),
  });
  for (const index of [0, 1, 2, 3, 0, 3, 1, 2]) {
    const name = `authorized-view-${index}`;
    const request = resource(41);
    const call = (envelope: DualEraHttpRequest) =>
      handler.handleHttp({
        ...envelope,
        headers: { ...envelope.headers, authorization: `Bearer ${tokens[index]}` },
      });
    const [read, tool] = await Promise.all([call(request), call(dossier(41))]);
    const cached = rpc(read);
    expect(cached).toMatchObject({
      result: { resultType: "complete", cacheScope: "private", ttlMs: expect.any(Number) },
    });
    expect(cached.result?.ttlMs).toBeGreaterThanOrEqual(0);
    expect(rpc(tool)).toMatchObject({ result: { resultType: "complete" } });
    expect(rpc(tool).result).not.toHaveProperty("cacheScope");
    expect(rpc(tool).result).not.toHaveProperty("ttlMs");
    for (const response of [read, tool]) {
      expect(response.body).toContain(name);
      for (const token of tokens) expect(response.body).not.toContain(token);
      for (const other of [0, 1, 2, 3].filter((candidate) => candidate !== index)) {
        expect(response.body).not.toContain(`authorized-view-${other}`);
      }
    }
  }
  expect(resolved).toEqual(
    expect.arrayContaining(contexts.map((ctx) => expect.objectContaining(ctx))),
  );
});

// EVIDENCE-OF: R-32f1fc
test.each([
  ["resources/read", resource],
  ["bugzilla_get_dossier", dossier],
] as const)("%s gives missing and restricted targets the same JSON-RPC error", async (_, read) => {
  let restricted = false;
  const upstream = bugzilla({
    async checkVisibility(id) {
      return id === 41 && !restricted ? "visible" : "restricted_or_missing";
    },
    async getBugDossierData(id) {
      if (id !== 41 || restricted) return null;
      return {
        bug: bugSummary(id, "authorization-witness"),
        recentHistory: [],
        recentComments: [],
        attachments: [],
      };
    },
  });
  const { handler } = server({ core: dependencies(upstream.client) });
  const visible = await handler.handleHttp(read(41));
  expect(rpc(visible)).toMatchObject({ result: { resultType: "complete" } });
  expect(visible.body).toContain("authorization-witness");
  restricted = true;
  const [denied, missing] = await Promise.all([
    handler.handleHttp(read(41)),
    handler.handleHttp(read(42)),
  ]);
  const deniedError = expectError(denied, -32602);
  const missingError = expectError(missing, -32602);
  expect(denied.status).toBe(missing.status);
  expect(deniedError).toEqual(missingError);
  expect(denied.body).not.toContain("authorization-witness");
});

function bindingRequest(response: DualEraHttpResponse) {
  const { result } = rpc(response);
  expect(result).toMatchObject({ resultType: "input_required", requestState: expect.any(String) });
  expect(result?.requestState).toBeTruthy();
  expect(Object.keys(result?.inputRequests ?? {})).toHaveLength(1);
  const item = Object.entries(result?.inputRequests ?? {})[0];
  if (!item || !result?.requestState) throw new Error("Expected an actionable binding request");
  const [inputId, input] = item;
  expect(input).toMatchObject({ method: "elicitation/create", params: { mode: "url" } });
  const url = new URL(input.params.url);
  expect(url.origin).toBe(serviceUrl);
  expect(url.pathname).toBe("/bind");
  expect(url.searchParams.get("t")).toBeTruthy();
  return { inputId, state: result.requestState, url };
}

// EVIDENCE-OF: R-7c8831
// EVIDENCE-OF: R-3b4d46
test("URL elicitation depends on current request capabilities even with overlapping requests from one principal", async () => {
  const { handler } = server({
    core: dependencies(bugzilla().client, { resolveClient: async () => null }),
  });
  const responses = await Promise.all([
    handler.handleHttp(
      dossier(41, { id: 21, capabilities: { elicitation: { url: {}, form: {} } } }),
    ),
    handler.handleHttp(dossier(41, { id: 22, capabilities: { elicitation: { form: {} } } })),
    handler.handleHttp(dossier(41, { id: 23 })),
  ]);
  const [url, form, absent] = responses;
  if (!url || !form || !absent) throw new Error("Expected all three responses");
  bindingRequest(url);
  for (const [response, id] of [
    [form, 22],
    [absent, 23],
  ] as const) {
    expect(rpc(response)).toMatchObject({ id });
    expect(response.body).toContain("CredentialBindingRequired");
    expect(rpc(response).result?.inputRequests).toBeUndefined();
  }
});

function isComplete(response: DualEraHttpResponse) {
  if (response.status >= 300) return false;
  const envelope = rpc(response);
  return envelope.result?.resultType === "complete" && !envelope.error;
}

function bindingForm(html: string, apiKey: string) {
  const fields = new URLSearchParams();
  let keyName: string | undefined;
  for (const [tag] of html.matchAll(/<input\b[^>]*>/gi)) {
    const attrs = new Map<string, string>();
    for (const [, name, double, single] of tag.matchAll(
      /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g,
    )) {
      if (name) attrs.set(name.toLowerCase(), double ?? single ?? "");
    }
    const name = attrs.get("name");
    if (attrs.get("type") === "hidden" && name) fields.set(name, attrs.get("value") ?? "");
    if (name && attrs.get("type") !== "hidden") {
      if (attrs.get("type") === "password" || /key/i.test(name)) keyName = name;
    }
  }
  if (!keyName) throw new Error("Expected a credential input on the HTTPS binding page");
  fields.set(keyName, apiKey);
  return fields;
}

// EVIDENCE-OF: R-3b4d46
test("binding checks browser opener, ticket completion, retry context, expiry and single use", async () => {
  const clock = manualClock();
  const upstream = bugzilla();
  let bound = false;
  const key = "synthetic-bugzilla-key-fixture";
  const stores: string[] = [];
  const changedIdentities = new Map<string, PrincipalContext>([
    ["other-issuer", { ...principal, issuer: "https://other-identity.example" }],
    ["other-principal", { ...principal, principalId: "bob" }],
    ["other-client", { ...principal, clientId: "https://other-client.example/id" }],
    ["other-instance", { ...principal, instanceUrl: "https://other-bugzilla.example" }],
  ]);
  const { handler } = server({
    authenticateBearerToken: async (token) =>
      token === bearer
        ? { ...principal, credentialGeneration: bound ? 2 : 1 }
        : (changedIdentities.get(token) ?? null),
    verifyBindingOpenerSession: async (req) =>
      req.headers["x-fixture-opener"] === "alice"
        ? { issuer: principal.issuer, principalId: principal.principalId }
        : { issuer: principal.issuer, principalId: "bob" },
    storeBoundApiKey: async (ctx, apiKey) => {
      expect(ctx).toMatchObject({
        issuer: principal.issuer,
        principalId: principal.principalId,
        instanceUrl: principal.instanceUrl,
      });
      stores.push(apiKey);
      bound = true;
      return { credentialGeneration: 2 };
    },
    core: dependencies(upstream.client, {
      clock: clock.now,
      resolveClient: async (ctx) =>
        bound && ctx.credentialGeneration === 2 ? upstream.client : null,
    }),
  });
  const capabilities = { elicitation: { url: {} } };
  const expired = bindingRequest(await handler.handleHttp(dossier(41, { capabilities })));
  clock.advance(10 * 60 * 1000 + 1);
  const challenge = bindingRequest(await handler.handleHttp(dossier(41, { capabilities })));
  const openerRequest = (url: URL, opener: string): DualEraHttpRequest => ({
    method: "GET",
    path: url.pathname + url.search,
    rawBody: "",
    headers: { "x-fixture-opener": opener },
  });
  const retry = (token = bearer, bugId = 41, state = challenge.state, id = 31) =>
    handler.handleHttp(
      modern(
        "tools/call",
        {
          name: "bugzilla_get_dossier",
          arguments: { bugId },
          requestState: state,
          inputResponses: { [challenge.inputId]: { action: "accept" } },
        },
        { id, capabilities, headers: { authorization: `Bearer ${token}` } },
      ),
    );
  expect(isComplete(await retry())).toBe(false);
  expect(
    (await handler.handleHttp(openerRequest(expired.url, "alice"))).status,
  ).toBeGreaterThanOrEqual(400);
  expect(
    (await handler.handleHttp(openerRequest(challenge.url, "bob"))).status,
  ).toBeGreaterThanOrEqual(400);
  const page = await handler.handleHttp(openerRequest(challenge.url, "alice"));
  expect(page.status).toBe(200);
  const form = bindingForm(page.body, key);
  form.set("t", challenge.url.searchParams.get("t") ?? "");
  const post = (opener: string): DualEraHttpRequest => ({
    ...openerRequest(challenge.url, opener),
    method: "POST",
    rawBody: form.toString(),
    headers: {
      "x-fixture-opener": opener,
      "content-type": "application/x-www-form-urlencoded",
      origin: serviceUrl,
    },
  });
  expect((await handler.handleHttp(post("bob"))).status).toBeGreaterThanOrEqual(400);
  expect(stores).toEqual([]);
  const submitted = await handler.handleHttp(post("alice"));
  expect(submitted.status).toBeLessThan(400);
  expect(submitted.body).not.toContain(key);
  expect(stores).toEqual([key]);
  expect((await handler.handleHttp(post("alice"))).status).toBeGreaterThanOrEqual(400);
  for (const identity of changedIdentities.keys())
    expect(isComplete(await retry(identity))).toBe(false);
  expect(isComplete(await retry(bearer, 42))).toBe(false);
  expect(isComplete(await retry(bearer, 41, `${challenge.state}invalid`))).toBe(false);
  const outcomes = await Promise.all([
    retry(bearer, 41, challenge.state, 32),
    retry(bearer, 41, challenge.state, 33),
  ]);
  expect(outcomes.filter(isComplete)).toHaveLength(1);
  expect(outcomes.every((response) => !response.body.includes(key))).toBe(true);
  expect(isComplete(await retry(bearer, 41, challenge.state, 34))).toBe(false);
  expect(stores).toEqual([key]);
});

const eventName = "bugzilla.bug.commented";
const eventArgs = { includeSelf: false };
const eventPoll = (extra: Record<string, unknown> = {}, options: RequestOptions = {}) =>
  modern("events/poll", { name: eventName, arguments: eventArgs, ...extra }, options);

// EVIDENCE-OF: R-c83005
test("cursor errors distinguish malformed, foreign and obsolete schema epochs through HTTP", async () => {
  const deps = dependencies(bugzilla().client, { eventSchemaEpoch: 1 });
  const { handler } = server({
    core: deps,
    authenticateBearerToken: async (token) => {
      if (token === bearer) return principal;
      if (token === "other-view") return { ...principal, principalId: "bob" };
      if (token === "other-instance") return { ...principal, instanceUrl: "https://other.example" };
      return null;
    },
  });
  const start = rpc(await handler.handleHttp(eventPoll({ cursor: null }))).result;
  expect(start).toMatchObject({ resultType: "complete", cursor: expect.any(String) });
  const cursor = start?.cursor;
  if (!cursor) throw new Error("Expected an event resume cursor");
  for (const request of [
    eventPoll({ cursor: "malformed-cursor-fixture" }),
    eventPoll({ cursor, arguments: { ...eventArgs, product: "Other" } }),
    eventPoll({ cursor }, { headers: { authorization: "Bearer other-view" } }),
    eventPoll({ cursor }, { headers: { authorization: "Bearer other-instance" } }),
  ]) {
    expectError(await handler.handleHttp(request), -32602);
  }
  const upgraded = server({ core: { ...deps, eventSchemaEpoch: 2 } }).handler;
  const response = await upgraded.handleHttp(eventPoll({ cursor }));
  expect(expectError(response, -32026)?.data).toMatchObject({ reason: "schema_changed" });
});

// EVIDENCE-OF: R-cad0d6
test("poll reports Forbidden when the bound upstream credential is revoked", async () => {
  const clock = manualClock();
  const timestamp = iso(clock.now() + 1_000);
  let revoked = false;
  const upstream = bugzilla({
    async listChangesSince() {
      return { occurrences: revoked ? [comment(73, timestamp)] : [], scanComplete: true };
    },
    async checkVisibility() {
      return revoked ? "credential_revoked" : "visible";
    },
  });
  const { handler } = server({ core: dependencies(upstream.client, { clock: clock.now }) });
  const result = rpc(await handler.handleHttp(eventPoll())).result;
  expect(result).toMatchObject({ resultType: "complete", cursor: expect.any(String), events: [] });
  revoked = true;
  clock.advance(6_000);
  const response = await handler.handleHttp(eventPoll({ cursor: result?.cursor }));
  expectError(response, -32024);
  expect(response.body).not.toContain("comment text 73");
});

// EVIDENCE-OF: R-3be334, R-9f1561
test("ChatGPT discovery, webhook unsubscribe and callback errors use ChatGPT wire shapes", async () => {
  const { handler } = server({
    eventsProfile: "chatgpt-events",
    core: dependencies(bugzilla().client, {
      eventsProfile: "chatgpt-events",
      webhookTransport: {
        async resolveHost() {
          return ["1.1.1.1"];
        },
        async postPinned() {
          return { status: 503, body: "" };
        },
      },
    }),
  });
  const discover = rpc(await handler.handleHttp(modern("server/discover")));
  expect(discover).toMatchObject({
    result: { resultType: "complete", capabilities: { events: expect.anything() } },
  });
  const url = "https://callback.example/events";
  const params = { name: eventName, arguments: eventArgs, delivery: { url, mode: "webhook" } };
  const response = await handler.handleHttp(
    modern("events/subscribe", {
      ...params,
      delivery: { ...params.delivery, secret: `whsec_${Buffer.alloc(32, 13).toString("base64")}` },
    }),
  );
  expectError(response, -32015);
  for (const id of [51, 52]) {
    const envelope = rpc(await handler.handleHttp(modern("events/unsubscribe", params, { id })));
    expect(envelope).toEqual({ jsonrpc: "2.0", id, result: { resultType: "complete" } });
  }
});
