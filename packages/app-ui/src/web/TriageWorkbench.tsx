import type { BugDossier, BugSummary, ProposalDiff } from "@bugzilla-mcp/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { McpAppHostCapabilities, TriageAppController } from "../types.js";
import type { RpcGate } from "./concurrency.js";

export type QueueTab = "pending_proposals" | "needinfo_or_mine" | "untriaged";

export interface UiProposalSummary {
  readonly proposalId: string;
  readonly revision: number;
  readonly bugId: number;
  readonly baseVersion: string;
  readonly diff: ProposalDiff;
  readonly rationale: string;
  readonly state: "pending" | "approved" | "rejected" | "applied" | "stale" | "indeterminate";
  readonly approvalUrl?: string;
}

export interface TriageBoardPayload {
  readonly instanceUrl: string;
  readonly instanceLabel?: string;
  readonly principalId: string;
  readonly deploymentMode: "cloud-multi-user" | "local-trusted-ide";
  readonly fetchedAt: string;
  readonly activeTab?: QueueTab;
  readonly focusBugId?: number;
  readonly bugs: readonly BugSummary[];
  readonly proposals: readonly UiProposalSummary[];
  readonly hasMore?: boolean;
  readonly unbound?: boolean;
  readonly bindingUrl?: string;
  readonly initialDossier?: BugDossier;
}

export interface ConflictState {
  readonly proposal: UiProposalSummary;
  readonly expectedLastChangeTime: string;
  readonly actualLastChangeTime: string;
  readonly latestSummary?: string;
}

interface DraftEntry {
  content: string;
  revision: number;
  editSeq: number;
  status: "saved" | "dirty" | "saving" | "save_failed";
  error?: string;
}

export interface WorkbenchProps {
  readonly initialPayload: TriageBoardPayload | null;
  readonly loading: boolean;
  readonly capabilities: McpAppHostCapabilities;
  readonly controller: TriageAppController;
  readonly gate: RpcGate;
  readonly callServerTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  readonly openExternalLink: (url: string) => Promise<void>;
}

function severityMarker(severity: string): { icon: string; tone: string } {
  const s = severity.toLowerCase();
  if (s === "blocker" || s === "critical" || s === "s1") {
    return { icon: "!", tone: "badge-danger" };
  }
  if (s === "major" || s === "s2") {
    return { icon: "▲", tone: "badge-warn" };
  }
  return { icon: "●", tone: "badge-info" };
}

function normalizeBugUrl(instanceUrl: string, bugId: number): string {
  const base = instanceUrl.replace(/\/+$/, "");
  return `${base}/show_bug.cgi?id=${Math.trunc(bugId)}`;
}

