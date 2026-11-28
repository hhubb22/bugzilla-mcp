import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createRpcGate } from "../packages/app-ui/src/web/concurrency.js";
import { createBugzillaClient } from "../packages/bugzilla-client/src/index.js";
import { MCP_PROTOCOL_MODERN, type PrincipalContext } from "../packages/contracts/src/index.js";
import {
  createCloudApprovalTokenService,
  createSyntheticEventsService,
} from "../packages/core/src/index.js";
import {
  createEncryptedCredentialVault,
  type HttpServerConfig,
  runStdioServer,
  startMcpHttpServer,
} from "../packages/server/src/index.js";
import { createSqliteStorage } from "../packages/storage/src/index.js";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const BZ_URL = process.env.E2E_BUGZILLA_URL ?? "http://127.0.0.1:18080";
const ADMIN_KEY = process.env.E2E_ADMIN_API_KEY ?? "bz_e2e_admin_api_key_0123456789abcdef";
const REPORTER_KEY = process.env.E2E_REPORTER_API_KEY ?? "bz_e2e_reporter_api_key_fedcba9876543210";

const SIGNING_SECRET = "e2e-signing-secret-0123456789abcdef0123456789abcdef";

const adminPrincipal: PrincipalContext = {
  issuer: "https://auth.e2e.local",
  principalId: "admin@bugzilla.local",
  clientId: "https://client.e2e.local/meta.json",
  instanceUrl: BZ_URL,
  credentialGeneration: 1,
  scopes: ["bz:read", "bz:write:safe", "bz:write:guarded", "bz:events"],
  deploymentMode: "cloud-multi-user",
};

const reporterPrincipal: PrincipalContext = {
  issuer: "https://auth.e2e.local",
  principalId: "reporter@bugzilla.local",
  clientId: "https://client.e2e.local/meta.json",
  instanceUrl: BZ_URL,
  credentialGeneration: 1,
  scopes: ["bz:read", "bz:write:safe", "bz:write:guarded", "bz:events"],
  deploymentMode: "cloud-multi-user",
};

function modernHeaders(token: string, method: string, name?: string): Record<string, string> {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
    origin: "https://app.e2e.local",
    "mcp-protocol-version": MCP_PROTOCOL_MODERN,
    "mcp-method": method,
    ...(name !== undefined ? { "mcp-name": name } : {}),
  };
}

function modernMeta() {
  return {
    "io.modelcontextprotocol/protocolVersion": MCP_PROTOCOL_MODERN,
    "io.modelcontextprotocol/clientCapabilities": {
      elicitation: { url: {} },
    },
  };
}

