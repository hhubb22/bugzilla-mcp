import type { BugId } from "@bugzilla-mcp/contracts";
import { createController } from "./controller.js";
import {
  buildSafeResourceLinks,
  formatSafeUserIntentMessage,
  renderSafeBugView,
} from "./sanitize.js";

export type HostSurface = "aux_pane" | "global" | "inline";

export interface SafeUserIntentMessage {
  readonly action: "investigate_root_cause" | "re_evaluate_after_conflict";
  readonly bugIds: readonly BugId[];
}

export interface UntrustedBugzillaDisplayInput {
  readonly bugId: BugId;
  readonly title: string;
  readonly commentText?: string;
  readonly attachmentFileName?: string;
  readonly conflictSnapshotText?: string;
}

export interface SafeRenderedBugView {
  readonly bugId: BugId;
  readonly inertTitleHtml: string;
  readonly inertCommentHtml?: string;
  readonly inertAttachmentNameHtml?: string;
  readonly inertConflictSnapshotHtml?: string;
}

export interface McpAppHostCapabilities {
  readonly message: boolean;
  readonly updateModelContext: boolean;
  readonly openLinks: boolean;
}

export interface McpAppHostPort {
  getHostCapabilities(): McpAppHostCapabilities;
  sendMessage(params: { readonly text: string }): Promise<void>;
  updateModelContext(params: {
    readonly content: readonly { readonly type: "resource_link"; readonly uri: string }[];
  }): Promise<void>;
}

export interface TriageAppController {
  renderBug(input: UntrustedBugzillaDisplayInput): SafeRenderedBugView;
  triggerInvestigate(bugs: readonly UntrustedBugzillaDisplayInput[]): Promise<void>;
  triggerReEvaluateAfterConflict(input: UntrustedBugzillaDisplayInput): Promise<void>;
  attachSelectionToModelContext(bugs: readonly UntrustedBugzillaDisplayInput[]): Promise<void>;
  clearModelContext(): Promise<void>;
}

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
