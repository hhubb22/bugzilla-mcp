import {
  buildSafeResourceLinks,
  formatSafeUserIntentMessage,
  renderSafeBugView,
} from "./sanitize.js";
import { extractErrorMessage, isSafeHttpUrl, unwrapToolResult } from "./tool-result.js";
import type {
  McpAppHostPort,
  TriageAppController,
  UntrustedBugzillaDisplayInput,
} from "./types.js";

export function createController(host: McpAppHostPort): TriageAppController {
  return {
    renderBug(input: UntrustedBugzillaDisplayInput) {
      return renderSafeBugView(input);
    },

    async triggerInvestigate(bugs: readonly UntrustedBugzillaDisplayInput[]) {
      const caps = host.getHostCapabilities();
      if (!caps.message || bugs.length === 0) {
        return;
      }
      const text = formatSafeUserIntentMessage({
        action: "investigate_root_cause",
        bugIds: bugs.map((bug) => bug.bugId),
      });
      await host.sendMessage({ text });
    },

    async triggerReEvaluateAfterConflict(input: UntrustedBugzillaDisplayInput) {
      const caps = host.getHostCapabilities();
      if (!caps.message) {
        return;
      }
      const text = formatSafeUserIntentMessage({
        action: "re_evaluate_after_conflict",
        bugIds: [input.bugId],
      });
      await host.sendMessage({ text });
    },

    async attachSelectionToModelContext(bugs: readonly UntrustedBugzillaDisplayInput[]) {
      const caps = host.getHostCapabilities();
      if (!caps.updateModelContext) {
        return;
      }
      const { resourceLinks } = buildSafeResourceLinks(bugs.map((bug) => bug.bugId));
      await host.updateModelContext({ content: resourceLinks });
    },

    async clearModelContext() {
      const caps = host.getHostCapabilities();
      if (!caps.updateModelContext) {
        return;
      }
      await host.updateModelContext({ content: [] });
    },

    parseToolResult<T = Record<string, unknown>>(raw: unknown) {
      return unwrapToolResult<T>(raw);
    },

    async callTool<T = Record<string, unknown>>(name: string, args: Record<string, unknown>) {
      if (!host.callServerTool) {
        return {
          ok: false as const,
          kind: "error" as const,
          message: "Host does not support server tool calls.",
        };
      }
      try {
        const raw = await host.callServerTool({ name, arguments: args });
        return unwrapToolResult<T>(raw);
      } catch (err) {
        return {
          ok: false as const,
          kind: "error" as const,
          message: extractErrorMessage(err, `Tool call "${name}" failed.`),
        };
      }
    },

    async openExternalLink(url: string) {
      const caps = host.getHostCapabilities();
      if (!caps.openLinks || !host.openExternalLink) {
        return;
      }
      if (!isSafeHttpUrl(url)) {
        throw new Error(
          "Blocked unsafe external URL: only http:// and https:// links are allowed.",
        );
      }
      await host.openExternalLink({ url });
    },
  };
}
