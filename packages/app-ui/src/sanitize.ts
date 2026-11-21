import type { BugId } from "@bugzilla-mcp/contracts";
import type {
  SafeRenderedBugView,
  SafeUserIntentMessage,
  UntrustedBugzillaDisplayInput,
} from "./types.js";

const HTML_ESCAPE_MAP: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
  "/": "&#x2F;",
};

export function escapeHtmlText(raw: string): string {
  return raw.replace(/[&<>"'/]/g, (char) => HTML_ESCAPE_MAP[char] ?? char);
}

export function formatSafeUserIntentMessage(intent: SafeUserIntentMessage): string {
  const uniqueIds = intent.bugIds.map((id) => {
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error(`Invalid bug ID: ${String(id)}`);
    }
    return String(id);
  });
  const idList = uniqueIds.join(", ");
  if (intent.action === "investigate_root_cause") {
    return `Investigate root cause and draft a triage analysis for Bugzilla bugs: ${idList}.`;
  }
  return `Re-evaluate the pending proposal against the latest Bugzilla state for bugs: ${idList}.`;
}

export function renderSafeBugView(input: UntrustedBugzillaDisplayInput): SafeRenderedBugView {
  const view: {
    bugId: BugId;
    inertTitleHtml: string;
    inertCommentHtml?: string;
    inertAttachmentNameHtml?: string;
    inertConflictSnapshotHtml?: string;
  } = {
    bugId: input.bugId,
    inertTitleHtml: `<span>${escapeHtmlText(input.title)}</span>`,
  };
  if (input.commentText !== undefined) {
    view.inertCommentHtml = `<pre>${escapeHtmlText(input.commentText)}</pre>`;
  }
  if (input.attachmentFileName !== undefined) {
    view.inertAttachmentNameHtml = `<code>${escapeHtmlText(input.attachmentFileName)}</code>`;
  }
  if (input.conflictSnapshotText !== undefined) {
    view.inertConflictSnapshotHtml = `<pre>${escapeHtmlText(input.conflictSnapshotText)}</pre>`;
  }
  return view;
}

export function buildSafeResourceLinks(bugIds: readonly BugId[]): {
  readonly resourceLinks: readonly { readonly type: "resource_link"; readonly uri: string }[];
} {
  return {
    resourceLinks: bugIds.map((id) => {
      if (!Number.isSafeInteger(id) || id <= 0) {
        throw new Error(`Invalid bug ID: ${String(id)}`);
      }
      return {
        type: "resource_link" as const,
        uri: `bugzilla://bug/${id}`,
      };
    }),
  };
}
