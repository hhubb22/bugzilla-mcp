// Formal C0 State Machine: Write Guard, Idempotency & Proposal Lifecycle
// Maps to specs/architecture-and-contracts.md Section 4.2
module write_guard {
  // Domains (small finite scopes for exhaustive simulation)
  val PRINCIPALS = Set("alice", "bob")
  val KEYS = Set("k1", "k2", "k3")
  val PAYLOADS = Set("p1", "p2")
  val MAX_CAUSAL_BUDGET = 2

  type ReceiptStatus =
    | Pending
    | Applied
    | Failed
    | Indeterminate

  type Receipt = {
    status: ReceiptStatus,
    payload: str,
    dispatches: int,
    artifactId: int,
  }

  type ProposalState =
    | PropPending
    | PropApproved
    | PropRejected
    | PropApplied
    | PropStale
    | PropIndeterminate

  type Proposal = {
    principal: str,
    revision: int,
    baseVersion: int,
    payload: str,
    state: ProposalState,
    approvalConsumed: bool,
  }

  // State variables
  var bugVersion: int
  var insiderPrincipals: Set[str]
  var receipts: (str, str) -> Receipt     // key = (principal, idemKey)
  var proposals: int -> Proposal
  var nextProposalId: int
  var nextArtifactId: int
  var causalWritesUsed: int
  var publicWriteLog: List[{ authorized: bool, fromSafeAuto: bool, proposalId: int }]
  var internalNotesCount: int

  pure def rk(p: str, k: str): (str, str) = (p, k)

  action init = all {
    bugVersion' = 1,
    insiderPrincipals' = Set("alice"), // bob lacks insidergroup
    receipts' = Map(),
    proposals' = Map(),
    nextProposalId' = 1,
    nextArtifactId' = 100,
    causalWritesUsed' = 0,
    publicWriteLog' = List(),
    internalNotesCount' = 0,
  }

  // Environment: external human edits bug on Bugzilla directly
  action externalBugEdit = all {
    bugVersion' = bugVersion + 1,
    insiderPrincipals' = insiderPrincipals,
    receipts' = receipts,
    proposals' = proposals,
    nextProposalId' = nextProposalId,
    nextArtifactId' = nextArtifactId,
    causalWritesUsed' = causalWritesUsed,
    publicWriteLog' = publicWriteLog,
    internalNotesCount' = internalNotesCount,
  }

  // Safe-Auto private comment: fail-closed to internal note if not insider; respects idempotency & causal budget
  action safeAutoWrite(p: str, k: str, payload: str, responseLost: bool): bool = {
    val key = rk(p, k)
    val seen = receipts.keys().contains(key)
    all {
      causalWritesUsed < MAX_CAUSAL_BUDGET,
      if (seen) {
        // Replay or conflict: NEVER dispatch upstream again
        all {
          bugVersion' = bugVersion,
          insiderPrincipals' = insiderPrincipals,
          receipts' = receipts,
          proposals' = proposals,
          nextProposalId' = nextProposalId,
          nextArtifactId' = nextArtifactId,
          causalWritesUsed' = causalWritesUsed,
          publicWriteLog' = publicWriteLog,
          internalNotesCount' = internalNotesCount,
        }
      } else if (not(insiderPrincipals.contains(p))) {
        // Fail closed to local server internal note: ZERO public Bugzilla write
        all {
          bugVersion' = bugVersion,
          insiderPrincipals' = insiderPrincipals,
          receipts' = receipts.put(key, { status: Applied, payload: payload, dispatches: 0, artifactId: nextArtifactId }),
          proposals' = proposals,
          nextProposalId' = nextProposalId,
          nextArtifactId' = nextArtifactId + 1,
          causalWritesUsed' = causalWritesUsed + 1,
          publicWriteLog' = publicWriteLog,
          internalNotesCount' = internalNotesCount + 1,
        }
      } else if (responseLost) {
        // Upstream may have committed; lock key as Indeterminate, forbid automatic retry
        all {
          bugVersion' = bugVersion,
          insiderPrincipals' = insiderPrincipals,
          receipts' = receipts.put(key, { status: Indeterminate, payload: payload, dispatches: 1, artifactId: -1 }),
          proposals' = proposals,
          nextProposalId' = nextProposalId,
          nextArtifactId' = nextArtifactId,
          causalWritesUsed' = causalWritesUsed + 1,
          publicWriteLog' = publicWriteLog,
          internalNotesCount' = internalNotesCount,
        }
      } else {
        // Private Bugzilla write succeeded (not public)
        all {
          bugVersion' = bugVersion,
          insiderPrincipals' = insiderPrincipals,
          receipts' = receipts.put(key, { status: Applied, payload: payload, dispatches: 1, artifactId: nextArtifactId }),
          proposals' = proposals,
          nextProposalId' = nextProposalId,
          nextArtifactId' = nextArtifactId + 1,
          causalWritesUsed' = causalWritesUsed + 1,
          publicWriteLog' = publicWriteLog,
          internalNotesCount' = internalNotesCount,
        }
      }
    }
  }

