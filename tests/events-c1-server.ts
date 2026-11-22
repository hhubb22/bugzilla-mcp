// Standalone fixture launcher for a real MCP process, including crash/reopen tests.
import { readFileSync } from "node:fs";
import { createBugzillaClient } from "../packages/bugzilla-client/src/index.js";
import type { EventsProfile, PrincipalContext } from "../packages/contracts/src/index.js";
import type { CoreDependencies, WebhookOutboundTransport } from "../packages/core/src/index.js";
import {
  createEncryptedCredentialVault,
  startMcpHttpServer,
  type HttpServerConfig,
} from "../packages/server/src/index.js";
import { createSqliteStorage } from "../packages/storage/src/index.js";

export interface FixtureOptions {
  profile: EventsProfile;
  webhookEnabled?: boolean;
  readOnly?: boolean;
  retries?: number;
  epoch?: number;
  noAuthentication?: boolean;
  local?: boolean;
  eventsScope?: boolean;
  defaultSender?: boolean;
  memoryOnly?: boolean;
}

interface Launch extends FixtureOptions {
  directory: string;
  bugzilla: string;
  receiver: string;
}

async function main() {
  const setup: Launch = JSON.parse(process.env.C1_LAUNCH!);
  const storage = createSqliteStorage(
    setup.memoryOnly ? ":memory:" : `${setup.directory}/events.db`,
  );
  const vault = createEncryptedCredentialVault(
    "only-for-c1-synthetic-fixtures-0123456789",
    storage,
  );
  const principals = new Map<string, PrincipalContext>();
  for (const tenant of ["alice", "bob"]) {
    // Equal subjects from different issuers are distinct tenants.
    const scope = {
      issuer: `https://${tenant}.example.test`,
      principalId: "operator",
      instanceUrl: setup.bugzilla,
    };
    const binding =
      (await vault.loadApiKey(scope)) ??
      (await vault.storeApiKey({
        ...scope,
        apiKey: `fixture-bugzilla-key-${tenant}`,
      }));
    principals.set(`fixture-token-${tenant}`, {
      ...scope,
      credentialGeneration: binding.credentialGeneration,
      clientId: "triage-test",
      scopes: ["bz:read", "bz:events", "bz:write:safe", "bz:write:guarded"],
      deploymentMode: "cloud-multi-user",
    });
  }

  const transport: WebhookOutboundTransport = {
    resolveHost: async () => ["93.184.216.34"],
    async postPinned(request) {
      // Only this loopback receiver sees the prepared request. Never dial request.url.
      const response = await fetch(setup.receiver, {
        method: "POST",
        body: JSON.stringify(request),
      });
      return { status: response.status, body: await response.text() };
    },
  };
  const core: CoreDependencies = {
    storage,
    eventsProfile: setup.profile,
    lagWindowMs: 2000,
    maxReplayWindowMs: 600_000,
    causalBudgetPerBug: 2,
    causalBudgetWindowMs: 60_000,
    secretRotationGraceMs: 60_000,
    clock: () => Number(readFileSync(`${setup.directory}/clock`, "utf8")),
    resolveClient: async (ctx: PrincipalContext) => {
      const bound = await vault.loadApiKey(ctx);
      return bound && createBugzillaClient({ baseUrl: ctx.instanceUrl, apiKey: bound.apiKey });
    },
    isPolicyGranted: async () => true,
    ...(setup.epoch === undefined ? {} : { eventSchemaEpoch: setup.epoch }),
    ...(setup.retries === undefined ? {} : { maxWebhookRetries: setup.retries }),
    ...(setup.defaultSender ? {} : { webhookTransport: transport }),
  };
  const config: HttpServerConfig & { webhookEnabled?: boolean; readOnly?: boolean } = {
    mode: setup.local || setup.noAuthentication ? "local-trusted-ide" : "cloud-multi-user",
    eventsProfile: setup.profile,
    core,
    allowedOrigins: ["https://triage.example.test"],
    allowAbsentOrigin: true,
    publicBaseUrl: "https://triage.example.test",
    bindingSecret: "only-for-c1-binding-tickets-0123456789",
    ...(setup.local || setup.noAuthentication
      ? {
          localPrincipal: {
            ...principals.get("fixture-token-alice")!,
            deploymentMode: "local-trusted-ide" as const,
            scopes:
              setup.eventsScope === false
                ? ["bz:read" as const]
                : ["bz:read" as const, "bz:events" as const],
          },
          ...(setup.noAuthentication ? {} : { localAuthToken: "fixture-token-alice" }),
        }
      : {
          authenticateBearerToken: async (token: string) => principals.get(token) ?? null,
        }),
    ...(setup.webhookEnabled === undefined ? {} : { webhookEnabled: setup.webhookEnabled }),
    ...(setup.readOnly === undefined ? {} : { readOnly: setup.readOnly }),
  };
  const server = await startMcpHttpServer({ config, host: "127.0.0.1", port: 0 });
  console.log("C1_READY", JSON.stringify({ port: server.port, baseUrl: server.baseUrl }));
  process.stdin.resume();
  process.stdin.on("end", async () => {
    await server.close();
    process.exit(0);
  });
}

main().catch((error: unknown) => {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  console.error("C1_START_FAILED", JSON.stringify({ code, message: String(error) }));
  process.exitCode = 1;
});
