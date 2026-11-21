import { App, applyDocumentTheme, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createController } from "../controller.js";
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
        setPayload(sc as unknown as TriageBoardPayload);
        return;
      }
      // Inline dossier card tool (`bugzilla_get_dossier`) returns a bare BugDossier (UI-05)
      if (sc.bug && typeof sc.bug === "object") {
        const dossier = sc as unknown as NonNullable<TriageBoardPayload["initialDossier"]>;
        setPayload({
          instanceUrl: "",
          instanceLabel: "Bug Dossier",
          principalId: "",
          deploymentMode: "local-trusted-ide",
          fetchedAt: new Date().toISOString(),
          activeTab: "untriaged",
          focusBugId: dossier.bug.id,
          bugs: [dossier.bug],
          proposals: [],
          initialDossier: dossier,
        });
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
