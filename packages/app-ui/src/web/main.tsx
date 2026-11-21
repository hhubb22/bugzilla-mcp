import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createController } from "../controller.js";
import { normalizeBoardTenantKey } from "../tenant-key.js";
import type { McpAppHostCapabilities, McpAppHostPort } from "../types.js";
import { createRpcGate } from "./concurrency.js";
import { type TriageBoardPayload, TriageWorkbench } from "./TriageWorkbench.js";
import "./styles.css";

function McpAppRoot() {
  const [payload, setPayload] = useState<TriageBoardPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [capabilities, setCapabilities] = useState<McpAppHostCapabilities>({
    message: false,
    updateModelContext: false,
    openLinks: false,
  });

  const gate = useMemo(() => createRpcGate(), []);
  const app = useMemo(
    () => new App({ name: "Bugzilla Triage Workbench", version: "0.1.0" }, {}),
    [],
  );

  const hostPort = useMemo<McpAppHostPort>(
    () => ({
      getHostCapabilities: () => capabilities,
      sendMessage: async ({ text }) => {
        await app.sendMessage({
          role: "user",
          content: [{ type: "text", text }],
        });
      },
      updateModelContext: async ({ content }) => {
        await app.updateModelContext({
          content: content.map((item) => ({
            type: "resource_link",
            uri: item.uri,
            name: item.uri,
          })),
        });
      },
    }),
    [app, capabilities],
  );

  const controller = useMemo(() => createController(hostPort), [hostPort]);

  useEffect(() => {
    let active = true;
    let anonymousViewSeq = 0;

    // Register ALL lifecycle handlers BEFORE app.connect() so no initial notification is missed
    app.ontoolinput = () => {
      if (active) setLoading(true);
    };

    app.ontoolresult = (result) => {
      if (!active) return;
      setLoading(false);
      const sc = result.structuredContent as Record<string, unknown> | undefined;
      if (!sc || typeof sc !== "object") return;
      if (Array.isArray(sc.bugs)) {
        const incoming = sc as unknown as TriageBoardPayload;
        setPayload(normalizeBoardTenantKey(incoming, () => `anon-board-${++anonymousViewSeq}`));
        return;
      }
      // Inline dossier card tool (`bugzilla_get_dossier`) returns a BugDossier + server tenantKey (UI-05, ISO-04-B)
      if (sc.bug && typeof sc.bug === "object") {
        const dossier = sc as unknown as NonNullable<TriageBoardPayload["initialDossier"]>;
        setPayload(
          normalizeBoardTenantKey(
            {
              ...(typeof sc.tenantKey === "string" ? { tenantKey: sc.tenantKey } : {}),
              instanceUrl: "",
              instanceLabel: "Bug Dossier",
              principalId: "",
              deploymentMode: "local-trusted-ide" as const,
              fetchedAt: new Date().toISOString(),
              activeTab: "untriaged" as const,
              focusBugId: dossier.bug.id,
              bugs: [dossier.bug],
              proposals: [],
              initialDossier: dossier,
            },
            () => `anon-dossier-${++anonymousViewSeq}`,
          ),
        );
      }
    };

    app.ontoolcancelled = () => {
      if (active) setLoading(false);
    };

    app.onhostcontextchanged = (ctx) => {
      if (ctx.theme) {
        applyDocumentTheme(ctx.theme);
        document.documentElement.dataset.theme = ctx.theme;
      }
      if (ctx.styles?.variables) {
        applyHostStyleVariables(ctx.styles.variables);
      }
    };

    void app
      .connect()
      .then(() => {
        if (!active) return;
        const ctx = app.getHostContext();
        if (ctx?.theme) {
          applyDocumentTheme(ctx.theme);
          document.documentElement.dataset.theme = ctx.theme;
        }
        if (ctx?.styles?.variables) {
          applyHostStyleVariables(ctx.styles.variables);
        }
        const caps = app.getHostCapabilities();
        setCapabilities({
          message: Boolean(caps?.message),
          updateModelContext: Boolean(caps?.updateModelContext),
          openLinks: Boolean(caps?.openLinks),
        });
      })
      .catch(() => {
        // Standalone preview fallback outside an MCP host
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [app]);

  return (
    <TriageWorkbench
      initialPayload={payload}
      loading={loading}
      capabilities={capabilities}
      controller={controller}
      gate={gate}
      callServerTool={(name, args) => app.callServerTool({ name, arguments: args })}
      openExternalLink={async (url) => {
        await app.openLink({ url });
      }}
    />
  );
}

const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(
    <StrictMode>
      <McpAppRoot />
    </StrictMode>,
  );
}
