import type {
  BugDossier,
  BugSummary,
  DraftSaveResult,
  ProposalDiff,
  ProposalState,
} from "@bugzilla-mcp/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalizeBoardTenantKey, resolveBoardTenantKey } from "../tenant-key.js";
import {
  type AuthErrorKind,
  createBoundedIdempotencyKey,
  extractErrorMessage,
  extractLatestSnapshotView,
  extractWriteGuardOutcome,
  formatUpstreamRejectedMessage,
  isSafeHttpUrl,
  type LatestBugSnapshotView,
  normalizeSafeBugUrl,
  unwrapToolResult,
} from "../tool-result.js";
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
  readonly state: ProposalState;
  readonly approvalUrl?: string;
}

export interface TriageBoardPayload {
  readonly tenantKey?: string;
  readonly issuer?: string;
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
  readonly authErrorKind?: AuthErrorKind;
  readonly authErrorMessage?: string;
  readonly bindingUrl?: string;
  readonly initialDossier?: BugDossier;
}

export interface ConflictState {
  readonly proposal: UiProposalSummary;
  readonly expectedLastChangeTime: string;
  readonly actualLastChangeTime: string;
  readonly latestSnapshot?: LatestBugSnapshotView;
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
  readonly initialError?: string | null;
  readonly loading: boolean;
  readonly capabilities: McpAppHostCapabilities;
  readonly controller: TriageAppController;
  readonly gate: RpcGate;
  readonly callServerTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  readonly openExternalLink: (url: string) => Promise<void>;
}

const DEFAULT_RECONCILIATION_HINT =
  "Write status is indeterminate. Refresh from Bugzilla and verify whether the update landed before taking further action.";

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

