import type { BugId } from "@bugzilla-mcp/contracts";

export type HostSurface = "aux_pane" | "global" | "inline";

export interface SafeUserIntentMessage {
  readonly action: "investigate_root_cause" | "re_evaluate_after_conflict";
  readonly bugIds: readonly BugId[];
}

/**
 * Pure C0 contract boundary for APP-01:
 * Builds a user-role sendMessage payload containing ONLY fixed server-controlled
 * intent text and numeric bug IDs (never untrusted Bugzilla titles, comments, or snapshots).
 */
export function buildSafeUserIntentMessage(_intent: SafeUserIntentMessage): string {
  throw new Error("C0_CONTRACT_STUB");
}
