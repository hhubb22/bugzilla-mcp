import type {
  McpAppHostPort,
  TriageAppController,
  UntrustedBugzillaDisplayInput,
} from "./types.js";
import {
  buildSafeResourceLinks,
  formatSafeUserIntentMessage,
  renderSafeBugView,
} from "./sanitize.js";

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
  };
}
