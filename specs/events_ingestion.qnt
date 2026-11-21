// Formal C0 State Machine: Synthetic Event Ingestion, Safe Prefix & Delivery Watermark
// Maps to specs/architecture-and-contracts.md Section 4.3
module events_ingestion {
  val LAG_BOUND = 2
  val MAX_TIME = 6
  val MAX_RETRIES = 2

  type Visibility =
    | Visible
    | Restricted

  type UpstreamEvent = {
    id: int,
    commitTs: int,
    visibleAt: int,       // commitTs <= visibleAt <= commitTs + LAG_BOUND
    visibility: Visibility,
    isSelfWrite: bool,
  }

  type DeliveryState =
    | Queued
    | Acked
    | Suppressed
    | Abandoned

  var now: int
  var nextEventId: int
  var upstream: int -> UpstreamEvent
  var lastCompleteScanEnd: int   // last wall-clock time at which a full scan completed
  var safePrefix: int            // guaranteed complete prefix <= lastCompleteScanEnd - LAG_BOUND
  var delivery: int -> DeliveryState
  var retries: int -> int
  var clientWatermark: int
  var gapDeclared: bool
  var leakedRestricted: bool

  action init = all {
    now' = 2,
    nextEventId' = 1,
    upstream' = Map(),
    lastCompleteScanEnd' = 2,
    safePrefix' = 0,
    delivery' = Map(),
    retries' = Map(),
    clientWatermark' = 0,
    gapDeclared' = false,
    leakedRestricted' = false,
  }

  // Environment: wall clock advances
  action tick = all {
    now < MAX_TIME,
    now' = now + 1,
    nextEventId' = nextEventId,
    upstream' = upstream,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    delivery' = delivery,
    retries' = retries,
    clientWatermark' = clientWatermark,
    gapDeclared' = gapDeclared,
    leakedRestricted' = leakedRestricted,
  }

