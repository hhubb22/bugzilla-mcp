import type { BugId } from "@bugzilla-mcp/contracts";

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
}

/**
 * Pure C0 contract boundaries for APP-01 / R-3d5465:
 * - buildSafeUserIntentMessage emits ONLY fixed server-controlled intent text + numeric bug IDs.
 * - renderInertBugzillaView guarantees all untrusted Bugzilla strings are inert against XSS.
 * - buildSafeModelContext attaches only authorized bugzilla://bug/{id} resource links.
 */
export function buildSafeUserIntentMessage(_intent: SafeUserIntentMessage): string {
  throw new Error("C0_CONTRACT_STUB");
}

export function renderInertBugzillaView(
  _input: UntrustedBugzillaDisplayInput,
): SafeRenderedBugView {
  throw new Error("C0_CONTRACT_STUB");
}

export function buildSafeModelContext(_bugIds: readonly BugId[]): {
  readonly resourceLinks: readonly { readonly type: "resource_link"; readonly uri: string }[];
} {
  throw new Error("C0_CONTRACT_STUB");
}