describe("Live OrbStack Bugzilla 5.2 Zero-Mock E2E", () => {
  let tmpDir: string;
  let dbPath: string;
  let serverUrl: string;
  let closeServer: () => Promise<void>;
  let createdBugId: number;

  const adminClient = createBugzillaClient({
    baseUrl: BZ_URL,
    apiKey: ADMIN_KEY,
    allowQueryFallback: true,
  });
  const reporterClient = createBugzillaClient({
    baseUrl: BZ_URL,
    apiKey: REPORTER_KEY,
    allowQueryFallback: true,
  });

  beforeAll(async () => {
    // Sanity-check that live OrbStack Bugzilla 5.2 is reachable
    const versionRes = await fetch(`${BZ_URL}/rest/version`);
    expect(versionRes.status).toBe(200);
    const verJson = (await versionRes.json()) as { version: string };
    expect(verJson.version).toMatch(/^5\./);

    tmpDir = mkdtempSync(join(tmpdir(), "bz-mcp-e2e-"));
    dbPath = join(tmpDir, "state.sqlite");
    const storage = createSqliteStorage(dbPath);
    const cloudApprovalService = createCloudApprovalTokenService(SIGNING_SECRET, storage);

    const config: HttpServerConfig = {
      mode: "cloud-multi-user",
      allowedOrigins: ["https://app.e2e.local"],
      allowAbsentOrigin: false,
      eventsProfile: "sep-3415",
      publicBaseUrl: "http://127.0.0.1",
      bindingSecret: SIGNING_SECRET,
      authenticateBearerToken: async (token) => {
        if (token === "tok-admin") return adminPrincipal;
        if (token === "tok-reporter") return reporterPrincipal;
        return null;
      },
      verifyBindingOpenerSession: async (req) => {
        const who = req.headers["x-e2e-session-user"];
        if (who === "admin") {
          return { issuer: adminPrincipal.issuer, principalId: adminPrincipal.principalId };
        }
        return null;
      },
      core: {
        storage,
        resolveClient: async (ctx) => {
          if (ctx.principalId === adminPrincipal.principalId) return adminClient;
          if (ctx.principalId === reporterPrincipal.principalId) return reporterClient;
          return null;
        },
        lagWindowMs: 0,
        causalBudgetPerBug: 10,
        causalBudgetWindowMs: 60_000,
        eventsProfile: "sep-3415",
        cloudApprovalService,
      },
    };

    const running = await startMcpHttpServer({ config, host: "127.0.0.1", port: 0 });
    serverUrl = running.baseUrl;
    // Align publicBaseUrl for /approve origin checks using running baseUrl
    await running.close();

    const finalRunning = await startMcpHttpServer({
      config: { ...config, publicBaseUrl: `http://127.0.0.1:${running.port}` },
      host: "127.0.0.1",
      port: running.port,
    });
    serverUrl = finalRunning.baseUrl;
    closeServer = finalRunning.close;
  }, 20_000);

  afterAll(async () => {
    await closeServer?.();
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  async function rpcCall(
    token: string,
    method: string,
    params: Record<string, unknown>,
    headerName?: string,
  ) {
    const res = await fetch(`${serverUrl}/mcp`, {
      method: "POST",
      headers: modernHeaders(token, method, headerName),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: randomUUID(),
        method,
        params: { ...params, _meta: modernMeta() },
      }),
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  }

  it("probes real Bugzilla 5.2 capabilities & enforces security-group ACLs and revoked key classification", async () => {
    const adminCaps = await adminClient.probeCapabilities();
    expect(adminCaps.version).toBe("5.2");
    expect(adminCaps.authenticatedUser).toBe("admin@bugzilla.local");
    expect(adminCaps.isInsider).toBe(true);

    const reporterCaps = await reporterClient.probeCapabilities();
    expect(reporterCaps.authenticatedUser).toBe("reporter@bugzilla.local");
    expect(reporterCaps.isInsider).toBe(false);

    // Bug #2 is restricted to sec-private: visible to admin, restricted for reporter
    expect(await adminClient.checkVisibility(2)).toBe("visible");
    expect(await reporterClient.checkVisibility(2)).toBe("restricted_or_missing");

    // Invalid API key must classify as credential_revoked (Bugzilla 5.2 returns HTTP 400 code 306)
    const badClient = createBugzillaClient({
      baseUrl: BZ_URL,
      apiKey: "invalid_revoked_key_000",
      allowQueryFallback: true,
    });
    expect(await badClient.checkVisibility(1)).toBe("credential_revoked");
  });

  it("serves real single-file MCP App HTML, tools catalog, search, dossier, attachment excerpt, and hides restricted bugs", async () => {
    const listToolsRes = await rpcCall("tok-admin", "tools/list", {});
    expect(listToolsRes.status).toBe(200);
    const toolsJson = JSON.parse(listToolsRes.text) as {
      result: { tools: Array<{ name: string }> };
    };
    const names = toolsJson.result.tools.map((t) => t.name);
    expect(names).toContain("bugzilla_triage_board");
    expect(names).toContain("bugzilla_get_attachment_excerpt");
    expect(names).toContain("app_save_draft");
    expect(names).toContain("app_resolve_proposal");

    // Read built single-file MCP App HTML via resources/read
    const appRes = await rpcCall(
      "tok-admin",
      "resources/read",
      { uri: "ui://bugzilla/triage-app.html" },
      "ui://bugzilla/triage-app.html",
    );
    expect(appRes.status).toBe(200);
    const appJson = JSON.parse(appRes.text) as {
      result: { contents: Array<{ mimeType: string; text: string }> };
    };
    const html = appJson.result.contents[0]!.text;
    expect(appJson.result.contents[0]!.mimeType).toBe("text/html;profile=mcp-app");
    expect(html).toContain('<meta name="color-scheme" content="light dark"');
    expect(html.length).toBeGreaterThan(50_000);
    expect(html.length).toBeLessThan(2 * 1024 * 1024);
    expect(html).not.toMatch(/<script[^>]+src="https?:\/\//i);

    // Search live Bugzilla bugs
    const searchRes = await rpcCall(
      "tok-admin",
      "tools/call",
      { name: "bugzilla_search", arguments: { product: "PICOS", limit: 10 } },
      "bugzilla_search",
    );
    const searchData = JSON.parse(searchRes.text) as {
      result: { structuredContent: { items: Array<{ id: number; summary: string }> } };
    };
    expect(searchData.result.structuredContent.items.some((b) => b.id === 1)).toBe(true);

    // Reporter CANNOT read restricted bug #2 via resources/read (indistinguishable error)
    const leakAttempt = await rpcCall(
      "tok-reporter",
      "resources/read",
      { uri: "bugzilla://bug/2" },
      "bugzilla://bug/2",
    );
    expect(leakAttempt.text).not.toContain("TOP-SECRET-EXPLOIT-DETAILS");
    expect(JSON.parse(leakAttempt.text).error.message).toBe("Resource not found or inaccessible");

    // Attachment excerpt on live Bug #1 (attachment id 1 = urpf-debug.log)
    const excerptRes = await rpcCall(
      "tok-admin",
      "tools/call",
      {
        name: "bugzilla_get_attachment_excerpt",
        arguments: { attachmentId: 1, byteOffset: 0, maxBytes: 42 },
      },
      "bugzilla_get_attachment_excerpt",
    );
    const excerpt = JSON.parse(excerptRes.text).result.structuredContent as {
      fileName: string;
      excerptText: string;
      truncated: boolean;
      untrustedUserContent: boolean;
    };
    expect(excerpt.fileName).toBe("urpf-debug.log");
    expect(excerpt.excerptText).toContain("ERROR urpf-daemon");
    expect(excerpt.truncated).toBe(true);
    expect(excerpt.untrustedUserContent).toBe(true);

    // Triage board accepts empty {} and stays compact (<= 128 KiB)
    const boardRes = await rpcCall(
      "tok-admin",
      "tools/call",
      { name: "bugzilla_triage_board", arguments: {} },
      "bugzilla_triage_board",
    );
    expect(Buffer.byteLength(boardRes.text, "utf8")).toBeLessThan(128 * 1024);
    const board = JSON.parse(boardRes.text).result.structuredContent as {
      bugs: Array<{ id: number }>;
    };
    expect(board.bugs.length).toBeGreaterThanOrEqual(2);
  });

  it("enforces Safe-Auto private comment for insider and fail-closed internal note for non-insider on live Bugzilla", async () => {
    const marker = `e2e-safe-auto-${randomUUID().slice(0, 8)}`;

    // 1. Admin (insider) posts REAL private comment to Bug #1
    const adminRes = await rpcCall(
      "tok-admin",
      "tools/call",
      {
        name: "bugzilla_post_analysis",
        arguments: {
          bugId: 1,
          idempotencyKey: `idem-insider-${randomUUID()}`,
          isPrivate: true,
          analysisMarkdown: `Private diagnosis ${marker}`,
        },
      },
      "bugzilla_post_analysis",
    );
    const adminOutcome = JSON.parse(adminRes.text).result.structuredContent as {
      outcome: string;
      artifactId: string;
    };
    expect(adminOutcome.outcome).toBe("Applied");
    const commentMatch = /^comment:(\d+)$/.exec(adminOutcome.artifactId);
    expect(commentMatch?.[1]).toBeTruthy();
    const commentId = Number(commentMatch![1]);
    expect(commentId).toBeGreaterThan(0);

    // Verify directly in Bugzilla 5.2 that the comment is truly marked is_private=true
    const liveDossier = await adminClient.getBugDossierData(1, { maxComments: 50, maxHistory: 0 });
    const posted = liveDossier?.recentComments.find((c) => c.id === commentId);
    expect(posted?.isPrivate).toBe(true);
    expect(posted?.text).toContain(marker);

    // Verify non-insider reporter CANNOT see the private comment in Bugzilla
    const reporterBefore = await reporterClient.getBugDossierData(1, {
      maxComments: 50,
      maxHistory: 0,
    });
    expect(reporterBefore?.recentComments.some((c) => c.id === commentId)).toBe(false);
    const countBefore = reporterBefore?.recentComments.length ?? 0;

    // 2. Reporter (non-insider) calls Safe-Auto -> MUST fail closed to SavedAsInternalNote (zero public write!)
    const repMarker = `e2e-non-insider-${randomUUID().slice(0, 8)}`;
    const repRes = await rpcCall(
      "tok-reporter",
      "tools/call",
      {
        name: "bugzilla_post_analysis",
        arguments: {
          bugId: 1,
          idempotencyKey: `idem-reporter-${randomUUID()}`,
          isPrivate: true,
          analysisMarkdown: `Non-insider draft ${repMarker}`,
        },
      },
      "bugzilla_post_analysis",
    );
    const repOutcome = JSON.parse(repRes.text).result.structuredContent as {
      outcome: string;
      reason: string;
    };
    expect(repOutcome.outcome).toBe("SavedAsInternalNote");
    expect(repOutcome.reason).toBe("non_insider");

    const reporterAfter = await reporterClient.getBugDossierData(1, {
      maxComments: 50,
      maxHistory: 0,
    });
    expect(reporterAfter?.recentComments.length).toBe(countBefore);
  }, 20_000);

  it("creates a bug idempotently, rejects missing fields and HTTP 400 without key poisoning, executes Guarded-Write via /approve token, persists JTI across restart, and detects real StaleBugConflict", async () => {
    // Missing required component/version MUST return isError: true with structured issues (0 upstream writes)
    const missingFieldRes = await rpcCall(
      "tok-admin",
      "tools/call",
      {
        name: "bugzilla_create_bug",
        arguments: {
          idempotencyKey: `idem-missing-${randomUUID()}`,
          product: "PICOS",
          summary: "Missing component and version",
          description: "Should fail validation before calling Bugzilla",
        },
      },
      "bugzilla_create_bug",
    );
    expect(missingFieldRes.status).toBe(200);
    const missingRpc = JSON.parse(missingFieldRes.text) as {
      result: {
        isError: boolean;
        structuredContent: { code: string; issues: Array<{ path: string }> };
      };
    };
    expect(missingRpc.result.isError).toBe(true);
    expect(missingRpc.result.structuredContent.code).toBe("invalid_tool_input");
    const missingPaths = missingRpc.result.structuredContent.issues.map((i) => i.path);
    expect(missingPaths).toContain("component");
    expect(missingPaths).toContain("version");

    // Upstream HTTP 400 (nonexistent component) MUST return UpstreamRejected (isError: true)
    // and allow reusing the exact same idempotencyKey after fixing the field
    const createKey = `idem-create-${randomUUID()}`;
    const badCreateRes = await rpcCall(
      "tok-admin",
      "tools/call",
      {
        name: "bugzilla_create_bug",
        arguments: {
          idempotencyKey: createKey,
          product: "PICOS",
          component: "NonExistentComponentXYZ",
          version: "1.0",
          summary: "Invalid component 400 test",
          description: "Bugzilla rejects with HTTP 400; key must remain reusable",
        },
      },
      "bugzilla_create_bug",
    );
    expect(badCreateRes.status).toBe(200);
    const badCreateRpc = JSON.parse(badCreateRes.text) as {
      result: { isError: boolean; structuredContent: { outcome: string; effectCertainty: string } };
    };
    expect(badCreateRpc.result.isError).toBe(true);
    expect(badCreateRpc.result.structuredContent).toMatchObject({
      outcome: "UpstreamRejected",
      effectCertainty: "none",
    });

    const createArgs = {
      idempotencyKey: createKey,
      product: "PICOS",
      component: "Routing",
      version: "1.0",
      summary: `E2E live bug ${randomUUID().slice(0, 8)}`,
      description: "Created by zero-mock live E2E test",
      severity: "normal",
      priority: "Normal",
    };

    const c1 = await rpcCall(
      "tok-admin",
      "tools/call",
      { name: "bugzilla_create_bug", arguments: createArgs },
      "bugzilla_create_bug",
    );
    const c1Out = JSON.parse(c1.text).result.structuredContent as {
      outcome: string;
      artifactId: string;
    };
    expect(c1Out.outcome).toBe("Applied");
    const bugMatch = /^bug:(\d+)$/.exec(c1Out.artifactId);
    expect(bugMatch?.[1]).toBeTruthy();
    createdBugId = Number(bugMatch![1]);

    // Idempotent replay MUST return DuplicateNoOp with the exact same bug artifactId
    const c2 = await rpcCall(
      "tok-admin",
      "tools/call",
      { name: "bugzilla_create_bug", arguments: createArgs },
      "bugzilla_create_bug",
    );
    const c2Out = JSON.parse(c2.text).result.structuredContent as {
      outcome: string;
      originalArtifactId: string;
    };
    expect(c2Out.outcome).toBe("DuplicateNoOp");
    expect(c2Out.originalArtifactId).toBe(`bug:${createdBugId}`);

    // Fetch live last_change_time and propose a Guarded-Write update
    const initialBug = await adminClient.getBugDossierData(createdBugId, {
      maxComments: 5,
      maxHistory: 5,
    });
    const baseTime = initialBug!.bug.lastChangeTime;

    const propRes = await rpcCall(
      "tok-admin",
      "tools/call",
      {
        name: "bugzilla_propose_update",
        arguments: {
          bugId: createdBugId,
          idempotencyKey: `idem-prop-${randomUUID()}`,
          expectedLastChangeTime: baseTime,
          diff: { priority: "High", publicComment: "Confirmed via live E2E approval flow." },
          rationale: "Escalate priority after live triage",
        },
      },
      "bugzilla_propose_update",
    );
    const propOut = JSON.parse(propRes.text).result.structuredContent as {
      outcome: string;
      proposalId: string;
      revision: number;
      approvalUrl: string;
    };
    expect(propOut.outcome).toBe("ProposalPending");
    expect(propOut.approvalUrl).toContain("/approve?t=");

    // Human opens GET /approve?t=... with authenticated session and submits POST /approve
    const approvePath = new URL(propOut.approvalUrl).pathname + new URL(propOut.approvalUrl).search;
    const getPage = await fetch(`${serverUrl}${approvePath}`, {
      headers: { "x-e2e-session-user": "admin" },
    });
    expect(getPage.status).toBe(200);
    const pageHtml = await getPage.text();
    const csrfMatch = /name="csrf" value="([^"]+)"/.exec(pageHtml);
    const ticketMatch = /name="t" value="([^"]+)"/.exec(pageHtml);
    expect(csrfMatch?.[1]).toBeTruthy();
    expect(ticketMatch?.[1]).toBeTruthy();

    const postPage = await fetch(`${serverUrl}${approvePath}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: serverUrl,
        "x-e2e-session-user": "admin",
      },
      body: new URLSearchParams({
        t: ticketMatch![1]!,
        csrf: csrfMatch![1]!,
        decision: "approve",
      }).toString(),
    });
    expect(postPage.status).toBe(200);
    const { approvalToken } = (await postPage.json()) as { approvalToken: string };

    // Execute app_resolve_proposal using the server-signed single-use approval token
    const resolveRes = await rpcCall(
      "tok-admin",
      "tools/call",
      {
        name: "app_resolve_proposal",
        arguments: {
          proposalId: propOut.proposalId,
          revision: propOut.revision,
          decision: "approve",
          idempotencyKey: `idem-resolve-${randomUUID()}`,
          approval: { kind: "cloud_signed_token", token: approvalToken },
        },
      },
      "app_resolve_proposal",
    );
    const resolveOut = JSON.parse(resolveRes.text).result.structuredContent as {
      outcome: string;
      updatedLastChangeTime: string;
    };
    expect(resolveOut.outcome).toBe("Applied");

    // Verify directly in Bugzilla 5.2 that priority became High
    const afterUpdate = await adminClient.getBugDossierData(createdBugId, {
      maxComments: 10,
      maxHistory: 10,
    });
    expect(afterUpdate?.bug.priority).toBe("High");

    // Verify JTI replay is STILL rejected across a simulated process restart (fresh SQLite + ApprovalService)
    const restartedStorage = createSqliteStorage(dbPath);
    const restartedApproval = createCloudApprovalTokenService(SIGNING_SECRET, restartedStorage);
    const replayCheck = await restartedApproval.verifyAndConsume(approvalToken, {
      approverIssuer: adminPrincipal.issuer,
      approverPrincipalId: adminPrincipal.principalId,
      instanceUrl: BZ_URL,
      proposalId: propOut.proposalId,
      revision: propOut.revision,
      bugId: createdBugId,
      baseVersion: baseTime,
      diff: { priority: "High", publicComment: "Confirmed via live E2E approval flow." },
      visibility: "public",
      nowMs: Date.now(),
    });
    expect(replayCheck).toEqual({ valid: false, reason: "replayed" });

    // Real StaleBugConflict: create proposal against current time, externally mutate bug in Bugzilla, then resolve
    const staleBase = afterUpdate!.bug.lastChangeTime;
    const prop2Res = await rpcCall(
      "tok-admin",
      "tools/call",
      {
        name: "bugzilla_propose_update",
        arguments: {
          bugId: createdBugId,
          idempotencyKey: `idem-prop2-${randomUUID()}`,
          expectedLastChangeTime: staleBase,
          diff: { priority: "Low" },
          rationale: "Downgrade priority",
        },
      },
      "bugzilla_propose_update",
    );
    const prop2 = JSON.parse(prop2Res.text).result.structuredContent as {
      proposalId: string;
      revision: number;
      approvalUrl: string;
    };
    const approvePath2 = new URL(prop2.approvalUrl).pathname + new URL(prop2.approvalUrl).search;
    const p2Html = await (
      await fetch(`${serverUrl}${approvePath2}`, { headers: { "x-e2e-session-user": "admin" } })
    ).text();
    const csrf2 = /name="csrf" value="([^"]+)"/.exec(p2Html)![1]!;
    const t2 = /name="t" value="([^"]+)"/.exec(p2Html)![1]!;
    const { approvalToken: token2 } = (await (
      await fetch(`${serverUrl}${approvePath2}`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: serverUrl,
          "x-e2e-session-user": "admin",
        },
        body: new URLSearchParams({ t: t2, csrf: csrf2, decision: "approve" }).toString(),
      })
    ).json()) as { approvalToken: string };

    // Wait >1s so Bugzilla's 1-second resolution last_change_time advances on external human edit
    await new Promise((r) => setTimeout(r, 1200));
    await adminClient.applyBugUpdate(createdBugId, {
      publicComment: "External human edit creating a real stale conflict",
    });

    const staleResolve = await rpcCall(
      "tok-admin",
      "tools/call",
      {
        name: "app_resolve_proposal",
        arguments: {
          proposalId: prop2.proposalId,
          revision: prop2.revision,
          decision: "approve",
          idempotencyKey: `idem-stale-resolve-${randomUUID()}`,
          approval: { kind: "cloud_signed_token", token: token2 },
        },
      },
      "app_resolve_proposal",
    );
    const staleOut = JSON.parse(staleResolve.text).result.structuredContent as {
      outcome: string;
      expectedLastChangeTime: string;
      actualLastChangeTime: string;
    };
    expect(staleOut.outcome).toBe("StaleBugConflict");
    expect(staleOut.actualLastChangeTime).not.toBe(staleOut.expectedLastChangeTime);
  }, 20_000);

  it("encrypts bound credentials with AES-256-GCM (zero plaintext in SQLite + WAL) and preserves monotonic generation across revoke/rebind", async () => {
    const vaultDbPath = join(tmpDir, "vault.sqlite");
    const storage1 = createSqliteStorage(vaultDbPath);
    const vault1 = createEncryptedCredentialVault("vault-master-key-xyz", storage1);
    const secretKey = "bz_super_secret_plaintext_key_99999";

    const stored = await vault1.storeApiKey({
      issuer: adminPrincipal.issuer,
      principalId: adminPrincipal.principalId,
      instanceUrl: BZ_URL,
      apiKey: secretKey,
    });
    expect(stored.credentialGeneration).toBe(1);

    // Inspect BOTH main SQLite file AND WAL bytes while connection is live (TEST-01)
    const scanDbAndWal = (path: string, needle: string): boolean => {
      const mainBytes = readFileSync(path).toString("latin1");
      const walPath = `${path}-wal`;
      const walBytes = existsSync(walPath) ? readFileSync(walPath).toString("latin1") : "";
      return mainBytes.includes(needle) || walBytes.includes(needle);
    };
    expect(scanDbAndWal(vaultDbPath, secretKey)).toBe(false);

    // Positive control: prove scanner detects plaintext stored in a disposable SQLite DB
    const controlPath = join(tmpDir, "control.sqlite");
    const controlStorage = createSqliteStorage(controlPath);
    await controlStorage.saveInternalNote(adminPrincipal.issuer, "u", BZ_URL, 1, secretKey);
    expect(scanDbAndWal(controlPath, secretKey)).toBe(true);

    // Decrypt across fresh storage instance
    const storage2 = createSqliteStorage(vaultDbPath);
    const vault2 = createEncryptedCredentialVault("vault-master-key-xyz", storage2);
    const loaded = await vault2.loadApiKey({
      issuer: adminPrincipal.issuer,
      principalId: adminPrincipal.principalId,
      instanceUrl: BZ_URL,
    });
    expect(loaded).toEqual({ apiKey: secretKey, credentialGeneration: 1 });

    // Revoke and rebind MUST NOT reset credentialGeneration back to 1 (AUTH-02)
    expect(
      await vault2.revokeApiKey({
        issuer: adminPrincipal.issuer,
        principalId: adminPrincipal.principalId,
        instanceUrl: BZ_URL,
      }),
    ).toBe(true);
    expect(
      await vault2.loadApiKey({
        issuer: adminPrincipal.issuer,
        principalId: adminPrincipal.principalId,
        instanceUrl: BZ_URL,
      }),
    ).toBeNull();
    const rebound = await vault2.storeApiKey({
      issuer: adminPrincipal.issuer,
      principalId: adminPrincipal.principalId,
      instanceUrl: BZ_URL,
      apiKey: "bz_second_secret_key_88888",
    });
    expect(rebound.credentialGeneration).toBeGreaterThan(1);
    expect(scanDbAndWal(vaultDbPath, "bz_second_secret_key_88888")).toBe(false);

    // Verify UI concurrency gate strictly enforces <= 3 reads and <= 1 write (<= 4 total: UI-01)
    const gate = createRpcGate();
    let maxReads = 0;
    let curReads = 0;
    let maxWrites = 0;
    let curWrites = 0;
    const gen = gate.currentGeneration();
    await Promise.all([
      ...Array.from({ length: 12 }, () =>
        gate.runRead(gen, async () => {
          curReads += 1;
          maxReads = Math.max(maxReads, curReads);
          await new Promise((r) => setTimeout(r, 5));
          curReads -= 1;
        }),
      ),
      ...Array.from({ length: 5 }, () =>
        gate.runWrite(gen, async () => {
          curWrites += 1;
          maxWrites = Math.max(maxWrites, curWrites);
          await new Promise((r) => setTimeout(r, 5));
          curWrites -= 1;
        }),
      ),
    ]);
    expect(maxReads).toBeLessThanOrEqual(3);
    expect(maxWrites).toBeLessThanOrEqual(1);
  });

  it("polls and streams live Bugzilla comment events while suppressing agent self-writes", async () => {
    // Wait 1.1s before taking initial cursor so prior edits sit strictly before cursor
    await new Promise((r) => setTimeout(r, 1100));

    const initPollRes = await rpcCall(
      "tok-admin",
      "events/poll",
      { name: "bugzilla.bug.commented", arguments: { product: "PICOS", bugIds: [createdBugId] } },
      "bugzilla.bug.commented",
    );
    const initCursor = JSON.parse(initPollRes.text).result.cursor as string;
    expect(initCursor).toBeTruthy();

    await new Promise((r) => setTimeout(r, 1100));

    // 1. Agent self-write via Safe-Auto (MUST be suppressed from events)
    const selfMarker = `self-suppressed-${randomUUID().slice(0, 8)}`;
    await rpcCall(
      "tok-admin",
      "tools/call",
      {
        name: "bugzilla_post_analysis",
        arguments: {
          bugId: createdBugId,
          idempotencyKey: `idem-self-evt-${randomUUID()}`,
          isPrivate: true,
          analysisMarkdown: selfMarker,
        },
      },
      "bugzilla_post_analysis",
    );

    // 2. External human comment directly on Bugzilla (MUST appear in events)
    const humanMarker = `human-comment-${randomUUID().slice(0, 8)}`;
    await adminClient.applyBugUpdate(createdBugId, { publicComment: humanMarker });

    await new Promise((r) => setTimeout(r, 1100));

    const pollRes = await rpcCall(
      "tok-admin",
      "events/poll",
      {
        name: "bugzilla.bug.commented",
        arguments: { product: "PICOS", bugIds: [createdBugId] },
        cursor: initCursor,
      },
      "bugzilla.bug.commented",
    );
    const pollData = JSON.parse(pollRes.text).result as {
      events: Array<{ data: { commentText?: string } }>;
    };
    const texts = pollData.events.map((e) => e.data.commentText ?? "");
    expect(texts.some((t) => t.includes(humanMarker))).toBe(true);
    expect(texts.some((t) => t.includes(selfMarker))).toBe(false);

    // Verify events/stream SSE endpoint emits valid text/event-stream frames
    const streamRes = await rpcCall(
      "tok-admin",
      "events/stream",
      {
        name: "bugzilla.bug.commented",
        arguments: { product: "PICOS", bugIds: [createdBugId] },
        cursor: initCursor,
      },
      "bugzilla.bug.commented",
    );
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get("content-type")).toContain("text/event-stream");
    const sseFrames = streamRes.text
      .split("\n\n")
      .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
      .filter((l): l is string => Boolean(l))
      .map((l) => JSON.parse(l.slice("data: ".length)) as Record<string, unknown>);
    const activeFrame = sseFrames.find((f) => f.method === "notifications/events/active");
    expect(activeFrame).toBeDefined();
    const eventFrames = sseFrames.filter((f) => f.method === "notifications/events/event");
    expect(
      eventFrames.some((f) => {
        const p = f.params as { data?: { commentText?: string }; subscriptionId?: string };
        return Boolean(p.subscriptionId) && Boolean(p.data?.commentText?.includes(humanMarker));
      }),
    ).toBe(true);
    expect(streamRes.text).not.toContain(selfMarker);
    // Correlated final JSON-RPC result frame must close the SSE stream (EVENT-01)
    expect(sseFrames.some((f) => f.result !== undefined)).toBe(true);

    // Also confirm events/list exposes rich inputSchema & payloadSchema
    const eventsSvc = createSyntheticEventsService({
      storage: createSqliteStorage(":memory:"),
      resolveClient: async () => adminClient,
      lagWindowMs: 0,
      causalBudgetPerBug: 5,
      eventsProfile: "sep-3415",
    });
    const catalog = eventsSvc.listEvents();
    expect(catalog.events[0]?.inputSchema).toBeDefined();
    expect(catalog.events[0]?.payloadSchema).toBeDefined();
  }, 20_000);

  it("handles local IDE stdio transport initialize -> tools/list -> tools/call -> resources/read against live Bugzilla", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) => {
      for (const l of chunk.toString("utf8").split("\n")) {
        if (l.trim()) lines.push(l);
      }
    });

    const storage = createSqliteStorage(":memory:");
    const stdioConfig: HttpServerConfig = {
      mode: "local-trusted-ide",
      allowedOrigins: [],
      eventsProfile: "sep-3415",
      core: {
        storage,
        resolveClient: async () => adminClient,
        lagWindowMs: 0,
        causalBudgetPerBug: 5,
        eventsProfile: "sep-3415",
      },
    };

    const runner = runStdioServer({
      config: stdioConfig,
      principal: { ...adminPrincipal, deploymentMode: "local-trusted-ide" },
      input,
      output,
    });

    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`,
    );
    input.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "bugzilla_search", arguments: { product: "PICOS", limit: 5 } } })}\n`,
    );
    input.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "resources/read", params: { uri: "ui://bugzilla/triage-app.html" } })}\n`,
    );
    input.end();
    await runner;

    expect(lines.length).toBe(4);
    const [r1, r2, r3, r4] = lines.map(
      (l) => JSON.parse(l) as { id: number; result: Record<string, unknown> },
    );
    expect(r1!.result.protocolVersion).toBe("2025-11-25");
    expect((r2!.result.tools as unknown[]).length).toBe(11);
    expect(
      (r3!.result.structuredContent as { items: unknown[] }).items.length,
    ).toBeGreaterThanOrEqual(1);
    expect((r4!.result.contents as Array<{ mimeType: string }>)[0]!.mimeType).toBe(
      "text/html;profile=mcp-app",
    );
  });
});