  // Environment: Bugzilla commits a change at commitTs=now, becoming visible at now..now+LAG_BOUND
  action upstreamCommit(lag: int, selfWrite: bool): bool = all {
    nextEventId <= 5,
    lag >= 0 and lag <= LAG_BOUND,
    upstream' = upstream.put(nextEventId, {
      id: nextEventId,
      commitTs: now,
      visibleAt: now + lag,
      visibility: Visible,
      isSelfWrite: selfWrite,
    }),
    nextEventId' = nextEventId + 1,
    now' = now,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    delivery' = delivery,
    retries' = retries,
    clientWatermark' = clientWatermark,
    gapDeclared' = gapDeclared,
    leakedRestricted' = leakedRestricted,
  }

  // Environment: Bug moves into a security group after commit/queueing
  action restrictEvent(eid: int): bool = all {
    upstream.keys().contains(eid),
    val ev = upstream.get(eid)
    upstream' = upstream.put(eid, { ...ev, visibility: Restricted }),
    now' = now,
    nextEventId' = nextEventId,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    delivery' = delivery,
    retries' = retries,
    clientWatermark' = clientWatermark,
    gapDeclared' = gapDeclared,
    leakedRestricted' = leakedRestricted,
  }

  // Incomplete scan: fails mid-pagination; MUST NOT advance safePrefix or clientWatermark
  action incompleteScan = all {
    now' = now,
    nextEventId' = nextEventId,
    upstream' = upstream,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    delivery' = delivery,
    retries' = retries,
    clientWatermark' = clientWatermark,
    gapDeclared' = gapDeclared,
    leakedRestricted' = leakedRestricted,
  }

  // Complete bounded-lag scan: discovers all currently visible, non-self events and advances safePrefix safely
  action completeScan = {
    val eligibleIds = upstream.keys().filter(id =>
      val ev = upstream.get(id)
      ev.visibleAt <= now and not(ev.isSelfWrite) and not(delivery.keys().contains(id))
    )
    val newSafe = if (now - LAG_BOUND > safePrefix) now - LAG_BOUND else safePrefix
    val updatedDelivery = eligibleIds.fold(delivery, (acc, id) => acc.put(id, Queued))
    val updatedRetries = eligibleIds.fold(retries, (acc, id) => acc.put(id, 0))
    all {
      lastCompleteScanEnd' = now,
      safePrefix' = newSafe,
      delivery' = updatedDelivery,
      retries' = updatedRetries,
      now' = now,
      nextEventId' = nextEventId,
      upstream' = upstream,
      clientWatermark' = clientWatermark,
      gapDeclared' = gapDeclared,
      leakedRestricted' = leakedRestricted,
    }
  }

  // Webhook delivery attempt with per-occurrence re-authorization before release
  action attemptDelivery(eid: int, outcome: str): bool = all {
    delivery.keys().contains(eid),
    delivery.get(eid) == Queued,
    val ev = upstream.get(eid)
    if (ev.visibility == Restricted) {
      // Fail closed: re-auth caught visibility change before send
      all {
        delivery' = delivery.put(eid, Suppressed),
        retries' = retries,
        leakedRestricted' = leakedRestricted,
      }
    } else if (outcome == "ack") {
      all {
        delivery' = delivery.put(eid, Acked),
        retries' = retries,
        leakedRestricted' = leakedRestricted,
      }
    } else if (outcome == "terminal413" or retries.get(eid) + 1 >= MAX_RETRIES) {
      all {
        delivery' = delivery.put(eid, Abandoned),
        retries' = retries.put(eid, retries.get(eid) + 1),
        leakedRestricted' = leakedRestricted,
      }
    } else {
      all {
        delivery' = delivery,
        retries' = retries.put(eid, retries.get(eid) + 1),
        leakedRestricted' = leakedRestricted,
      }
    },
    now' = now,
    nextEventId' = nextEventId,
    upstream' = upstream,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    clientWatermark' = clientWatermark,
    gapDeclared' = gapDeclared,
  }

  // Advance clientWatermark only if NO Queued event <= target, and if any Abandoned <= target then MUST declare durable gap
  action advanceWatermark = {
    val target = safePrefix
    val hasQueuedInPrefix = delivery.keys().exists(id =>
      upstream.get(id).commitTs <= target and delivery.get(id) == Queued
    )
    val hasAbandonedInPrefix = delivery.keys().exists(id =>
      upstream.get(id).commitTs <= target and delivery.get(id) == Abandoned
    )
    all {
      target > clientWatermark,
      not(hasQueuedInPrefix),
      clientWatermark' = target,
      gapDeclared' = (gapDeclared or hasAbandonedInPrefix),
      now' = now,
      nextEventId' = nextEventId,
      upstream' = upstream,
      lastCompleteScanEnd' = lastCompleteScanEnd,
      safePrefix' = safePrefix,
      delivery' = delivery,
      retries' = retries,
      leakedRestricted' = leakedRestricted,
    }
  }

  action step = any {
    tick,
    nondet lag = oneOf(Set(0, 1, 2))
    nondet selfW = oneOf(Set(true, false))
    upstreamCommit(lag, selfW),
    nondet eid = oneOf(Set(1, 2, 3, 4, 5))
    restrictEvent(eid),
    incompleteScan,
    completeScan,
    nondet eid = oneOf(Set(1, 2, 3, 4, 5))
    nondet out = oneOf(Set("ack", "transient", "terminal413"))
    attemptDelivery(eid, out),
    advanceWatermark,
  }

  // Safety Invariants
  val safePrefixBounded =
    safePrefix <= now - LAG_BOUND and safePrefix <= lastCompleteScanEnd - LAG_BOUND

  val noLeakedRestrictedEvent = not(leakedRestricted)

  // Core Watermark Completeness Invariant:
  // Every non-self event committed at or before clientWatermark is either Acked, Suppressed (restricted),
  // or covered by an explicit durable gapDeclared signal — NEVER silently skipped!
  val noSilentSkipBeforeWatermark =
    upstream.keys().forall(id =>
      val ev = upstream.get(id)
      (ev.commitTs <= clientWatermark and not(ev.isSelfWrite)) implies (
        delivery.keys().contains(id) and (
          delivery.get(id) == Acked
          or delivery.get(id) == Suppressed
          or (delivery.get(id) == Abandoned and gapDeclared)
        )
      )
    )

  val allSafetyInvariants = and {
    safePrefixBounded,
    noLeakedRestrictedEvent,
    noSilentSkipBeforeWatermark,
  }
}
