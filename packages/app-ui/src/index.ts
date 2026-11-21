import type { BugId } from "@bugzilla-mcp/contracts";
import { createController } from "./controller.js";
import { loadTriageAppHtml } from "./html-loader.js";
import {
  buildSafeResourceLinks,
  formatSafeUserIntentMessage,
  renderSafeBugView,
} from "./sanitize.js";
import type {
  McpAppHostPort,
  SafeRenderedBugView,
  SafeUserIntentMessage,
  TriageAppController,
  UntrustedBugzillaDisplayInput,
} from "./types.js";

export type {
  HostSurface,
  McpAppHostCapabilities,
  McpAppHostPort,
  SafeRenderedBugView,
  SafeUserIntentMessage,
  TriageAppController,
  UntrustedBugzillaDisplayInput,
} from "./types.js";

/**
 * Pure C0 contract boundaries for APP-01 / R-3d5465:
 * - buildSafeUserIntentMessage emits ONLY fixed server-controlled intent text + numeric bug IDs.
 * - renderInertBugzillaView guarantees all untrusted Bugzilla strings (including conflict snapshots)
 *   are inert against XSS.
 * - buildSafeModelContext attaches only authorized bugzilla://bug/{id} resource links.
 * - createTriageAppController drives host sendMessage/updateModelContext strictly through safe boundaries.
 */
export function buildSafeUserIntentMessage(intent: SafeUserIntentMessage): string {
  return formatSafeUserIntentMessage(intent);
}

export function renderInertBugzillaView(input: UntrustedBugzillaDisplayInput): SafeRenderedBugView {
  return renderSafeBugView(input);
}

export function buildSafeModelContext(bugIds: readonly BugId[]): {
  readonly resourceLinks: readonly { readonly type: "resource_link"; readonly uri: string }[];
} {
  return buildSafeResourceLinks(bugIds);
}

export function createTriageAppController(host: McpAppHostPort): TriageAppController {
  return createController(host);
}

export {
  normalizeBoardTenantKey,
  resolveBoardTenantKey,
  resolveVerifiedTenantKey,
} from "./tenant-key.js";
export { loadTriageAppHtml };