  // Guarded-Write: create immutable proposal revision (0 upstream writes)
  action proposeGuarded(p: str, payload: str): bool = all {
    nextProposalId <= 4,
    proposals' = proposals.put(nextProposalId, {
      principal: p,
      revision: 1,
      baseVersion: bugVersion,
      payload: payload,
      state: PropPending,
      approvalConsumed: false,
    }),
    nextProposalId' = nextProposalId + 1,
    bugVersion' = bugVersion,
    insiderPrincipals' = insiderPrincipals,
    receipts' = receipts,
    nextArtifactId' = nextArtifactId,
    causalWritesUsed' = causalWritesUsed,
    publicWriteLog' = publicWriteLog,
    internalNotesCount' = internalNotesCount,
  }

  // Human approves exact proposal revision (only same principal, only from PropPending)
  action approveProposal(p: str, pid: int): bool = all {
    proposals.keys().contains(pid),
    val prop = proposals.get(pid)
    all {
      prop.principal == p,
      prop.state == PropPending,
      proposals' = proposals.put(pid, { ...prop, state: PropApproved }),
    },
    bugVersion' = bugVersion,
    insiderPrincipals' = insiderPrincipals,
    receipts' = receipts,
    nextProposalId' = nextProposalId,
    nextArtifactId' = nextArtifactId,
    causalWritesUsed' = causalWritesUsed,
    publicWriteLog' = publicWriteLog,
    internalNotesCount' = internalNotesCount,
  }

  // Human rejects proposal
  action rejectProposal(p: str, pid: int): bool = all {
    proposals.keys().contains(pid),
    val prop = proposals.get(pid)
    all {
      prop.principal == p,
      prop.state == PropPending or prop.state == PropApproved,
      not(prop.approvalConsumed),
      proposals' = proposals.put(pid, { ...prop, state: PropRejected }),
    },
    bugVersion' = bugVersion,
    insiderPrincipals' = insiderPrincipals,
    receipts' = receipts,
    nextProposalId' = nextProposalId,
    nextArtifactId' = nextArtifactId,
    causalWritesUsed' = causalWritesUsed,
    publicWriteLog' = publicWriteLog,
    internalNotesCount' = internalNotesCount,
  }

  // Execute approved proposal with pre-dispatch optimistic check & single-use approval consumption
  action executeProposal(p: str, pid: int, k: str, responseLost: bool): bool = {
    val key = rk(p, k)
    val seen = receipts.keys().contains(key)
    all {
      proposals.keys().contains(pid),
      val prop = proposals.get(pid)
      all {
        prop.principal == p,
        prop.state == PropApproved,
        not(prop.approvalConsumed),
        not(seen),
        if (bugVersion != prop.baseVersion) {
          // Pre-dispatch StaleBugConflict: zero upstream write, must rebase to new revision
          all {
            proposals' = proposals.put(pid, { ...prop, state: PropStale, approvalConsumed: true }),
            receipts' = receipts,
            bugVersion' = bugVersion,
            publicWriteLog' = publicWriteLog,
            nextArtifactId' = nextArtifactId,
          }
        } else if (responseLost) {
          // Response lost after dispatch: mark Indeterminate & consume approval (never auto-retry)
          all {
            proposals' = proposals.put(pid, { ...prop, state: PropIndeterminate, approvalConsumed: true }),
            receipts' = receipts.put(key, { status: Indeterminate, payload: prop.payload, dispatches: 1, artifactId: -1 }),
            bugVersion' = bugVersion + 1,
            publicWriteLog' = publicWriteLog.append({ authorized: true, fromSafeAuto: false, proposalId: pid }),
            nextArtifactId' = nextArtifactId,
          }
        } else {
          // Applied cleanly
          all {
            proposals' = proposals.put(pid, { ...prop, state: PropApplied, approvalConsumed: true }),
            receipts' = receipts.put(key, { status: Applied, payload: prop.payload, dispatches: 1, artifactId: nextArtifactId }),
            bugVersion' = bugVersion + 1,
            publicWriteLog' = publicWriteLog.append({ authorized: true, fromSafeAuto: false, proposalId: pid }),
            nextArtifactId' = nextArtifactId + 1,
          }
        }
      },
      insiderPrincipals' = insiderPrincipals,
      nextProposalId' = nextProposalId,
      causalWritesUsed' = causalWritesUsed,
      internalNotesCount' = internalNotesCount,
    }
  }

  action step = any {
    externalBugEdit,
    nondet p = oneOf(PRINCIPALS)
    nondet k = oneOf(KEYS)
    nondet pl = oneOf(PAYLOADS)
    nondet lost = oneOf(Set(true, false))
    safeAutoWrite(p, k, pl, lost),
    nondet p = oneOf(PRINCIPALS)
    nondet pl = oneOf(PAYLOADS)
    proposeGuarded(p, pl),
    nondet p = oneOf(PRINCIPALS)
    nondet pid = oneOf(Set(1, 2, 3, 4))
    approveProposal(p, pid),
    nondet p = oneOf(PRINCIPALS)
    nondet pid = oneOf(Set(1, 2, 3, 4))
    rejectProposal(p, pid),
    nondet p = oneOf(PRINCIPALS)
    nondet pid = oneOf(Set(1, 2, 3, 4))
    nondet k = oneOf(KEYS)
    nondet lost = oneOf(Set(true, false))
    executeProposal(p, pid, k, lost),
  }

  // Safety Invariants
  val noUnauthorizedPublicWrite =
    publicWriteLog.indices().forall(i =>
      val entry = publicWriteLog[i]
      entry.authorized and not(entry.fromSafeAuto)
    )

  val noDoubleDispatchPerReceipt =
    receipts.keys().forall(k => receipts.get(k).dispatches <= 1)

  val causalBudgetBounded =
    causalWritesUsed <= MAX_CAUSAL_BUDGET

  val singleUseProposalExecution =
    proposals.keys().forall(pid =>
      val count = publicWriteLog.indices().filter(i => publicWriteLog[i].proposalId == pid).size()
      count <= 1
    )

  val allSafetyInvariants = and {
    noUnauthorizedPublicWrite,
    noDoubleDispatchPerReceipt,
    causalBudgetBounded,
    singleUseProposalExecution,
  }
}
