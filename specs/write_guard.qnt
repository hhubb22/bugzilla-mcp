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

  type OpKind =
    | OpSafeAuto
    | OpCreateBug
    | OpGuardedPolicy
    | OpGuardedProposal

  type LastOutcome =
    | OutcomeNone
    | OutcomePending
    | OutcomeApplied
    | OutcomeCertainNonWrite
    | OutcomePreDispatchFail
    | OutcomeUncertain
    | OutcomeSavedInternalNote

  type DispatchKind =
    | KindCertainNonWrite
    | KindUncertain
    | KindSuccess
    | KindLeaseExpiredPostDispatch

  type Receipt = {
    status: ReceiptStatus,
    op: OpKind,
    payload: str,
    dispatches: int,
    artifactId: int,
    leaseToken: int,
    dispatchAttempted: bool,
    leaseExpired: bool,
    proposalId: int,
    baseVersion: int,
    everApplied: bool,
    lastOutcome: LastOutcome,
    budgetCharged: bool,
    auditDegraded: bool,
  }

  type ProposalState =
    | PropPending
    | PropApproved
    | PropExecuting
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
    leaseToken: int,
    everApplied: bool,
  }

  type InFlightLease = {
    key: (str, str),
    principal: str,
    op: OpKind,
    proposalId: int,
  }

  // State variables
  var bugVersion: int
  var insiderPrincipals: Set[str]
  var policyPrincipals: Set[str]
  var receipts: (str, str) -> Receipt     // key = (principal, idemKey)
  var proposals: int -> Proposal
  var inFlight: int -> InFlightLease      // leaseToken -> lease metadata (includes stale leases for CAS tests)
  var nextLeaseToken: int
  var nextProposalId: int
  var nextArtifactId: int
  var causalWritesUsed: int
  var publicWriteLog: List[{ authorized: bool, fromSafeAuto: bool, proposalId: int }]
  var dispatchLog: List[{ key: (str, str), leaseToken: int, kind: DispatchKind, upstreamMutated: bool, resultedIndeterminate: bool }]
  var internalNotesCount: int

  pure def rk(p: str, k: str): (str, str) = (p, k)

  action init = all {
    bugVersion' = 1,
    insiderPrincipals' = Set("alice"), // bob lacks insidergroup
    policyPrincipals' = Set("alice"),  // bob lacks guarded policy grant
    receipts' = Map(),
    proposals' = Map(),
    inFlight' = Map(),
    nextLeaseToken' = 1,
    nextProposalId' = 1,
    nextArtifactId' = 100,
    causalWritesUsed' = 0,
    publicWriteLog' = List(),
    dispatchLog' = List(),
    internalNotesCount' = 0,
  }

  // Environment: external human edits bug on Bugzilla directly
  action externalBugEdit = all {
    bugVersion' = bugVersion + 1,
    insiderPrincipals' = insiderPrincipals,
    policyPrincipals' = policyPrincipals,
    receipts' = receipts,
    proposals' = proposals,
    inFlight' = inFlight,
    nextLeaseToken' = nextLeaseToken,
    nextProposalId' = nextProposalId,
    nextArtifactId' = nextArtifactId,
    causalWritesUsed' = causalWritesUsed,
    publicWriteLog' = publicWriteLog,
    dispatchLog' = dispatchLog,
    internalNotesCount' = internalNotesCount,
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
      leaseToken: 0,
      everApplied: false,
    }),
    nextProposalId' = nextProposalId + 1,
    bugVersion' = bugVersion,
    insiderPrincipals' = insiderPrincipals,
    policyPrincipals' = policyPrincipals,
    receipts' = receipts,
    inFlight' = inFlight,
    nextLeaseToken' = nextLeaseToken,
    nextArtifactId' = nextArtifactId,
    causalWritesUsed' = causalWritesUsed,
    publicWriteLog' = publicWriteLog,
    dispatchLog' = dispatchLog,
    internalNotesCount' = internalNotesCount,
  }

  // Human approves exact proposal revision (only same principal, only from PropPending)
  action approveProposal(p: str, pid: int): bool = all {
    proposals.keys().contains(pid),
    val prop = proposals.get(pid)
    all {
      prop.principal == p,
      prop.state == PropPending,
      proposals' = proposals.put(pid, { ...prop, state: PropApproved, approvalConsumed: false }),
    },
    bugVersion' = bugVersion,
    insiderPrincipals' = insiderPrincipals,
    policyPrincipals' = policyPrincipals,
    receipts' = receipts,
    inFlight' = inFlight,
    nextLeaseToken' = nextLeaseToken,
    nextProposalId' = nextProposalId,
    nextArtifactId' = nextArtifactId,
    causalWritesUsed' = causalWritesUsed,
    publicWriteLog' = publicWriteLog,
    dispatchLog' = dispatchLog,
    internalNotesCount' = internalNotesCount,
  }

  // Human rejects proposal -> distinct ProposalRejected outcome (0 upstream writes)
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
    policyPrincipals' = policyPrincipals,
    receipts' = receipts,
    inFlight' = inFlight,
    nextLeaseToken' = nextLeaseToken,
    nextProposalId' = nextProposalId,
    nextArtifactId' = nextArtifactId,
    causalWritesUsed' = causalWritesUsed,
    publicWriteLog' = publicWriteLog,
    dispatchLog' = dispatchLog,
    internalNotesCount' = internalNotesCount,
  }

  // Stage 2: Reserve Pending receipt with fresh leaseToken.
  // Allows reclaiming Failed or expired Pending ONLY when not(dispatchAttempted).
  action reservePending(p: str, k: str, op: OpKind, payload: str, pid: int): bool = {
    val key = rk(p, k)
    val seen = receipts.keys().contains(key)
    val canReserve = if (not(seen)) true else {
      val prev = receipts.get(key)
      prev.status == Failed or (prev.status == Pending and prev.leaseExpired and not(prev.dispatchAttempted))
    }
    val prevDispatches = if (seen) receipts.get(key).dispatches else 0
    val prevEverApplied = if (seen) receipts.get(key).everApplied else false
    val token = nextLeaseToken
    all {
      nextLeaseToken <= 12,
      canReserve,
      if (op == OpSafeAuto) {
        pid == -1 and causalWritesUsed < MAX_CAUSAL_BUDGET
      } else if (op == OpCreateBug) {
        pid == -1
      } else if (op == OpGuardedPolicy) {
        pid == -1 and policyPrincipals.contains(p)
      } else {
        // OpGuardedProposal
        proposals.keys().contains(pid) and {
          val prop = proposals.get(pid)
          prop.principal == p and prop.state == PropApproved and not(prop.approvalConsumed)
        }
      },
      {
        val effPayload = if (op == OpGuardedProposal) proposals.get(pid).payload else payload
        val effBaseVersion = if (op == OpGuardedProposal) proposals.get(pid).baseVersion else bugVersion
        all {
          receipts' = receipts.put(key, {
            status: Pending,
            op: op,
            payload: effPayload,
            dispatches: prevDispatches,
            artifactId: -1,
            leaseToken: token,
            dispatchAttempted: false,
            leaseExpired: false,
            proposalId: pid,
            baseVersion: effBaseVersion,
            everApplied: prevEverApplied,
            lastOutcome: OutcomePending,
            budgetCharged: false,
            auditDegraded: false,
          }),
          proposals' = if (op == OpGuardedProposal) {
            val prop = proposals.get(pid)
            proposals.put(pid, { ...prop, state: PropExecuting, leaseToken: token })
          } else proposals,
          inFlight' = inFlight.put(token, {
            key: key,
            principal: p,
            op: op,
            proposalId: pid,
          }),
        }
      },
      nextLeaseToken' = nextLeaseToken + 1,
      bugVersion' = bugVersion,
      insiderPrincipals' = insiderPrincipals,
      policyPrincipals' = policyPrincipals,
      nextProposalId' = nextProposalId,
      nextArtifactId' = nextArtifactId,
      causalWritesUsed' = causalWritesUsed,
      publicWriteLog' = publicWriteLog,
      dispatchLog' = dispatchLog,
      internalNotesCount' = internalNotesCount,
    }
  }

  // Safe-Auto fail-closed path: principal lacks insidergroup -> local internal note
  // Zero public/upstream write; retains causal budget consumption per #13 #6.
  action safeAutoSaveInternalNote(token: int): bool = all {
    inFlight.keys().contains(token),
    {
      val lease = inFlight.get(token)
      all {
        receipts.keys().contains(lease.key),
        {
          val rec = receipts.get(lease.key)
          all {
            rec.status == Pending,
            rec.leaseToken == token,
            not(rec.leaseExpired),
            not(rec.dispatchAttempted),
            rec.op == OpSafeAuto,
            not(insiderPrincipals.contains(lease.principal)),
            causalWritesUsed < MAX_CAUSAL_BUDGET,
            receipts' = receipts.put(lease.key, {
              ...rec,
              status: Applied,
              artifactId: nextArtifactId,
              everApplied: true,
              lastOutcome: OutcomeSavedInternalNote,
              budgetCharged: true,
            }),
          }
        },
      }
    },
    nextArtifactId' = nextArtifactId + 1,
    causalWritesUsed' = causalWritesUsed + 1,
    internalNotesCount' = internalNotesCount + 1,
    bugVersion' = bugVersion,
    insiderPrincipals' = insiderPrincipals,
    policyPrincipals' = policyPrincipals,
    proposals' = proposals,
    inFlight' = inFlight,
    nextLeaseToken' = nextLeaseToken,
    nextProposalId' = nextProposalId,
    publicWriteLog' = publicWriteLog,
    dispatchLog' = dispatchLog,
  }

  // Stage 2 pre-dispatch failure: CAS on leaseToken -> receipt Failed, PropExecuting -> PropPending
  action preDispatchFail(token: int): bool = all {
    inFlight.keys().contains(token),
    {
      val lease = inFlight.get(token)
      all {
        receipts.keys().contains(lease.key),
        {
          val rec = receipts.get(lease.key)
          all {
            rec.status == Pending,
            rec.leaseToken == token,
            not(rec.leaseExpired),
            not(rec.dispatchAttempted),
            receipts' = receipts.put(lease.key, {
              ...rec,
              status: Failed,
              lastOutcome: OutcomePreDispatchFail,
            }),
            proposals' = if (rec.op == OpGuardedProposal and proposals.keys().contains(rec.proposalId)) {
              val prop = proposals.get(rec.proposalId)
              if (prop.state == PropExecuting and prop.leaseToken == token)
                proposals.put(rec.proposalId, { ...prop, state: PropPending, leaseToken: 0 })
              else proposals
            } else proposals,
          }
        },
      }
    },
    bugVersion' = bugVersion,
    insiderPrincipals' = insiderPrincipals,
    policyPrincipals' = policyPrincipals,
    inFlight' = inFlight,
    nextLeaseToken' = nextLeaseToken,
    nextProposalId' = nextProposalId,
    nextArtifactId' = nextArtifactId,
    causalWritesUsed' = causalWritesUsed,
    publicWriteLog' = publicWriteLog,
    dispatchLog' = dispatchLog,
    internalNotesCount' = internalNotesCount,
  }

  // Stage 2 optimistic last_change_time mismatch: 0 upstream writes, receipt Failed, proposal PropStale
  action preDispatchStale(token: int): bool = all {
    inFlight.keys().contains(token),
    {
      val lease = inFlight.get(token)
      all {
        receipts.keys().contains(lease.key),
        {
          val rec = receipts.get(lease.key)
          all {
            rec.status == Pending,
            rec.leaseToken == token,
            not(rec.leaseExpired),
            not(rec.dispatchAttempted),
            rec.op == OpGuardedProposal or rec.op == OpGuardedPolicy,
            bugVersion != rec.baseVersion,
            receipts' = receipts.put(lease.key, {
              ...rec,
              status: Failed,
              lastOutcome: OutcomePreDispatchFail,
            }),
            proposals' = if (rec.op == OpGuardedProposal and proposals.keys().contains(rec.proposalId)) {
              val prop = proposals.get(rec.proposalId)
              if (prop.state == PropExecuting and prop.leaseToken == token)
                proposals.put(rec.proposalId, { ...prop, state: PropStale, approvalConsumed: true, leaseToken: 0 })
              else proposals
            } else proposals,
          }
        },
      }
    },
    bugVersion' = bugVersion,
    insiderPrincipals' = insiderPrincipals,
    policyPrincipals' = policyPrincipals,
    inFlight' = inFlight,
    nextLeaseToken' = nextLeaseToken,
    nextProposalId' = nextProposalId,
    nextArtifactId' = nextArtifactId,
    causalWritesUsed' = causalWritesUsed,
    publicWriteLog' = publicWriteLog,
    dispatchLog' = dispatchLog,
    internalNotesCount' = internalNotesCount,
  }

  // Lease expiry: if dispatchAttempted == true, transition to Indeterminate (never re-dispatches!).
  // If dispatchAttempted == false, mark leaseExpired = true and release PropExecuting -> PropPending.
  action expirePendingLease(p: str, k: str): bool = {
    val key = rk(p, k)
    all {
      receipts.keys().contains(key),
      {
        val rec = receipts.get(key)
        all {
          rec.status == Pending,
          not(rec.leaseExpired),
          if (rec.dispatchAttempted) {
            all {
              receipts' = receipts.put(key, {
                ...rec,
                status: Indeterminate,
                leaseExpired: true,
                dispatches: rec.dispatches + 1,
                lastOutcome: OutcomeUncertain,
              }),
              proposals' = if (rec.op == OpGuardedProposal and proposals.keys().contains(rec.proposalId)) {
                val prop = proposals.get(rec.proposalId)
                proposals.put(rec.proposalId, { ...prop, state: PropIndeterminate, approvalConsumed: true })
              } else proposals,
              publicWriteLog' = if (rec.op == OpSafeAuto) publicWriteLog
                else publicWriteLog.append({ authorized: true, fromSafeAuto: false, proposalId: rec.proposalId }),
              dispatchLog' = dispatchLog.append({
                key: key,
                leaseToken: rec.leaseToken,
                kind: KindLeaseExpiredPostDispatch,
                upstreamMutated: true,
                resultedIndeterminate: true,
              }),
            }
          } else {
            all {
              receipts' = receipts.put(key, { ...rec, leaseExpired: true }),
              proposals' = if (rec.op == OpGuardedProposal and proposals.keys().contains(rec.proposalId)) {
                val prop = proposals.get(rec.proposalId)
                if (prop.state == PropExecuting and prop.leaseToken == rec.leaseToken)
                  proposals.put(rec.proposalId, { ...prop, state: PropPending, leaseToken: 0 })
                else proposals
              } else proposals,
              publicWriteLog' = publicWriteLog,
              dispatchLog' = dispatchLog,
            }
          },
        }
      },
      bugVersion' = bugVersion,
      insiderPrincipals' = insiderPrincipals,
      policyPrincipals' = policyPrincipals,
      inFlight' = inFlight,
      nextLeaseToken' = nextLeaseToken,
      nextProposalId' = nextProposalId,
      nextArtifactId' = nextArtifactId,
      causalWritesUsed' = causalWritesUsed,
      internalNotesCount' = internalNotesCount,
    }
  }

  // Stage 3 commit-threshold fence: CAS on (Pending, leaseToken, !leaseExpired) before single HTTP write.
  action markDispatchStarted(token: int): bool = all {
    inFlight.keys().contains(token),
    {
      val lease = inFlight.get(token)
      all {
        receipts.keys().contains(lease.key),
        {
          val rec = receipts.get(lease.key)
          all {
            rec.status == Pending,
            rec.leaseToken == token,
            not(rec.leaseExpired),
            not(rec.dispatchAttempted),
            if (rec.op == OpSafeAuto)
              insiderPrincipals.contains(lease.principal) and causalWritesUsed < MAX_CAUSAL_BUDGET
            else if (rec.op == OpGuardedPolicy)
              policyPrincipals.contains(lease.principal) and bugVersion == rec.baseVersion
            else if (rec.op == OpGuardedProposal)
              proposals.keys().contains(rec.proposalId)
                and proposals.get(rec.proposalId).state == PropExecuting
                and proposals.get(rec.proposalId).leaseToken == token
                and bugVersion == rec.baseVersion
            else true,
            receipts' = receipts.put(lease.key, {
              ...rec,
              dispatchAttempted: true,
              budgetCharged: rec.op == OpSafeAuto,
            }),
            causalWritesUsed' = if (rec.op == OpSafeAuto) causalWritesUsed + 1 else causalWritesUsed,
            proposals' = if (rec.op == OpGuardedProposal) {
              val prop = proposals.get(rec.proposalId)
              proposals.put(rec.proposalId, { ...prop, approvalConsumed: true })
            } else proposals,
          }
        },
      }
    },
    bugVersion' = bugVersion,
    insiderPrincipals' = insiderPrincipals,
    policyPrincipals' = policyPrincipals,
    inFlight' = inFlight,
    nextLeaseToken' = nextLeaseToken,
    nextProposalId' = nextProposalId,
    nextArtifactId' = nextArtifactId,
    publicWriteLog' = publicWriteLog,
    dispatchLog' = dispatchLog,
    internalNotesCount' = internalNotesCount,
  }

  // Certain non-write (4xx validation / 401 / 403 / 429): 0 upstream mutations, CAS on leaseToken,
  // receipt -> Failed, proposal PropExecuting -> PropPending, refund causal budget if charged.
  action dispatchCertainNonWrite(token: int): bool = all {
    inFlight.keys().contains(token),
    {
      val lease = inFlight.get(token)
      all {
        receipts.keys().contains(lease.key),
        {
          val rec = receipts.get(lease.key)
          all {
            rec.status == Pending,
            rec.leaseToken == token,
            not(rec.leaseExpired),
            rec.dispatchAttempted,
            receipts' = receipts.put(lease.key, {
              ...rec,
              status: Failed,
              dispatchAttempted: false,
              lastOutcome: OutcomeCertainNonWrite,
              budgetCharged: false,
            }),
            proposals' = if (rec.op == OpGuardedProposal and proposals.keys().contains(rec.proposalId)) {
              val prop = proposals.get(rec.proposalId)
              if (prop.state == PropExecuting and prop.leaseToken == token)
                proposals.put(rec.proposalId, { ...prop, state: PropPending, leaseToken: 0 })
              else proposals
            } else proposals,
            causalWritesUsed' = if (rec.budgetCharged) causalWritesUsed - 1 else causalWritesUsed,
            dispatchLog' = dispatchLog.append({
              key: lease.key,
              leaseToken: token,
              kind: KindCertainNonWrite,
              upstreamMutated: false,
              resultedIndeterminate: false,
            }),
          }
        },
      }
    },
    bugVersion' = bugVersion,
    insiderPrincipals' = insiderPrincipals,
    policyPrincipals' = policyPrincipals,
    inFlight' = inFlight,
    nextLeaseToken' = nextLeaseToken,
    nextProposalId' = nextProposalId,
    nextArtifactId' = nextArtifactId,
    publicWriteLog' = publicWriteLog,
    internalNotesCount' = internalNotesCount,
  }

  // Uncertain outcome (timeout / 5xx / network drop after dispatchAttempted = true)
  action dispatchUncertain(token: int): bool = all {
    inFlight.keys().contains(token),
    {
      val lease = inFlight.get(token)
      all {
        receipts.keys().contains(lease.key),
        {
          val rec = receipts.get(lease.key)
          all {
            rec.status == Pending,
            rec.leaseToken == token,
            not(rec.leaseExpired),
            rec.dispatchAttempted,
            receipts' = receipts.put(lease.key, {
              ...rec,
              status: Indeterminate,
              dispatches: rec.dispatches + 1,
              lastOutcome: OutcomeUncertain,
            }),
            proposals' = if (rec.op == OpGuardedProposal and proposals.keys().contains(rec.proposalId)) {
              val prop = proposals.get(rec.proposalId)
              proposals.put(rec.proposalId, { ...prop, state: PropIndeterminate, approvalConsumed: true })
            } else proposals,
            bugVersion' = if (rec.op == OpGuardedProposal or rec.op == OpGuardedPolicy) bugVersion + 1 else bugVersion,
            publicWriteLog' = if (rec.op == OpSafeAuto) publicWriteLog
              else publicWriteLog.append({ authorized: true, fromSafeAuto: false, proposalId: rec.proposalId }),
            dispatchLog' = dispatchLog.append({
              key: lease.key,
              leaseToken: token,
              kind: KindUncertain,
              upstreamMutated: true,
              resultedIndeterminate: true,
            }),
          }
        },
      }
    },
    insiderPrincipals' = insiderPrincipals,
    policyPrincipals' = policyPrincipals,
    inFlight' = inFlight,
    nextLeaseToken' = nextLeaseToken,
    nextProposalId' = nextProposalId,
    nextArtifactId' = nextArtifactId,
    causalWritesUsed' = causalWritesUsed,
    internalNotesCount' = internalNotesCount,
  }

  // Stage 4: Upstream succeeded -> atomically commit Applied receipt & PropApplied
  action dispatchSuccessAndCommit(token: int): bool = all {
    inFlight.keys().contains(token),
    {
      val lease = inFlight.get(token)
      all {
        receipts.keys().contains(lease.key),
        {
          val rec = receipts.get(lease.key)
          all {
            rec.status == Pending,
            rec.leaseToken == token,
            not(rec.leaseExpired),
            rec.dispatchAttempted,
            receipts' = receipts.put(lease.key, {
              ...rec,
              status: Applied,
              dispatches: rec.dispatches + 1,
              artifactId: nextArtifactId,
              everApplied: true,
              lastOutcome: OutcomeApplied,
            }),
            proposals' = if (rec.op == OpGuardedProposal and proposals.keys().contains(rec.proposalId)) {
              val prop = proposals.get(rec.proposalId)
              proposals.put(rec.proposalId, { ...prop, state: PropApplied, approvalConsumed: true, everApplied: true })
            } else proposals,
            bugVersion' = if (rec.op == OpGuardedProposal or rec.op == OpGuardedPolicy) bugVersion + 1 else bugVersion,
            publicWriteLog' = if (rec.op == OpSafeAuto) publicWriteLog
              else publicWriteLog.append({ authorized: true, fromSafeAuto: false, proposalId: rec.proposalId }),
            dispatchLog' = dispatchLog.append({
              key: lease.key,
              leaseToken: token,
              kind: KindSuccess,
              upstreamMutated: true,
              resultedIndeterminate: false,
            }),
          }
        },
      }
    },
    nextArtifactId' = nextArtifactId + 1,
    insiderPrincipals' = insiderPrincipals,
    policyPrincipals' = policyPrincipals,
    inFlight' = inFlight,
    nextLeaseToken' = nextLeaseToken,
    nextProposalId' = nextProposalId,
    causalWritesUsed' = causalWritesUsed,
    internalNotesCount' = internalNotesCount,
  }

  // Post-commit local persistence / follow-up GET error after upstream succeeded:
  // receipt & proposal NEVER regress from Applied to Pending or Indeterminate.
  action postCommitLocalError(p: str, k: str): bool = {
    val key = rk(p, k)
    all {
      receipts.keys().contains(key),
      {
        val rec = receipts.get(key)
        all {
          rec.status == Applied,
          receipts' = receipts.put(key, { ...rec, auditDegraded: true }),
        }
      },
      bugVersion' = bugVersion,
      insiderPrincipals' = insiderPrincipals,
      policyPrincipals' = policyPrincipals,
      proposals' = proposals,
      inFlight' = inFlight,
      nextLeaseToken' = nextLeaseToken,
      nextProposalId' = nextProposalId,
      nextArtifactId' = nextArtifactId,
      causalWritesUsed' = causalWritesUsed,
      publicWriteLog' = publicWriteLog,
      dispatchLog' = dispatchLog,
      internalNotesCount' = internalNotesCount,
    }
  }

  // Stale worker waking up after lease reclamation / expiry is fenced out by leaseToken CAS (0 side effects).
  action fencedStaleWorkerAttempt(token: int): bool = all {
    inFlight.keys().contains(token),
    {
      val lease = inFlight.get(token)
      all {
        receipts.keys().contains(lease.key),
        {
          val rec = receipts.get(lease.key)
          not(rec.status == Pending and rec.leaseToken == token and not(rec.leaseExpired))
        },
      }
    },
    bugVersion' = bugVersion,
    insiderPrincipals' = insiderPrincipals,
    policyPrincipals' = policyPrincipals,
    receipts' = receipts,
    proposals' = proposals,
    inFlight' = inFlight,
    nextLeaseToken' = nextLeaseToken,
    nextProposalId' = nextProposalId,
    nextArtifactId' = nextArtifactId,
    causalWritesUsed' = causalWritesUsed,
    publicWriteLog' = publicWriteLog,
    dispatchLog' = dispatchLog,
    internalNotesCount' = internalNotesCount,
  }

  action step = any {
    externalBugEdit,
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
    nondet k = oneOf(KEYS)
    nondet op = oneOf(Set(OpSafeAuto, OpCreateBug, OpGuardedPolicy, OpGuardedProposal))
    nondet pl = oneOf(PAYLOADS)
    nondet pid = oneOf(Set(-1, 1, 2, 3, 4))
    reservePending(p, k, op, pl, pid),
    nondet token = oneOf(1.to(12))
    safeAutoSaveInternalNote(token),
    nondet token = oneOf(1.to(12))
    preDispatchFail(token),
    nondet token = oneOf(1.to(12))
    preDispatchStale(token),
    nondet p = oneOf(PRINCIPALS)
    nondet k = oneOf(KEYS)
    expirePendingLease(p, k),
    nondet token = oneOf(1.to(12))
    markDispatchStarted(token),
    nondet token = oneOf(1.to(12))
    dispatchCertainNonWrite(token),
    nondet token = oneOf(1.to(12))
    dispatchUncertain(token),
    nondet token = oneOf(1.to(12))
    dispatchSuccessAndCommit(token),
    nondet p = oneOf(PRINCIPALS)
    nondet k = oneOf(KEYS)
    postCommitLocalError(p, k),
    nondet token = oneOf(1.to(12))
    fencedStaleWorkerAttempt(token),
  }

  // Safety Invariants
  val noIndeterminateOnCertainNonWrite = and {
    dispatchLog.indices().forall(i =>
      val entry = dispatchLog[i]
      (entry.kind == KindCertainNonWrite) implies (not(entry.upstreamMutated) and not(entry.resultedIndeterminate))
    ),
    receipts.keys().forall(k =>
      val rec = receipts.get(k)
      (rec.lastOutcome == OutcomeCertainNonWrite) implies (rec.status == Failed)
    ),
  }

  val noAppliedRegression = and {
    receipts.keys().forall(k =>
      val rec = receipts.get(k)
      rec.everApplied implies (rec.status == Applied and rec.artifactId >= 100)
    ),
    proposals.keys().forall(pid =>
      val prop = proposals.get(pid)
      prop.everApplied implies (prop.state == PropApplied)
    ),
  }

  val noDoubleDispatchPerReceipt = and {
    receipts.keys().forall(k => receipts.get(k).dispatches <= 1),
    receipts.keys().forall(k =>
      val mutatingCount = dispatchLog.indices().filter(i =>
        dispatchLog[i].key == k and dispatchLog[i].kind != KindCertainNonWrite
      ).size()
      mutatingCount <= 1
    ),
  }

  val noUnauthorizedPublicWrite =
    publicWriteLog.indices().forall(i =>
      val entry = publicWriteLog[i]
      entry.authorized and not(entry.fromSafeAuto)
    )

  val causalBudgetBounded =
    causalWritesUsed >= 0 and causalWritesUsed <= MAX_CAUSAL_BUDGET and internalNotesCount <= MAX_CAUSAL_BUDGET

  val singleUseProposalExecution =
    proposals.keys().forall(pid =>
      val count = publicWriteLog.indices().filter(i => publicWriteLog[i].proposalId == pid).size()
      count <= 1
    )

  val allSafetyInvariants = and {
    noIndeterminateOnCertainNonWrite,
    noAppliedRegression,
    noDoubleDispatchPerReceipt,
    noUnauthorizedPublicWrite,
    causalBudgetBounded,
    singleUseProposalExecution,
  }

  // Deterministic traces covering key failure/recovery boundaries
  run certainNonWriteRecoveryTest = init
    .then(proposeGuarded("alice", "p1"))
    .then(approveProposal("alice", 1))
    .then(reservePending("alice", "k1", OpGuardedProposal, "p1", 1))
    .expect(proposals.get(1).state == PropExecuting and receipts.get(rk("alice", "k1")).status == Pending)
    .then(markDispatchStarted(1))
    .then(dispatchCertainNonWrite(1))
    .expect(receipts.get(rk("alice", "k1")).status == Failed
      and proposals.get(1).state == PropPending
      and publicWriteLog.length() == 0
      and allSafetyInvariants)
    .then(approveProposal("alice", 1))
    .then(reservePending("alice", "k1", OpGuardedProposal, "p1", 1))
    .then(markDispatchStarted(2))
    .then(dispatchSuccessAndCommit(2))
    .then(postCommitLocalError("alice", "k1"))
    .expect(receipts.get(rk("alice", "k1")).status == Applied
      and receipts.get(rk("alice", "k1")).auditDegraded
      and proposals.get(1).state == PropApplied
      and allSafetyInvariants)

  run expiredLeaseReclaimAndFencingTest = init
    .then(reservePending("alice", "k1", OpCreateBug, "p1", -1))
    .then(expirePendingLease("alice", "k1"))
    .expect(receipts.get(rk("alice", "k1")).status == Pending
      and receipts.get(rk("alice", "k1")).leaseExpired
      and not(receipts.get(rk("alice", "k1")).dispatchAttempted))
    .then(reservePending("alice", "k1", OpCreateBug, "p1", -1))
    .expect(receipts.get(rk("alice", "k1")).leaseToken == 2)
    // Stale worker with token 1 is fenced out
    .then(fencedStaleWorkerAttempt(1))
    .then(markDispatchStarted(2))
    .then(expirePendingLease("alice", "k1"))
    // Post-dispatch expiry transitions to Indeterminate (never re-dispatches!)
    .expect(receipts.get(rk("alice", "k1")).status == Indeterminate
      and receipts.get(rk("alice", "k1")).dispatches == 1
      and allSafetyInvariants)

  run safeAutoInternalNoteBudgetTest = init
    .then(reservePending("bob", "k1", OpSafeAuto, "p1", -1))
    .then(safeAutoSaveInternalNote(1))
    .expect(receipts.get(rk("bob", "k1")).status == Applied
      and internalNotesCount == 1
      and causalWritesUsed == 1
      and publicWriteLog.length() == 0
      and allSafetyInvariants)
}