export function TriageWorkbench({
  initialPayload,
  initialError = null,
  loading,
  capabilities,
  controller,
  gate,
  callServerTool,
  openExternalLink,
}: WorkbenchProps) {
  const anonBoardSeqRef = useRef(0);
  const boardSeqRef = useRef(0);
  const normalizeIncomingBoard = useCallback(
    (payload: TriageBoardPayload): TriageBoardPayload & { readonly tenantKey: string } =>
      normalizeBoardTenantKey(payload, () => `anon-wb-${++anonBoardSeqRef.current}`),
    [],
  );
  const [board, setBoard] = useState<TriageBoardPayload | null>(() =>
    initialPayload ? normalizeIncomingBoard(initialPayload) : null,
  );
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
  const [inlineError, setInlineError] = useState<string | null>(initialError);
  const [toast, setToast] = useState<string | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [confirmProposal, setConfirmProposal] = useState<UiProposalSummary | null>(null);
  const [indeterminateHints, setIndeterminateHints] = useState<Map<string, string>>(
    () => new Map(),
  );
  const [staleProposals, setStaleProposals] = useState<Set<string>>(() => new Set());
  const [inFlightProposals, setInFlightProposals] = useState<Set<string>>(() => new Set());
  const [drafts, setDrafts] = useState<Map<string, DraftEntry>>(() => new Map());
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const currentTenantKey = resolveBoardTenantKey(board);
  const lastTenantKeyRef = useRef<string>(currentTenantKey);

  const [isStaleBoard, setIsStaleBoard] = useState(false);

  useEffect(() => {
    if (initialError !== undefined) {
      setInlineError(initialError);
    }
  }, [initialError]);

  const checkBoardStale = useCallback((fetchedAt?: string) => {
    if (!fetchedAt) return false;
    const ageMs = Date.now() - Date.parse(fetchedAt);
    return Number.isFinite(ageMs) && ageMs > 5 * 60_000;
  }, []);

  const resetTenantScopedUiState = useCallback(
    (nextDossier: BugDossier | null = null) => {
      gate.bumpGeneration();
      setDrafts(new Map());
      setDossier(nextDossier);
      setDossierLoading(false);
      setSearchQuery("");
      setProductFilter("ALL");
      setSelectedIds(new Set());
      setFocusedIndex(0);
      setToast(null);
      setConflict(null);
      setConfirmProposal(null);
      setIndeterminateHints(new Map());
      setStaleProposals(new Set());
      setInFlightProposals(new Set());
      setInlineError(null);
      setPartialError(null);
    },
    [gate],
  );

  const activateAuthRequiredScreen = useCallback(
    (kind: AuthErrorKind, message: string, bindUrl?: string) => {
      gate.bumpGeneration();
      boardSeqRef.current += 1;
      setBoard((prev) => ({
        tenantKey: prev?.tenantKey ?? `unbound-${++anonBoardSeqRef.current}`,
        instanceUrl: prev?.instanceUrl ?? "",
        instanceLabel: prev?.instanceLabel ?? "Bugzilla",
        principalId: prev?.principalId ?? "",
        deploymentMode: prev?.deploymentMode ?? "cloud-multi-user",
        fetchedAt: new Date().toISOString(),
        bugs: [],
        proposals: [],
        unbound: true,
        authErrorKind: kind,
        authErrorMessage: message,
        ...(bindUrl && isSafeHttpUrl(bindUrl) ? { bindingUrl: bindUrl } : {}),
      }));
      setDossier(null);
      setDossierLoading(false);
      setActiveBugId(null);
      setConflict(null);
      setConfirmProposal(null);
      setInlineError(null);
      setPartialError(null);
      setToast(null);
    },
    [gate],
  );

  const safeOpenExternalLink = useCallback(
    async (
      rawUrl: string | undefined,
      label: string,
      originTenantKey: string,
      gen: number,
    ): Promise<boolean> => {
      if (!isSafeHttpUrl(rawUrl)) {
        if (lastTenantKeyRef.current === originTenantKey && gate.currentGeneration() === gen) {
          setInlineError(
            `Blocked unsafe ${label} URL: only http:// and https:// links are allowed.`,
          );
        }
        return false;
      }
      try {
        await openExternalLink(rawUrl);
        return true;
      } catch (err) {
        if (lastTenantKeyRef.current === originTenantKey && gate.currentGeneration() === gen) {
          setInlineError(extractErrorMessage(err, `Failed to open ${label} link.`));
        }
        return false;
      }
    },
    [gate, openExternalLink],
  );

  useEffect(() => {
    if (!initialPayload) return;
    const normalized = normalizeIncomingBoard(initialPayload);
    const nextTenantKey = normalized.tenantKey;
    const tenantChanged = lastTenantKeyRef.current !== nextTenantKey;
    lastTenantKeyRef.current = nextTenantKey;
    boardSeqRef.current += 1;
    setBoard(normalized);
    if (tenantChanged) {
      setActiveTab(normalized.activeTab ?? "pending_proposals");
      setActiveBugId(normalized.focusBugId ?? normalized.initialDossier?.bug.id ?? null);
      resetTenantScopedUiState(normalized.initialDossier ?? null);
    } else {
      if (normalized.activeTab) setActiveTab(normalized.activeTab);
      if (normalized.focusBugId !== undefined) setActiveBugId(normalized.focusBugId);
      // Clear stale dossier whenever a replacement board arrives without one (UI-03)
      setDossier(normalized.initialDossier ?? null);
    }
  }, [initialPayload, normalizeIncomingBoard, resetTenantScopedUiState]);

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

  const indeterminateProposalsByBug = useMemo(() => {
    const map = new Map<number, UiProposalSummary[]>();
    for (const p of board?.proposals ?? []) {
      const key = `${p.proposalId}@${p.revision}`;
      if (p.state !== "indeterminate" && !indeterminateHints.has(key)) continue;
      const list = map.get(p.bugId) ?? [];
      list.push(p);
      map.set(p.bugId, list);
    }
    return map;
  }, [board?.proposals, indeterminateHints]);

  const allIndeterminateProposals = useMemo(() => {
    const out: UiProposalSummary[] = [];
    for (const p of board?.proposals ?? []) {
      const key = `${p.proposalId}@${p.revision}`;
      if (p.state === "indeterminate" || indeterminateHints.has(key)) {
        out.push(p);
      }
    }
    return out;
  }, [board?.proposals, indeterminateHints]);

  const pendingProposalsByBug = useMemo(() => {
    const map = new Map<number, UiProposalSummary[]>();
    for (const p of board?.proposals ?? []) {
      const key = `${p.proposalId}@${p.revision}`;
      if (p.state !== "pending" || indeterminateHints.has(key)) continue;
      const list = map.get(p.bugId) ?? [];
      list.push(p);
      map.set(p.bugId, list);
    }
    return map;
  }, [board?.proposals, indeterminateHints]);

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
    (bugId: number) => `${currentTenantKey}::${bugId}::private_comment`,
    [currentTenantKey],
  );

  const openBugDetail = useCallback(
    async (bugId: number) => {
      setActiveBugId(bugId);
      // Clear previous bug's dossier immediately so private comments never bleed across bugs (UI-03)
      setDossier((prev) => (prev?.bug.id === bugId ? prev : null));
      setConflict(null);
      setPartialError(null);
      setInlineError(null);
      const originTenantKey = lastTenantKeyRef.current;
      const gen = gate.bumpGeneration();
      setDossierLoading(true);
      try {
        const res = await gate.runRead(gen, () =>
          callServerTool("app_get_bug_full", { bugId, maxComments: 20, maxHistory: 20 }),
        );
        if (res.stale || lastTenantKeyRef.current !== originTenantKey) return;
        const unwrapped = unwrapToolResult<{
          dossier?: BugDossier;
          draft?: { content: string; draftRevision: number } | null;
          proposals?: readonly UiProposalSummary[];
        }>(res.value);
        if (!unwrapped.ok) {
          if (
            unwrapped.kind === "credential_binding_required" ||
            unwrapped.kind === "credential_revoked"
          ) {
            activateAuthRequiredScreen(unwrapped.kind, unwrapped.message, unwrapped.bindUrl);
            return;
          }
          setPartialError(unwrapped.message);
          return;
        }
        const payload = unwrapped.data;
        if (payload.dossier && payload.dossier.bug.id === bugId) {
          setDossier(payload.dossier);
        }
        if (Array.isArray(payload.proposals)) {
          const bugProposals = payload.proposals;
          setBoard((prev) =>
            prev && resolveBoardTenantKey(prev) === originTenantKey
              ? {
                  ...prev,
                  proposals: [...prev.proposals.filter((p) => p.bugId !== bugId), ...bugProposals],
                }
              : prev,
          );
        }
        if ("draft" in payload) {
          const d = payload.draft;
          setDrafts((prev) => {
            const key = draftKey(bugId);
            const existing = prev.get(key);
            // Do not clobber dirty local edits with a delayed hydration response (UI-02)
            if (existing && (existing.status === "dirty" || existing.status === "saving")) {
              return prev;
            }
            const next = new Map(prev);
            if (d) {
              next.set(key, {
                content: d.content,
                revision: d.draftRevision,
                editSeq: existing?.editSeq ?? 0,
                status: "saved",
              });
            } else {
              // Explicitly clear stale cached draft when server reports null (ISO-04)
              next.delete(key);
            }
            return next;
          });
        }
      } catch (err) {
        if (lastTenantKeyRef.current === originTenantKey && gate.currentGeneration() === gen) {
          setPartialError(
            extractErrorMessage(
              err,
              "Failed to load full bug details. Core summary remains available.",
            ),
          );
        }
      } finally {
        if (gate.currentGeneration() === gen) {
          setDossierLoading(false);
        }
      }
    },
    [activateAuthRequiredScreen, callServerTool, draftKey, gate],
  );

  const refreshBoard = useCallback(async (): Promise<boolean> => {
    const originTenantKey = lastTenantKeyRef.current;
    const gen = gate.bumpGeneration();
    setInlineError(null);
    try {
      const res = await gate.runRead(gen, () =>
        callServerTool("bugzilla_triage_board", {
          tab: activeTab,
          ...(productFilter !== "ALL" ? { product: productFilter } : {}),
        }),
      );
      if (res.stale) return false;
      const unwrapped = unwrapToolResult<TriageBoardPayload>(res.value);
      if (!unwrapped.ok) {
        if (
          unwrapped.kind === "credential_binding_required" ||
          unwrapped.kind === "credential_revoked"
        ) {
          activateAuthRequiredScreen(unwrapped.kind, unwrapped.message, unwrapped.bindUrl);
          return false;
        }
        if (lastTenantKeyRef.current === originTenantKey && gate.currentGeneration() === gen) {
          setInlineError(unwrapped.message);
        }
        return false;
      }
      const payload = unwrapped.data;
      if (payload && Array.isArray(payload.bugs)) {
        const normalized = normalizeIncomingBoard(payload);
        const nextTenantKey = normalized.tenantKey;
        boardSeqRef.current += 1;
        if (lastTenantKeyRef.current !== nextTenantKey) {
          lastTenantKeyRef.current = nextTenantKey;
          setActiveTab(normalized.activeTab ?? "pending_proposals");
          setActiveBugId(normalized.focusBugId ?? normalized.initialDossier?.bug.id ?? null);
          resetTenantScopedUiState(normalized.initialDossier ?? null);
        } else {
          // Prune local indeterminate/stale markers for proposals resolved on the server
          const activeServerKeys = new Map<string, ProposalState>(
            normalized.proposals.map((p) => [`${p.proposalId}@${p.revision}`, p.state]),
          );
          setIndeterminateHints((prev) => {
            if (prev.size === 0) return prev;
            const next = new Map<string, string>();
            for (const [k, hint] of prev) {
              const serverState = activeServerKeys.get(k);
              if (serverState === "indeterminate") {
                next.set(k, hint);
              }
            }
            return next;
          });
          setStaleProposals((prev) => {
            if (prev.size === 0) return prev;
            const next = new Set<string>();
            for (const k of prev) {
              const serverState = activeServerKeys.get(k);
              if (serverState === "stale" || serverState === "pending") {
                next.add(k);
              }
            }
            return next;
          });
        }
        setBoard(normalized);
        return true;
      }
      if (lastTenantKeyRef.current === originTenantKey && gate.currentGeneration() === gen) {
        setInlineError("Server returned an unexpected triage board response.");
      }
      return false;
    } catch (err) {
      if (lastTenantKeyRef.current === originTenantKey && gate.currentGeneration() === gen) {
        setInlineError(extractErrorMessage(err, "Could not refresh queue from Bugzilla."));
      }
      return false;
    }
  }, [
    activateAuthRequiredScreen,
    activeTab,
    callServerTool,
    gate,
    normalizeIncomingBoard,
    productFilter,
    resetTenantScopedUiState,
  ]);

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
      const key = `${proposal.proposalId}@${proposal.revision}`;
      if (
        inFlightProposals.has(key) ||
        proposal.state === "stale" ||
        staleProposals.has(key) ||
        proposal.state === "indeterminate" ||
        indeterminateHints.has(key)
      ) {
        return;
      }
      if (checkBoardStale(board.fetchedAt)) {
        setIsStaleBoard(true);
        setInlineError("Board data is older than 5 minutes. Refresh before writing to Bugzilla.");
        return;
      }
      // Cloud multi-user approval MUST go through the authenticated HTTPS /approve page (UI-04)
      const originTenantKey = lastTenantKeyRef.current;
      const originBoardSeq = boardSeqRef.current;
      const gen = gate.currentGeneration();
      if (decision === "approve" && board.deploymentMode === "cloud-multi-user") {
        if (proposal.approvalUrl && capabilities.openLinks) {
          const opened = await safeOpenExternalLink(
            proposal.approvalUrl,
            "approval",
            originTenantKey,
            gen,
          );
          if (
            opened &&
            lastTenantKeyRef.current === originTenantKey &&
            gate.currentGeneration() === gen
          ) {
            setToast(
              "Opened secure HTTPS approval page. Submitting approval in your browser completes the write server-side — click Refresh to load the updated status.",
            );
          }
        } else {
          setInlineError("Cloud approval requires an authenticated HTTPS approval link.");
        }
        return;
      }
      const previousState = proposal.state;
      const rollbackOptimisticReject = () => {
        if (decision !== "reject") return;
        if (
          lastTenantKeyRef.current !== originTenantKey ||
          boardSeqRef.current !== originBoardSeq ||
          gate.currentGeneration() !== gen
        ) {
          return;
        }
        setBoard((prev) =>
          prev && resolveBoardTenantKey(prev) === originTenantKey
            ? {
                ...prev,
                proposals: prev.proposals.map((p) =>
                  p.proposalId === proposal.proposalId && p.revision === proposal.revision
                    ? { ...p, state: previousState }
                    : p,
                ),
              }
            : prev,
        );
      };

      setInFlightProposals((prev) => new Set(prev).add(key));
      setInlineError(null);

      // Optimistic update for reject (with board-seq & tenant-guarded rollback on ANY non-success: ISO-04-A)
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

      try {
        const idempotencyKey = createBoundedIdempotencyKey(
          decision,
          proposal.proposalId,
          proposal.revision,
        );
        const res = await gate.runWrite(gen, () =>
          callServerTool("app_resolve_proposal", {
            proposalId: proposal.proposalId,
            revision: proposal.revision,
            decision,
            idempotencyKey,
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
        if (res.stale || lastTenantKeyRef.current !== originTenantKey) return;

        const unwrapped = unwrapToolResult<Record<string, unknown>>(res.value);
        if (
          !unwrapped.ok &&
          (unwrapped.kind === "credential_binding_required" ||
            unwrapped.kind === "credential_revoked")
        ) {
          activateAuthRequiredScreen(unwrapped.kind, unwrapped.message, unwrapped.bindUrl);
          return;
        }

        const outcome = extractWriteGuardOutcome(unwrapped);

        if (outcome?.outcome === "ProposalRejected") {
          setToast(`Rejected proposal for Bug #${proposal.bugId}.`);
          const refreshed = await refreshBoard();
          if (!refreshed || lastTenantKeyRef.current !== originTenantKey) return;
          await openBugDetail(proposal.bugId);
          return;
        }

        if (outcome?.outcome === "Applied") {
          const isLegacyReject =
            decision === "reject" || String(outcome.artifactId ?? "").startsWith("rejected:");
          setToast(
            isLegacyReject
              ? `Rejected proposal for Bug #${proposal.bugId}.`
              : `Applied proposal to Bug #${proposal.bugId}.`,
          );
          const refreshed = await refreshBoard();
          if (!refreshed || lastTenantKeyRef.current !== originTenantKey) return;
          await openBugDetail(proposal.bugId);
          return;
        }

        if (outcome?.outcome === "DuplicateNoOp") {
          setToast(`Proposal action was already completed for Bug #${proposal.bugId}.`);
          const refreshed = await refreshBoard();
          if (!refreshed || lastTenantKeyRef.current !== originTenantKey) return;
          await openBugDetail(proposal.bugId);
          return;
        }

        // ANY non-applied / non-rejected outcome or isError response MUST roll back optimistic reject
        rollbackOptimisticReject();

        if (outcome?.outcome === "StaleBugConflict") {
          const expectedLastChangeTime = String(
            outcome.expectedLastChangeTime ?? proposal.baseVersion,
          );
          const actualLastChangeTime = String(outcome.actualLastChangeTime ?? "");
          const latestSnapshot = extractLatestSnapshotView(
            outcome.latestAuthorizedSnapshot,
            actualLastChangeTime,
          );
          setStaleProposals((prev) => new Set(prev).add(key));
          setConflict({
            proposal,
            expectedLastChangeTime,
            actualLastChangeTime,
            ...(latestSnapshot !== undefined
              ? { latestSnapshot, latestSummary: latestSnapshot.summary }
              : {}),
          });
          setInlineError(
            `Bug #${proposal.bugId} changed externally since this proposal was drafted. Review the latest snapshot and re-draft before approving.`,
          );
          return;
        }

        if (outcome?.outcome === "OperationIndeterminate") {
          const hint =
            typeof outcome.reconciliationHint === "string" &&
            outcome.reconciliationHint.trim().length > 0
              ? outcome.reconciliationHint.trim()
              : DEFAULT_RECONCILIATION_HINT;
          setIndeterminateHints((prev) => {
            const next = new Map(prev);
            next.set(key, hint);
            return next;
          });
          setInlineError(hint);
          return;
        }

        if (outcome?.outcome === "UpstreamRejected") {
          setInlineError(formatUpstreamRejectedMessage(outcome));
          return;
        }

        if (outcome?.outcome === "OperationPending") {
          setInlineError(
            "Another write attempt for this proposal is currently in progress. Wait a moment and refresh.",
          );
          return;
        }

        if (outcome?.outcome === "IdempotencyConflict") {
          setInlineError(
            "Idempotency conflict on proposal action. Refresh the board and try again.",
          );
          return;
        }

        if (outcome?.outcome === "CausalBudgetExhausted") {
          const retrySecs = Math.max(1, Math.ceil((outcome.retryAfterMs ?? 1000) / 1000));
          setInlineError(
            `Causal write budget exhausted for Bug #${proposal.bugId}. Retry in ${retrySecs}s.`,
          );
          return;
        }

        if (!unwrapped.ok) {
          setInlineError(unwrapped.message);
          if (decision === "reject") {
            setToast("Reject failed; restored proposal to pending.");
          }
          return;
        }

        setInlineError(
          `Proposal action returned unexpected status: ${outcome ? String(outcome.outcome) : "empty response"}.`,
        );
      } catch (err) {
        // Ignore stale rejections after a tenant switch, board replacement, or generation bump (ISO-04-A)
        if (
          lastTenantKeyRef.current !== originTenantKey ||
          boardSeqRef.current !== originBoardSeq ||
          gate.currentGeneration() !== gen
        ) {
          return;
        }
        rollbackOptimisticReject();
        const errMsg = extractErrorMessage(err, "Failed to execute proposal write.");
        setInlineError(errMsg);
        if (decision === "reject") {
          setToast("Reject failed; restored proposal to pending.");
        }
      } finally {
        setInFlightProposals((prev) => {
          if (!prev.has(key)) return prev;
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [
      activateAuthRequiredScreen,
      board,
      callServerTool,
      capabilities.openLinks,
      checkBoardStale,
      gate,
      inFlightProposals,
      indeterminateHints,
      openBugDetail,
      refreshBoard,
      safeOpenExternalLink,
      staleProposals,
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
      const previousRev = current?.revision ?? 0;
      const nextRev = previousRev + 1;
      const submittedSeq = current?.editSeq ?? 0;
      setDrafts((prev) => {
        const copy = new Map(prev);
        const latest = prev.get(k);
        copy.set(k, {
          content: latest?.content ?? nextContent,
          revision: previousRev,
          editSeq: latest?.editSeq ?? submittedSeq,
          status: "saving",
        });
        return copy;
      });
      const originTenantKey = lastTenantKeyRef.current;
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
        if (res.stale || lastTenantKeyRef.current !== originTenantKey) return;
        const unwrapped = unwrapToolResult<DraftSaveResult>(res.value);
        if (!unwrapped.ok) {
          if (
            unwrapped.kind === "credential_binding_required" ||
            unwrapped.kind === "credential_revoked"
          ) {
            activateAuthRequiredScreen(unwrapped.kind, unwrapped.message, unwrapped.bindUrl);
            return;
          }
          setDrafts((prev) => {
            const copy = new Map(prev);
            const latest = prev.get(k);
            copy.set(k, {
              content: latest?.content ?? nextContent,
              revision: previousRev,
              editSeq: latest?.editSeq ?? submittedSeq,
              status: latest && latest.editSeq !== submittedSeq ? "dirty" : "save_failed",
              error: unwrapped.message,
            });
            return copy;
          });
          return;
        }
        const result = unwrapped.data;
        setDrafts((prev) => {
          const copy = new Map(prev);
          const latest = prev.get(k);
          const hasNewerEdits = Boolean(latest && latest.editSeq !== submittedSeq);
          if (result.status === "acknowledged") {
            const ackRev =
              typeof result.draftRevision === "number" ? result.draftRevision : nextRev;
            copy.set(k, {
              content: latest?.content ?? nextContent,
              revision: ackRev,
              editSeq: latest?.editSeq ?? submittedSeq,
              status: hasNewerEdits ? "dirty" : "saved",
            });
          } else if (result.status === "stale_revision") {
            const serverRev =
              typeof result.currentRevision === "number" ? result.currentRevision : previousRev;
            copy.set(k, {
              content: latest?.content ?? nextContent,
              revision: serverRev,
              editSeq: latest?.editSeq ?? submittedSeq,
              status: hasNewerEdits ? "dirty" : "save_failed",
              error: `Draft was updated elsewhere (server revision ${serverRev}). Click Save Draft again to save your changes.`,
            });
          } else {
            copy.set(k, {
              content: latest?.content ?? nextContent,
              revision: previousRev,
              editSeq: latest?.editSeq ?? submittedSeq,
              status: hasNewerEdits ? "dirty" : "save_failed",
              error: "Unexpected draft save response from server.",
            });
          }
          return copy;
        });
      } catch (err) {
        if (lastTenantKeyRef.current !== originTenantKey || gate.currentGeneration() !== gen) {
          return;
        }
        const errMsg = extractErrorMessage(err, "Failed to save draft.");
        setDrafts((prev) => {
          const copy = new Map(prev);
          const latest = prev.get(k);
          copy.set(k, {
            content: latest?.content ?? nextContent,
            revision: previousRev,
            editSeq: latest?.editSeq ?? submittedSeq,
            status: latest && latest.editSeq !== submittedSeq ? "dirty" : "save_failed",
            error: errMsg,
          });
          return copy;
        });
      }
    },
    [
      activateAuthRequiredScreen,
      board?.fetchedAt,
      callServerTool,
      checkBoardStale,
      draftKey,
      drafts,
      gate,
    ],
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

  const activeBugIndeterminateProposals = useMemo(() => {
    if (activeBugId === null) return [];
    return indeterminateProposalsByBug.get(activeBugId) ?? [];
  }, [activeBugId, indeterminateProposalsByBug]);

  // UI State #8: Unbound / Rebind Required
  if (board?.unbound) {
    const isRevoked = board.authErrorKind === "credential_revoked";
    const safeBindUrl = isSafeHttpUrl(board.bindingUrl) ? board.bindingUrl : null;
    return (
      <main className="workbench-shell">
        <header className="topbar">
          <div className="topbar-title-group">
            <h1>Bugzilla Triage</h1>
            <span className={`instance-pill ${isRevoked ? "stale" : ""}`}>
              {isRevoked ? "Rebind Required" : "Unbound"}
            </span>
          </div>
          <button type="button" className="btn" onClick={() => void refreshBoard()}>
            Refresh
          </button>
        </header>
        {inlineError ? (
          <div className="inline-alert top-alert" role="alert">
            <span>{inlineError}</span>
            <button type="button" className="btn btn-ghost" onClick={() => setInlineError(null)}>
              Dismiss
            </button>
          </div>
        ) : null}
        <section className="empty-state">
          <h2>
            {isRevoked
              ? "Your Bugzilla API Key Was Revoked or Rejected"
              : "Bind your self-hosted Bugzilla API Key"}
          </h2>
          {board.authErrorMessage ? <p>{board.authErrorMessage}</p> : null}
          <p>
            API keys are never collected inside chat or this panel. Complete{" "}
            {isRevoked ? "re-binding" : "one-time HTTPS binding"} in your browser, then click
            Refresh to load your authorized queue.
          </p>
          <div className="action-row" style={{ justifyContent: "center" }}>
            {capabilities.openLinks && safeBindUrl ? (
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  const originTenantKey = lastTenantKeyRef.current;
                  const gen = gate.currentGeneration();
                  void safeOpenExternalLink(safeBindUrl, "binding", originTenantKey, gen);
                }}
              >
                {isRevoked ? "Re-bind Bugzilla API Key" : "Open Secure Binding Page"}
              </button>
            ) : null}
            <button type="button" className="btn" onClick={() => void refreshBoard()}>
              Refresh
            </button>
          </div>
        </section>
      </main>
    );
  }

  const currentDraft = activeBugId !== null ? drafts.get(draftKey(activeBugId)) : undefined;
  const safeActiveBugUrl =
    activeBug && board?.instanceUrl ? normalizeSafeBugUrl(board.instanceUrl, activeBug.id) : null;

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

      {inlineError ? (
        <div className="inline-alert top-alert" role="alert">
          <span>{inlineError}</span>
          <button type="button" className="btn btn-ghost" onClick={() => setInlineError(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {toast ? (
        <div className="selection-bar" role="status">
          <span>{toast}</span>
          <button type="button" className="btn btn-ghost" onClick={() => setToast(null)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {allIndeterminateProposals.length > 0 ? (
        <section
          className="reconciliation-card reconciliation-banner"
          aria-label="Proposals requiring reconciliation"
        >
          <div className="bug-row-top" style={{ justifyContent: "space-between" }}>
            <strong>
              Reconciliation Required ({allIndeterminateProposals.length} indeterminate proposal
              {allIndeterminateProposals.length > 1 ? "s" : ""})
            </strong>
            <button type="button" className="btn" onClick={() => void refreshBoard()}>
              Refresh from Bugzilla
            </button>
          </div>
          <p style={{ margin: "6px 0" }}>
            The following proposal write(s) have uncertain upstream status. Approve and Reject
            actions are disabled until reconciled against Bugzilla.
          </p>
          <div className="action-row">
            {allIndeterminateProposals.map((p) => {
              const pKey = `${p.proposalId}@${p.revision}`;
              return (
                <button
                  key={pKey}
                  type="button"
                  className="btn"
                  onClick={() => void openBugDetail(p.bugId)}
                >
                  Inspect Bug #{p.bugId} ({p.proposalId} rev {p.revision})
                </button>
              );
            })}
          </div>
        </section>
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
                const indeterminateCount = indeterminateProposalsByBug.get(bug.id)?.length ?? 0;
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
                        {indeterminateCount > 0 ? (
                          <span className="badge badge-warn">Needs reconciliation</span>
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
                        const originTenantKey = lastTenantKeyRef.current;
                        const gen = gate.currentGeneration();
                        const selected = (board?.bugs ?? [])
                          .filter((b) => selectedIds.has(b.id))
                          .map((b) => ({ bugId: b.id, title: b.summary }));
                        void controller
                          .attachSelectionToModelContext(selected)
                          .then(() => {
                            if (
                              lastTenantKeyRef.current === originTenantKey &&
                              gate.currentGeneration() === gen
                            ) {
                              setToast(`Attached ${selected.length} bug link(s) to next turn.`);
                            }
                          })
                          .catch((err) => {
                            if (
                              lastTenantKeyRef.current === originTenantKey &&
                              gate.currentGeneration() === gen
                            ) {
                              setInlineError(
                                extractErrorMessage(err, "Failed to attach selection to context."),
                              );
                            }
                          });
                      }}
                    >
                      Attach to Context
                    </button>
                    <button
                      type="button"
                      className="btn btn-ghost"
                      onClick={() => {
                        const originTenantKey = lastTenantKeyRef.current;
                        const gen = gate.currentGeneration();
                        void controller
                          .clearModelContext()
                          .then(() => {
                            if (
                              lastTenantKeyRef.current === originTenantKey &&
                              gate.currentGeneration() === gen
                            ) {
                              setToast("Cleared context.");
                            }
                          })
                          .catch((err) => {
                            if (
                              lastTenantKeyRef.current === originTenantKey &&
                              gate.currentGeneration() === gen
                            ) {
                              setInlineError(
                                extractErrorMessage(err, "Failed to clear model context."),
                              );
                            }
                          });
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
                      const originTenantKey = lastTenantKeyRef.current;
                      const gen = gate.currentGeneration();
                      const selected = (board?.bugs ?? [])
                        .filter((b) => selectedIds.has(b.id))
                        .map((b) => ({ bugId: b.id, title: b.summary }));
                      void controller.triggerInvestigate(selected).catch((err) => {
                        if (
                          lastTenantKeyRef.current === originTenantKey &&
                          gate.currentGeneration() === gen
                        ) {
                          setInlineError(
                            extractErrorMessage(err, "Failed to send investigation request."),
                          );
                        }
                      });
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
                {capabilities.openLinks && safeActiveBugUrl ? (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      const originTenantKey = lastTenantKeyRef.current;
                      const gen = gate.currentGeneration();
                      void safeOpenExternalLink(safeActiveBugUrl, "Bugzilla", originTenantKey, gen);
                    }}
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

              {/* Place 3: StaleBugConflict 3-column recovery view (inert text per [R-3d5465]) */}
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
                        <td>
                          {conflict.latestSnapshot?.lastChangeTime ?? conflict.actualLastChangeTime}
                        </td>
                        <td>{JSON.stringify(conflict.proposal.diff)}</td>
                      </tr>
                    </tbody>
                  </table>
                  {conflict.latestSnapshot ? (
                    <div className="bug-meta" style={{ marginTop: 8 }}>
                      <div>
                        <strong>Latest Snapshot Summary:</strong> {conflict.latestSnapshot.summary}
                      </div>
                      <div>
                        <strong>Latest Status:</strong> {conflict.latestSnapshot.status} ·{" "}
                        <strong>Last Changed:</strong> {conflict.latestSnapshot.lastChangeTime}
                      </div>
                    </div>
                  ) : null}
                  <div className="action-row">
                    {capabilities.message ? (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => {
                          const originTenantKey = lastTenantKeyRef.current;
                          const gen = gate.currentGeneration();
                          void controller
                            .triggerReEvaluateAfterConflict({
                              bugId: activeBug.id,
                              title: activeBug.summary,
                            })
                            .catch((err) => {
                              if (
                                lastTenantKeyRef.current === originTenantKey &&
                                gate.currentGeneration() === gen
                              ) {
                                setInlineError(
                                  extractErrorMessage(err, "Failed to send re-draft request."),
                                );
                              }
                            });
                        }}
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

              {/* Dedicated Reconciliation section for indeterminate proposals (persisted or in-session) */}
              {activeBugIndeterminateProposals.length > 0 ? (
                <section className="section-block" aria-label="Proposals pending reconciliation">
                  <h2>Reconciliation Required</h2>
                  {activeBugIndeterminateProposals.map((proposal) => {
                    const key = `${proposal.proposalId}@${proposal.revision}`;
                    const hint = indeterminateHints.get(key) ?? DEFAULT_RECONCILIATION_HINT;
                    return (
                      <div key={key} className="reconciliation-card" role="alert">
                        <div className="bug-row-top">
                          <strong>
                            Proposal {proposal.proposalId} (rev {proposal.revision})
                          </strong>
                          <span className="badge badge-warn">Indeterminate</span>
                        </div>
                        <p style={{ margin: "6px 0" }}>{hint}</p>
                        <div className="bug-meta">Diff: {JSON.stringify(proposal.diff)}</div>
                        <div className="action-row">
                          <button type="button" className="btn btn-primary" disabled>
                            Pending Reconciliation
                          </button>
                          <button type="button" className="btn" disabled>
                            Reject
                          </button>
                          <button type="button" className="btn" onClick={() => void refreshBoard()}>
                            Refresh from Bugzilla
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </section>
              ) : null}

              {/* Pending AI Proposals */}
              {activeBugProposals.map((proposal) => {
                const key = `${proposal.proposalId}@${proposal.revision}`;
                const isStaleProposal = proposal.state === "stale" || staleProposals.has(key);
                const isInFlight = inFlightProposals.has(key);
                const disabled = isStaleBoard || isStaleProposal || isInFlight;
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
                      {isStaleProposal ? <span className="badge badge-danger">Stale</span> : null}
                    </div>
                    <p style={{ margin: "6px 0" }}>{proposal.rationale}</p>
                    <div className="bug-meta">Diff: {JSON.stringify(proposal.diff)}</div>
                    <div className="action-row">
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={disabled}
                        onClick={() => setConfirmProposal(proposal)}
                      >
                        {isStaleProposal
                          ? "Stale — Re-draft Required"
                          : isInFlight
                            ? "Submitting..."
                            : "Review & Approve"}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={disabled}
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
                    disabled={isStaleBoard || currentDraft?.status === "saving"}
                    onClick={() => void handleSaveDraft(activeBug.id, currentDraft?.content ?? "")}
                  >
                    Save Draft
                  </button>
                </div>
                {currentDraft?.error ? (
                  <div className="inline-alert draft-error" role="alert">
                    {currentDraft.error}
                  </div>
                ) : null}
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