export function TriageWorkbench({
  initialPayload,
  loading,
  capabilities,
  controller,
  gate,
  callServerTool,
  openExternalLink,
}: WorkbenchProps) {
  const [board, setBoard] = useState<TriageBoardPayload | null>(initialPayload);
  const [activeTab, setActiveTab] = useState<QueueTab>(
    initialPayload?.activeTab ?? "pending_proposals",
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [productFilter, setProductFilter] = useState("ALL");
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [activeBugId, setActiveBugId] = useState<number | null>(
    initialPayload?.focusBugId ?? initialPayload?.initialDossier?.bug.id ?? null,
  );
  const [dossier, setDossier] = useState<BugDossier | null>(initialPayload?.initialDossier ?? null);
  const [dossierLoading, setDossierLoading] = useState(false);
  const [partialError, setPartialError] = useState<string | null>(null);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [confirmProposal, setConfirmProposal] = useState<UiProposalSummary | null>(null);
  const [indeterminateProposals, setIndeterminateProposals] = useState<Set<string>>(
    () => new Set(),
  );
  const [drafts, setDrafts] = useState<Map<string, DraftEntry>>(() => new Map());
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  const [isStaleBoard, setIsStaleBoard] = useState(false);

  const checkBoardStale = useCallback((fetchedAt?: string) => {
    if (!fetchedAt) return false;
    const ageMs = Date.now() - Date.parse(fetchedAt);
    return Number.isFinite(ageMs) && ageMs > 5 * 60_000;
  }, []);

  useEffect(() => {
    if (!initialPayload) return;
    setBoard(initialPayload);
    if (initialPayload.activeTab) setActiveTab(initialPayload.activeTab);
    if (initialPayload.focusBugId !== undefined) setActiveBugId(initialPayload.focusBugId);
    // Clear stale dossier whenever a replacement board arrives without one (UI-03)
    setDossier(initialPayload.initialDossier ?? null);
  }, [initialPayload]);

  // Schedule live 5-minute staleness expiry so open boards lock writes automatically (UI-06)
  useEffect(() => {
    if (!board?.fetchedAt) {
      setIsStaleBoard(false);
      return;
    }
    const fetchedMs = Date.parse(board.fetchedAt);
    if (!Number.isFinite(fetchedMs)) {
      setIsStaleBoard(false);
      return;
    }
    const remainingMs = fetchedMs + 5 * 60_000 - Date.now();
    if (remainingMs <= 0) {
      setIsStaleBoard(true);
      return;
    }
    setIsStaleBoard(false);
    const timer = window.setTimeout(() => setIsStaleBoard(true), remainingMs);
    return () => window.clearTimeout(timer);
  }, [board?.fetchedAt]);

  const products = useMemo(() => {
    const set = new Set<string>();
    for (const b of board?.bugs ?? []) set.add(b.product);
    return Array.from(set).sort();
  }, [board?.bugs]);

  const pendingProposalsByBug = useMemo(() => {
    const map = new Map<number, UiProposalSummary[]>();
    for (const p of board?.proposals ?? []) {
      if (p.state !== "pending") continue;
      const list = map.get(p.bugId) ?? [];
      list.push(p);
      map.set(p.bugId, list);
    }
    return map;
  }, [board?.proposals]);

  const tabCounts = useMemo(() => {
    const bugs = board?.bugs ?? [];
    const pendingCount = bugs.filter(
      (b) => (pendingProposalsByBug.get(b.id)?.length ?? 0) > 0,
    ).length;
    const mineCount = bugs.filter(
      (b) => b.assignedTo === board?.principalId || b.status === "IN_PROGRESS",
    ).length;
    const untriagedCount = bugs.filter(
      (b) => b.status === "UNCONFIRMED" || b.status === "NEW" || b.status === "CONFIRMED",
    ).length;
    return {
      pending_proposals: pendingCount,
      needinfo_or_mine: mineCount,
      untriaged: untriagedCount,
    };
  }, [board?.bugs, board?.principalId, pendingProposalsByBug]);

  const visibleBugs = useMemo(() => {
    const bugs = board?.bugs ?? [];
    return bugs.filter((b) => {
      if (
        activeTab === "pending_proposals" &&
        (pendingProposalsByBug.get(b.id)?.length ?? 0) === 0
      ) {
        return false;
      }
      if (
        activeTab === "needinfo_or_mine" &&
        b.assignedTo !== board?.principalId &&
        b.status !== "IN_PROGRESS"
      ) {
        return false;
      }
      if (
        activeTab === "untriaged" &&
        b.status !== "UNCONFIRMED" &&
        b.status !== "NEW" &&
        b.status !== "CONFIRMED"
      ) {
        return false;
      }
      if (productFilter !== "ALL" && b.product !== productFilter) return false;
      if (searchQuery.trim().length > 0) {
        const q = searchQuery.trim().toLowerCase();
        if (!String(b.id).includes(q) && !b.summary.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [
    board?.bugs,
    board?.principalId,
    activeTab,
    pendingProposalsByBug,
    productFilter,
    searchQuery,
  ]);

  const draftKey = useCallback(
    (bugId: number) =>
      `${board?.principalId ?? "anon"}::${board?.instanceUrl ?? ""}::${bugId}::private_comment`,
    [board?.principalId, board?.instanceUrl],
  );

  const openBugDetail = useCallback(
    async (bugId: number) => {
      setActiveBugId(bugId);
      // Clear previous bug's dossier immediately so private comments never bleed across bugs (UI-03)
      setDossier((prev) => (prev?.bug.id === bugId ? prev : null));
      setConflict(null);
      setPartialError(null);
      setInlineError(null);
      const gen = gate.bumpGeneration();
      setDossierLoading(true);
      try {
        const res = await gate.runRead(gen, () =>
          callServerTool("app_get_bug_full", { bugId, maxComments: 20, maxHistory: 20 }),
        );
        if (res.stale) return;
        const payload = res.value as {
          structuredContent?: {
            dossier?: BugDossier;
            draft?: { content: string; draftRevision: number };
          };
        } | null;
        if (
          payload?.structuredContent?.dossier &&
          payload.structuredContent.dossier.bug.id === bugId
        ) {
          setDossier(payload.structuredContent.dossier);
        }
        if (payload?.structuredContent?.draft) {
          const d = payload.structuredContent.draft;
          setDrafts((prev) => {
            const existing = prev.get(draftKey(bugId));
            // Do not clobber dirty local edits with a delayed hydration response (UI-02)
            if (existing && (existing.status === "dirty" || existing.status === "saving")) {
              return prev;
            }
            const next = new Map(prev);
            next.set(draftKey(bugId), {
              content: d.content,
              revision: d.draftRevision,
              editSeq: existing?.editSeq ?? 0,
              status: "saved",
            });
            return next;
          });
        }
      } catch {
        if (gate.currentGeneration() === gen) {
          setPartialError("Failed to load full bug details. Core summary remains available.");
        }
      } finally {
        if (gate.currentGeneration() === gen) {
          setDossierLoading(false);
        }
      }
    },
    [callServerTool, draftKey, gate],
  );

  const refreshBoard = useCallback(async () => {
    const gen = gate.bumpGeneration();
    setInlineError(null);
    try {
      const res = await gate.runRead(gen, () =>
        callServerTool("bugzilla_triage_board", {
          tab: activeTab,
          ...(productFilter !== "ALL" ? { product: productFilter } : {}),
        }),
      );
      if (res.stale) return;
      const payload = (res.value as { structuredContent?: TriageBoardPayload } | null)
        ?.structuredContent;
      if (payload) setBoard(payload);
    } catch {
      setInlineError("Could not refresh queue from Bugzilla.");
    }
  }, [activeTab, callServerTool, gate, productFilter]);

  // Keyboard navigation (j/k/x/Enter/Escape/r) per Krug accessibility checklist
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")
      ) {
        if (e.key === "Escape") target.blur();
        return;
      }
      if (dialogRef.current?.open) return;
      if (e.key === "j") {
        e.preventDefault();
        setFocusedIndex((i) => Math.min(Math.max(visibleBugs.length - 1, 0), i + 1));
      } else if (e.key === "k") {
        e.preventDefault();
        setFocusedIndex((i) => Math.max(0, i - 1));
      } else if (e.key === "x" && visibleBugs[focusedIndex]) {
        e.preventDefault();
        const id = visibleBugs[focusedIndex]!.id;
        setSelectedIds((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
      } else if (e.key === "Enter" && visibleBugs[focusedIndex]) {
        e.preventDefault();
        void openBugDetail(visibleBugs[focusedIndex]!.id);
      } else if (e.key === "Escape" && activeBugId !== null) {
        e.preventDefault();
        setActiveBugId(null);
      } else if (e.key === "r") {
        e.preventDefault();
        void refreshBoard();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeBugId, focusedIndex, openBugDetail, refreshBoard, visibleBugs]);

  // Native <dialog> modal lifecycle (modern-web-guidance: dialog)
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (confirmProposal && !dialog.open) {
      dialog.showModal();
    } else if (!confirmProposal && dialog.open) {
      dialog.close();
    }
  }, [confirmProposal]);

  const executeProposalDecision = useCallback(
    async (proposal: UiProposalSummary, decision: "approve" | "reject") => {
      if (!board) return;
      if (checkBoardStale(board.fetchedAt)) {
        setIsStaleBoard(true);
        setInlineError("Board data is older than 5 minutes. Refresh before writing to Bugzilla.");
        return;
      }
      // Cloud multi-user approval MUST go through the authenticated HTTPS /approve page (UI-04)
      if (decision === "approve" && board.deploymentMode === "cloud-multi-user") {
        if (proposal.approvalUrl && capabilities.openLinks) {
          await openExternalLink(proposal.approvalUrl);
          setToast("Opened secure HTTPS approval page. Refresh after completing approval.");
        } else {
          setInlineError("Cloud approval requires an authenticated HTTPS approval link.");
        }
        return;
      }
      const key = `${proposal.proposalId}@${proposal.revision}`;
      const previousProposals = board.proposals;

      // Optimistic update for reject (with rollback on error)
      if (decision === "reject") {
        setBoard((prev) =>
          prev
            ? {
                ...prev,
                proposals: prev.proposals.map((p) =>
                  p.proposalId === proposal.proposalId && p.revision === proposal.revision
                    ? { ...p, state: "rejected" }
                    : p,
                ),
              }
            : prev,
        );
      }

      const gen = gate.currentGeneration();
      try {
        const res = await gate.runWrite(gen, () =>
          callServerTool("app_resolve_proposal", {
            proposalId: proposal.proposalId,
            revision: proposal.revision,
            decision,
            idempotencyKey: `ui-${decision}-${proposal.proposalId}-r${proposal.revision}`,
            ...(decision === "approve" && board.deploymentMode === "local-trusted-ide"
              ? {
                  approval: {
                    kind: "local_ide_host_confirmed",
                    confirmedAt: new Date().toISOString(),
                  },
                }
              : {}),
          }),
        );
        if (res.stale) return;
        const outcome = (res.value as { structuredContent?: Record<string, unknown> } | null)
          ?.structuredContent;
        if (!outcome) return;

        if (outcome.outcome === "StaleBugConflict") {
          setConflict({
            proposal,
            expectedLastChangeTime: String(outcome.expectedLastChangeTime ?? proposal.baseVersion),
            actualLastChangeTime: String(outcome.actualLastChangeTime ?? ""),
            ...(dossier?.bug.summary !== undefined ? { latestSummary: dossier.bug.summary } : {}),
          });
        } else if (outcome.outcome === "OperationIndeterminate") {
          setIndeterminateProposals((prev) => new Set(prev).add(key));
          setInlineError(
            "Write status is indeterminate. Reconcile by refreshing Bugzilla before taking further action.",
          );
        } else if (outcome.outcome === "Applied" || outcome.outcome === "ProposalRejected") {
          setToast(
            outcome.outcome === "Applied"
              ? `Applied proposal to Bug #${proposal.bugId}.`
              : `Rejected proposal for Bug #${proposal.bugId}.`,
          );
          await refreshBoard();
          await openBugDetail(proposal.bugId);
        } else {
          setInlineError(`Proposal action returned: ${String(outcome.outcome)}`);
        }
      } catch {
        // Optimistic rollback on failure (UI state #6)
        if (decision === "reject") {
          setBoard((prev) => (prev ? { ...prev, proposals: previousProposals } : prev));
          setToast("Reject failed; restored proposal to pending.");
        } else {
          setInlineError("Failed to execute proposal write.");
        }
      }
    },
    [
      board,
      callServerTool,
      capabilities.openLinks,
      checkBoardStale,
      dossier?.bug.summary,
      gate,
      openBugDetail,
      openExternalLink,
      refreshBoard,
    ],
  );

  const handleSaveDraft = useCallback(
    async (bugId: number, nextContent: string) => {
      if (checkBoardStale(board?.fetchedAt)) {
        setIsStaleBoard(true);
        setInlineError("Board data is older than 5 minutes. Refresh before saving drafts.");
        return;
      }
      const k = draftKey(bugId);
      const current = drafts.get(k);
      const nextRev = (current?.revision ?? 0) + 1;
      const submittedSeq = current?.editSeq ?? 0;
      setDrafts((prev) => {
        const copy = new Map(prev);
        const latest = prev.get(k);
        copy.set(k, {
          content: latest?.content ?? nextContent,
          revision: nextRev,
          editSeq: latest?.editSeq ?? submittedSeq,
          status: "saving",
        });
        return copy;
      });
      const gen = gate.currentGeneration();
      try {
        const res = await gate.runWrite(gen, () =>
          callServerTool("app_save_draft", {
            bugId,
            draftKind: "private_comment",
            draftRevision: nextRev,
            content: nextContent,
          }),
        );
        if (res.stale) return;
        const result = (
          res.value as { structuredContent?: { status: string; draftRevision?: number } } | null
        )?.structuredContent;
        setDrafts((prev) => {
          const copy = new Map(prev);
          const latest = prev.get(k);
          const ackRev = result?.draftRevision ?? nextRev;
          // Preserve newer user edits made while save was in flight (UI-02)
          if (latest && latest.editSeq !== submittedSeq) {
            copy.set(k, { ...latest, revision: ackRev, status: "dirty" });
          } else {
            copy.set(k, {
              content: latest?.content ?? nextContent,
              revision: ackRev,
              editSeq: submittedSeq,
              status: result?.status === "acknowledged" ? "saved" : "save_failed",
            });
          }
          return copy;
        });
      } catch {
        setDrafts((prev) => {
          const copy = new Map(prev);
          const latest = prev.get(k);
          copy.set(k, {
            content: latest?.content ?? nextContent,
            revision: nextRev,
            editSeq: latest?.editSeq ?? submittedSeq,
            status: latest && latest.editSeq !== submittedSeq ? "dirty" : "save_failed",
            error: "Save failed",
          });
          return copy;
        });
      }
    },
    [board?.fetchedAt, callServerTool, checkBoardStale, draftKey, drafts, gate],
  );

  const activeBug = useMemo(() => {
    if (activeBugId === null) return null;
    if (dossier && dossier.bug.id === activeBugId) return dossier.bug;
    return board?.bugs.find((b) => b.id === activeBugId) ?? null;
  }, [activeBugId, board?.bugs, dossier]);

  const activeBugProposals = useMemo(() => {
    if (activeBugId === null) return [];
    return pendingProposalsByBug.get(activeBugId) ?? [];
  }, [activeBugId, pendingProposalsByBug]);

  // UI State #8: Unbound / Permission Denied
  if (board?.unbound) {
    return (
      <main className="workbench-shell">
        <header className="topbar">
          <div className="topbar-title-group">
            <h1>Bugzilla Triage</h1>
            <span className="instance-pill">Unbound</span>
          </div>
        </header>
        <section className="empty-state">
          <h2>Bind your self-hosted Bugzilla API Key</h2>
          <p>
            API keys are never collected inside chat or this panel. Complete one-time HTTPS binding
            to load your authorized queue.
          </p>
          {capabilities.openLinks && board.bindingUrl ? (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => void openExternalLink(board.bindingUrl!)}
            >
              Open Secure Binding Page
            </button>
          ) : null}
        </section>
      </main>
    );
  }

  const currentDraft = activeBugId !== null ? drafts.get(draftKey(activeBugId)) : undefined;

  return (
    <main className="workbench-shell">
      <header className="topbar">
        <div className="topbar-title-group">
          <span className={`instance-pill ${isStaleBoard ? "stale" : ""}`}>
            {board?.instanceLabel ?? board?.instanceUrl ?? "Bugzilla"}
            {isStaleBoard ? " · Cached" : ""}
          </span>
          <h1>Triage</h1>
        </div>
        <button type="button" className="btn" onClick={() => void refreshBoard()}>
          Refresh
        </button>
      </header>

      {toast ? (
        <div className="selection-bar" role="status">
          <span>{toast}</span>
          <button type="button" className="btn btn-ghost" onClick={() => setToast(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      <nav className="tabs" role="tablist" aria-label="Triage queues">
        {(
          [
            ["pending_proposals", "Pending Proposals", tabCounts.pending_proposals],
            ["needinfo_or_mine", "Needinfo / Mine", tabCounts.needinfo_or_mine],
            ["untriaged", "Untriaged", tabCounts.untriaged],
          ] as const
        ).map(([tabId, label, count]) => (
          <button
            key={tabId}
            type="button"
            role="tab"
            className="tab-btn"
            aria-selected={activeTab === tabId}
            onClick={() => {
              setActiveTab(tabId);
              setFocusedIndex(0);
            }}
          >
            <span>{label}</span>
            <span className="tab-count">{count}</span>
          </button>
        ))}
      </nav>

      <div className="main-body">
        <section
          className="queue-pane"
          aria-label="Bug queue"
          hidden={activeBugId !== null && typeof window !== "undefined" && window.innerWidth < 720}
        >
          {/* Keep filter bar visible when bugs exist so active search/product filters can be cleared (UI-07) */}
          {(board?.bugs.length ?? 0) > 0 &&
          (visibleBugs.length > 0 || searchQuery.length > 0 || productFilter !== "ALL") ? (
            <div className="filter-bar">
              <label htmlFor="bz-search" className="sr-only">
                Search bug ID or summary
              </label>
              <input
                id="bz-search"
                className="filter-input"
                type="search"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Filter by #ID or keyword..."
              />
              <label htmlFor="bz-product" className="sr-only">
                Filter by product
              </label>
              <select
                id="bz-product"
                className="filter-select"
                value={productFilter}
                onChange={(e) => setProductFilter(e.target.value)}
              >
                <option value="ALL">All products</option>
                {products.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {loading ? (
            <div aria-busy="true" aria-label="Loading queue">
              <div className="skeleton-row" />
              <div className="skeleton-row" />
              <div className="skeleton-row" />
            </div>
          ) : visibleBugs.length === 0 ? (
            <div className="empty-state">
              <p>No items in this queue.</p>
              <div className="action-row" style={{ justifyContent: "center" }}>
                {searchQuery.length > 0 || productFilter !== "ALL" ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      setSearchQuery("");
                      setProductFilter("ALL");
                    }}
                  >
                    Clear Filters
                  </button>
                ) : null}
                {activeTab !== "untriaged" ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => setActiveTab("untriaged")}
                  >
                    Switch to Untriaged
                  </button>
                ) : null}
                <button type="button" className="btn" onClick={() => void refreshBoard()}>
                  Refresh
                </button>
              </div>
            </div>
          ) : (
            <ul className="bug-list">
              {visibleBugs.map((bug, idx) => {
                const sev = severityMarker(bug.severity);
                const pendingCount = pendingProposalsByBug.get(bug.id)?.length ?? 0;
                const checked = selectedIds.has(bug.id);
                return (
                  <li
                    key={bug.id}
                    className={`bug-row ${idx === focusedIndex ? "focused" : ""}`}
                    onClick={() => {
                      setFocusedIndex(idx);
                      void openBugDetail(bug.id);
                    }}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Select bug #${bug.id}`}
                      checked={checked}
                      onClick={(e) => e.stopPropagation()}
                      onChange={() => {
                        setSelectedIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(bug.id)) next.delete(bug.id);
                          else next.add(bug.id);
                          return next;
                        });
                      }}
                    />
                    <div className="bug-row-content">
                      <div className="bug-row-top">
                        <span className="bug-id">#{bug.id}</span>
                        <span className={`badge ${sev.tone}`}>
                          <span aria-hidden="true">{sev.icon}</span>
                          {bug.severity}
                        </span>
                        {pendingCount > 0 ? (
                          <span className="badge badge-info">
                            {pendingCount} proposal{pendingCount > 1 ? "s" : ""}
                          </span>
                        ) : null}
                      </div>
                      <p className="bug-summary">{bug.summary}</p>
                      <div className="bug-meta">
                        {bug.product} · {bug.component} · {bug.status}
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {board?.hasMore ? (
            <div className="bug-meta" style={{ padding: "8px 16px" }}>
              Showing first {visibleBugs.length} items — narrow Product or search to see more.
            </div>
          ) : null}

          {selectedIds.size > 0 && (capabilities.updateModelContext || capabilities.message) ? (
            <div className="selection-bar">
              <span>{selectedIds.size} selected</span>
              <div className="action-row" style={{ marginTop: 0 }}>
                {capabilities.updateModelContext ? (
                  <>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        const selected = (board?.bugs ?? [])
                          .filter((b) => selectedIds.has(b.id))
                          .map((b) => ({ bugId: b.id, title: b.summary }));
                        void controller.attachSelectionToModelContext(selected).then(() => {
                          setToast(`Attached ${selected.length} bug link(s) to next turn.`);
                        });
                      }}
                    >
                      Attach to Context
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        void controller
                          .clearModelContext()
                          .then(() => setToast("Cleared context."));
                      }}
                    >
                      Clear
                    </button>
                  </>
                ) : null}
                {capabilities.message ? (
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => {
                      const selected = (board?.bugs ?? [])
                        .filter((b) => selectedIds.has(b.id))
                        .map((b) => ({ bugId: b.id, title: b.summary }));
                      void controller.triggerInvestigate(selected);
                    }}
                  >
                    Ask Agent to Investigate
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </section>

        <section className="detail-pane" aria-label="Bug dossier">
          {!activeBug ? (
            <div className="empty-state">
              <p>Select a bug from the queue to inspect its dossier and pending proposals.</p>
            </div>
          ) : (
            <>
              <div className="action-row" style={{ marginTop: 0, justifyContent: "space-between" }}>
                <div className="action-row" style={{ marginTop: 0 }}>
                  <button
                    type="button"
                    className="btn back-btn"
                    onClick={() => setActiveBugId(null)}
                  >
                    ← Queue
                  </button>
                  <span className="bug-id">#{activeBug.id}</span>
                  <span className="badge badge-info">{activeBug.status}</span>
                </div>
                {capabilities.openLinks && board?.instanceUrl ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void openExternalLink(normalizeBugUrl(board.instanceUrl, activeBug.id))
                    }
                  >
                    Open in Bugzilla ↗
                  </button>
                ) : null}
              </div>

              <h2 style={{ marginTop: 12, marginBottom: 4 }}>{activeBug.summary}</h2>
              <div className="bug-meta">
                {activeBug.product} / {activeBug.component} · Priority {activeBug.priority} ·
                Assigned to {activeBug.assignedTo}
              </div>

              {inlineError ? (
                <div className="inline-alert" role="alert">
                  {inlineError}
                </div>
              ) : null}

              {partialError ? (
                <div className="inline-alert" role="alert">
                  <span>{partialError} </span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void openBugDetail(activeBug.id)}
                  >
                    Retry
                  </button>
                </div>
              ) : null}

              {/* Place 3: StaleBugConflict 3-column recovery view */}
              {conflict && conflict.proposal.bugId === activeBug.id ? (
                <div className="conflict-card" role="alert">
                  <h2>Stale Bug Conflict — Proposal Outdated</h2>
                  <p>
                    Bug #{activeBug.id} changed externally since this proposal was drafted. Prior
                    approval cannot be reused.
                  </p>
                  <table className="conflict-grid">
                    <thead>
                      <tr>
                        <th>Old Base Version</th>
                        <th>Latest Bugzilla Version</th>
                        <th>Proposed Diff</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>{conflict.expectedLastChangeTime}</td>
                        <td>{conflict.actualLastChangeTime}</td>
                        <td>{JSON.stringify(conflict.proposal.diff)}</td>
                      </tr>
                    </tbody>
                  </table>
                  <div className="action-row">
                    {capabilities.message ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() =>
                          void controller.triggerReEvaluateAfterConflict({
                            bugId: activeBug.id,
                            title: activeBug.summary,
                          })
                        }
                      >
                        Ask Agent to Re-draft
                      </button>
                    ) : null}
                    <button type="button" className="btn" onClick={() => setConflict(null)}>
                      Dismiss Conflict
                    </button>
                  </div>
                </div>
              ) : null}

              {/* Pending AI Proposals */}
              {activeBugProposals.map((proposal) => {
                const key = `${proposal.proposalId}@${proposal.revision}`;
                const isIndeterminate = indeterminateProposals.has(key);
                return (
                  <div key={key} className="proposal-banner">
                    <div className="bug-row-top">
                      <strong>
                        Proposal {proposal.proposalId} (rev {proposal.revision})
                      </strong>
                      {proposal.diff.publicComment ? (
                        <span className="badge badge-warn">Public Comment</span>
                      ) : (
                        <span className="badge badge-info">Field Update</span>
                      )}
                    </div>
                    <p style={{ margin: "6px 0" }}>{proposal.rationale}</p>
                    <div className="bug-meta">Diff: {JSON.stringify(proposal.diff)}</div>
                    <div className="action-row">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={isStaleBoard || isIndeterminate}
                        onClick={() => setConfirmProposal(proposal)}
                      >
                        {isIndeterminate ? "Pending Reconciliation" : "Review & Approve"}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={isStaleBoard || isIndeterminate}
                        onClick={() => void executeProposalDecision(proposal, "reject")}
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                );
              })}

              {/* Recent Comments — guarded by dossier.bug.id === activeBug.id to prevent cross-bug bleed (UI-03) */}
              <div className="section-block">
                <h2>Recent Comments {dossierLoading ? "(Loading...)" : ""}</h2>
                {(dossier?.bug.id === activeBug.id ? dossier.recentComments : []).length === 0 ? (
                  <p className="bug-meta">No comments loaded yet.</p>
                ) : (
                  (dossier?.bug.id === activeBug.id ? dossier.recentComments : []).map((c) => (
                    <article key={c.id} className="comment-item">
                      <div className="bug-meta">
                        {c.creator} · {c.time}{" "}
                        {c.isPrivate ? <span className="badge badge-warn">Private</span> : null}
                      </div>
                      <p className="comment-body">{c.text}</p>
                    </article>
                  ))
                )}
              </div>

              {/* Internal Notes (Safe-Auto fail-closed fallback) */}
              {(dossier?.bug.id === activeBug.id ? dossier.internalNotes : []).length > 0 ? (
                <div className="section-block">
                  <h2>Server Internal Notes</h2>
                  {(dossier?.bug.id === activeBug.id ? dossier.internalNotes : []).map((n) => (
                    <article key={n.id} className="comment-item">
                      <div className="bug-meta">Internal only · {n.createdAt}</div>
                      <p className="comment-body">{n.text}</p>
                    </article>
                  ))}
                </div>
              ) : null}

              {/* Attachments */}
              {(dossier?.bug.id === activeBug.id ? dossier.attachments : []).length > 0 ? (
                <div className="section-block">
                  <h2>Attachments</h2>
                  <ul className="bug-list">
                    {(dossier?.bug.id === activeBug.id ? dossier.attachments : []).map((att) => (
                      <li key={att.id} className="bug-meta" style={{ padding: "4px 0" }}>
                        {att.fileName} ({att.contentType}, {att.sizeBytes} bytes)
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {/* Server-persisted Draft Box (no localStorage) */}
              <div className="section-block">
                <label htmlFor="bz-draft-input">
                  <h2>Reply Draft</h2>
                </label>
                <textarea
                  id="bz-draft-input"
                  className="draft-textarea"
                  value={currentDraft?.content ?? ""}
                  onChange={(e) => {
                    const content = e.target.value;
                    const k = draftKey(activeBug.id);
                    setDrafts((prev) => {
                      const copy = new Map(prev);
                      const existing = prev.get(k);
                      copy.set(k, {
                        content,
                        revision: existing?.revision ?? 0,
                        editSeq: (existing?.editSeq ?? 0) + 1,
                        status: "dirty",
                      });
                      return copy;
                    });
                  }}
                  placeholder="Draft a reply or triage note (persisted to server)..."
                />
                <div className="action-row" style={{ justifyContent: "space-between" }}>
                  <span className="bug-meta">
                    {currentDraft?.status === "saved"
                      ? `Saved (rev ${currentDraft.revision})`
                      : currentDraft?.status === "saving"
                        ? "Saving..."
                        : currentDraft?.status === "save_failed"
                          ? "Save failed — retry"
                          : "Unsaved draft"}
                  </span>
                  <button
                    type="button"
                    className="btn"
                    disabled={isStaleBoard}
                    onClick={() => void handleSaveDraft(activeBug.id, currentDraft?.content ?? "")}
                  >
                    Save Draft
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>

      {/* Place 4: Native <dialog> Guarded-Write confirmation modal (modern-web-guidance: dialog) */}
      <dialog
        ref={dialogRef}
        className="confirm-dialog"
        aria-labelledby="confirm-dialog-title"
        onClose={(e) => {
          const dlg = e.currentTarget;
          const choice = dlg.returnValue;
          dlg.returnValue = "";
          const prop = confirmProposal;
          setConfirmProposal(null);
          if (choice === "confirm" && prop) {
            void executeProposalDecision(prop, "approve");
          }
        }}
      >
        <h2 id="confirm-dialog-title" style={{ marginTop: 0 }}>
          Confirm Write to Bugzilla #{confirmProposal?.bugId}
        </h2>
        <p>
          Visibility:{" "}
          <strong>
            {confirmProposal?.diff.publicComment
              ? "PUBLIC (visible to all bug readers)"
              : "Field update"}
          </strong>
        </p>
        <pre
          style={{
            padding: 10,
            borderRadius: 6,
            background: "var(--color-background-secondary, var(--bz-bg-secondary))",
            overflowX: "auto",
            fontSize: 12,
          }}
        >
          {confirmProposal ? JSON.stringify(confirmProposal.diff, null, 2) : ""}
        </pre>
        <form method="dialog" className="action-row" style={{ justifyContent: "flex-end" }}>
          <button type="submit" value="cancel" className="btn" autoFocus>
            Cancel
          </button>
          <button
            type="submit"
            value="confirm"
            className={confirmProposal?.diff.publicComment ? "btn btn-danger" : "btn btn-primary"}
          >
            Confirm Write
          </button>
        </form>
      </dialog>
    </main>
  );
}
