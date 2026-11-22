// C0 model for one Events subscription. Time is measured in abstract seconds.
// Models the event selection, scan, and delivery rules in Sections 3.4, 4.2, and 4.4.
module events_ingestion {
  val LAG_BOUND = 2
  val MAX_TIME = 12
  // The first attempt is not a retry.
  val MAX_RETRIES = 2

  type Visibility =
    | Visible
    | Restricted

  type Provenance =
    | ConfirmedSelf
    | Human
    | Uncertain

  type Severity =
    | Critical
    | Normal

  type ScanResult =
    | NotScanned
    | Idle
    | Complete
    | Incomplete
    | AuthorizationRevoked

  type UpstreamEvent = {
    id: int,
    commitTs: int,
    visibleAt: int,
    visibility: Visibility,
    provenance: Provenance,
    severity: Severity,
  }

  type DeliveryState =
    | Queued
    | Acked
    | Suppressed
    | Abandoned

  type Outcome =
    | Accepted
    | Timeout
    | HttpFailure
    | Interrupted
    | Gone410
    | TooLarge413

  type Delivery = {
    state: DeliveryState,
    attempts: int,
    eligibleAt: int,
    lastSendAt: int,
    lastSendNotBefore: int,
    sentWhileRestricted: bool,
  }

  var now: int
  var nextEventId: int
  var upstream: int -> UpstreamEvent
  var lastCompleteScanEnd: int
  var safePrefix: int
  var scanResult: ScanResult
  var delivery: int -> Delivery
  var clientWatermark: int
  var reportedGaps: Set[int]
  var subscription: { authorized: bool, includeSelf: bool, criticalOnly: bool }

  action initWith(includeSelf: bool, criticalOnly: bool): bool = all {
    now' = 2,
    nextEventId' = 1,
    upstream' = Map(),
    lastCompleteScanEnd' = 2,
    safePrefix' = 0,
    scanResult' = NotScanned,
    delivery' = Map(),
    clientWatermark' = 0,
    reportedGaps' = Set(),
    subscription' = { authorized: true, includeSelf: includeSelf, criticalOnly: criticalOnly },
  }

  action init = {
    nondet includeSelf = oneOf(Set(true, false))
    nondet criticalOnly = oneOf(Set(true, false))
    initWith(includeSelf, criticalOnly)
  }

  // Environment: wall clock advances
  action tick = all {
    now < MAX_TIME,
    now' = now + 1,
    nextEventId' = nextEventId,
    upstream' = upstream,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    scanResult' = scanResult,
    delivery' = delivery,
    clientWatermark' = clientWatermark,
    reportedGaps' = reportedGaps,
    subscription' = subscription,
  }

  // Bugzilla can expose a committed change up to LAG_BOUND seconds later.
  action upstreamCommit(lag: int, provenance: Provenance, severity: Severity): bool = all {
    nextEventId <= 5,
    lag >= 0 and lag <= LAG_BOUND,
    upstream' = upstream.put(nextEventId, {
      id: nextEventId,
      commitTs: now,
      visibleAt: now + lag,
      visibility: Visible,
      provenance: provenance,
      severity: severity,
    }),
    nextEventId' = nextEventId + 1,
    now' = now,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    scanResult' = scanResult,
    delivery' = delivery,
    clientWatermark' = clientWatermark,
    reportedGaps' = reportedGaps,
    subscription' = subscription,
  }

  action restrictEvent(eid: int): bool = all {
    upstream.keys().contains(eid),
    {
      val ev = upstream.get(eid)
      all {
        ev.visibility == Visible,
        upstream' = upstream.put(eid, { ...ev, visibility: Restricted }),
      }
    },
    now' = now,
    nextEventId' = nextEventId,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    scanResult' = scanResult,
    delivery' = delivery,
    clientWatermark' = clientWatermark,
    reportedGaps' = reportedGaps,
    subscription' = subscription,
  }

  action incompleteScan = all {
    subscription.authorized,
    now' = now,
    nextEventId' = nextEventId,
    upstream' = upstream,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    scanResult' = Incomplete,
    delivery' = delivery,
    clientWatermark' = clientWatermark,
    reportedGaps' = reportedGaps,
    subscription' = subscription,
  }

  action revokeSubscription = all {
    subscription.authorized,
    now' = now,
    nextEventId' = nextEventId,
    upstream' = upstream,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    scanResult' = AuthorizationRevoked,
    delivery' = delivery,
    clientWatermark' = clientWatermark,
    reportedGaps' = reportedGaps,
    subscription' = { ...subscription, authorized: false },
  }

  action restart = all {
    now' = now,
    nextEventId' = nextEventId,
    upstream' = upstream,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    scanResult' = if (subscription.authorized) NotScanned else AuthorizationRevoked,
    delivery' = delivery,
    clientWatermark' = clientWatermark,
    reportedGaps' = reportedGaps,
    subscription' = subscription,
  }

  def matches(ev: UpstreamEvent, includeSelf: bool, criticalOnly: bool): bool =
    (includeSelf or ev.provenance != ConfirmedSelf) and (not(criticalOnly) or ev.severity == Critical)

  action completeScan = {
    val newSafe = now - LAG_BOUND
    val discovered = upstream.keys().filter(id =>
      val ev = upstream.get(id)
      ev.commitTs <= newSafe and ev.visibleAt <= now
        and matches(ev, subscription.includeSelf, subscription.criticalOnly)
        and not(delivery.keys().contains(id))
    )
    val eligible = discovered.filter(id => upstream.get(id).visibility == Visible)
    all {
      subscription.authorized,
      lastCompleteScanEnd' = now,
      safePrefix' = newSafe,
      scanResult' = if (eligible == Set()) Idle else Complete,
      delivery' = discovered.fold(delivery, (acc, id) => acc.put(id, {
        state: if (eligible.contains(id)) Queued else Suppressed,
        attempts: 0,
        eligibleAt: now,
        lastSendAt: 0,
        lastSendNotBefore: 0,
        sentWhileRestricted: false,
      })),
      now' = now,
      nextEventId' = nextEventId,
      upstream' = upstream,
      clientWatermark' = clientWatermark,
      reportedGaps' = reportedGaps,
      subscription' = subscription,
    }
  }

  def backoff(attempts: int): int = if (attempts > 4) 10 else 2 ^ (attempts - 1)

  action attemptDelivery(eid: int, outcome: Outcome): bool = all {
    delivery.keys().contains(eid),
    {
      val record = delivery.get(eid)
      val visible = subscription.authorized and upstream.get(eid).visibility == Visible
      all {
        record.state == Queued,
        now >= record.eligibleAt,
        if (not(visible)) {
          delivery' = delivery.put(eid, { ...record, state: Suppressed })
        } else {
          val attempts = record.attempts + 1
          val nextState = if (outcome == Accepted) Acked
            else if (outcome == Gone410 or outcome == TooLarge413 or attempts == 1 + MAX_RETRIES) Abandoned
            else Queued
          delivery' = delivery.put(eid, {
            state: nextState,
            attempts: attempts,
            eligibleAt: now + backoff(attempts),
            lastSendAt: now,
            lastSendNotBefore: record.eligibleAt,
            sentWhileRestricted: record.sentWhileRestricted or not(visible),
          })
        },
      }
    },
    now' = now,
    nextEventId' = nextEventId,
    upstream' = upstream,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    scanResult' = scanResult,
    clientWatermark' = clientWatermark,
    reportedGaps' = reportedGaps,
    subscription' = subscription,
  }

  // A recovery response or an acknowledged gap envelope can advance past a lost delivery.
  action advanceWatermark(reportGap: bool): bool = {
    val target = safePrefix
    val hasQueuedInPrefix = delivery.keys().exists(id =>
      upstream.get(id).commitTs <= target and delivery.get(id).state == Queued
    )
    val gaps = delivery.keys().filter(id =>
      upstream.get(id).commitTs <= target and delivery.get(id).state == Abandoned
    )
    all {
      subscription.authorized,
      target > clientWatermark,
      not(hasQueuedInPrefix),
      reportGap == (gaps.exclude(reportedGaps) != Set()),
      clientWatermark' = target,
      reportedGaps' = if (reportGap) reportedGaps.union(gaps) else reportedGaps,
      now' = now,
      nextEventId' = nextEventId,
      upstream' = upstream,
      lastCompleteScanEnd' = lastCompleteScanEnd,
      safePrefix' = safePrefix,
      scanResult' = scanResult,
      delivery' = delivery,
      subscription' = subscription,
    }
  }

  action step = any {
    tick,
    nondet lag = oneOf(Set(0, 1, 2))
    nondet provenance = oneOf(Set(ConfirmedSelf, Human, Uncertain))
    nondet severity = oneOf(Set(Critical, Normal))
    upstreamCommit(lag, provenance, severity),
    nondet eid = oneOf(Set(1, 2, 3, 4, 5))
    restrictEvent(eid),
    incompleteScan,
    completeScan,
    revokeSubscription,
    restart,
    nondet eid = oneOf(Set(1, 2, 3, 4, 5))
    nondet out = oneOf(Set(Accepted, Timeout, HttpFailure, Interrupted, Gone410, TooLarge413))
    attemptDelivery(eid, out),
    nondet report = oneOf(Set(true, false))
    advanceWatermark(report),
  }

  // Safety Invariants
  val safePrefixBounded =
    safePrefix <= now - LAG_BOUND and safePrefix <= lastCompleteScanEnd - LAG_BOUND

  val boundedAuthorizedAttempts = delivery.keys().forall(id =>
    val record = delivery.get(id)
    record.attempts <= 1 + MAX_RETRIES
      and not(record.sentWhileRestricted)
      and record.lastSendAt >= record.lastSendNotBefore
      and (record.state == Queued implies record.attempts < 1 + MAX_RETRIES)
  )

  val queuedFromVerifiedHistory = delivery.keys().forall(id =>
    val ev = upstream.get(id)
    ev.commitTs <= safePrefix and matches(ev, subscription.includeSelf, subscription.criticalOnly)
  )

  // A cursor covers acknowledgements, restricted events, and explicitly reported losses.
  val noSilentSkipBeforeWatermark =
    clientWatermark <= safePrefix and upstream.keys().forall(id =>
      val ev = upstream.get(id)
      (ev.commitTs <= clientWatermark
        and matches(ev, subscription.includeSelf, subscription.criticalOnly)) implies (
        delivery.keys().contains(id) and (
          delivery.get(id).state == Acked
          or (delivery.get(id).state == Suppressed and ev.visibility == Restricted)
          or (delivery.get(id).state == Abandoned and reportedGaps.contains(id))
        )
      )
    )

  val allSafetyInvariants = and {
    safePrefixBounded,
    boundedAuthorizedAttempts,
    queuedFromVerifiedHistory,
    noSilentSkipBeforeWatermark,
  }

  // Deterministic traces for the C0 model, not tests of the HTTP implementation.
  run scanRecoveryTest = initWith(false, true)
    .then(upstreamCommit(2, Human, Critical))
    .then(tick).then(tick)
    .then(incompleteScan)
    .expect(scanResult == Incomplete and safePrefix == 0 and clientWatermark == 0
      and delivery.keys() == Set() and reportedGaps == Set())
    .then(completeScan)
    .expect(scanResult == Complete and safePrefix == 2 and delivery.get(1).state == Queued)
    .then(attemptDelivery(1, Accepted))
    .then(advanceWatermark(false))
    .then(tick)
    .then(completeScan)
    .then(advanceWatermark(false))
    .expect(scanResult == Idle and clientWatermark == 3 and reportedGaps == Set())

  run retryRestartTest = initWith(false, false)
    .then(upstreamCommit(0, Human, Normal))
    .then(tick).then(tick)
    .then(completeScan)
    .then(attemptDelivery(1, Timeout))
    .then(restart)
    .expect(delivery.get(1).attempts == 1 and delivery.get(1).eligibleAt == 5
      and delivery.get(1).state == Queued and clientWatermark == 0)
    .then(tick)
    .then(attemptDelivery(1, Interrupted))
    .then(restart)
    .expect(delivery.get(1).attempts == 2 and delivery.get(1).eligibleAt == 7)
    .then(tick).then(tick)
    .then(attemptDelivery(1, HttpFailure))
    .then(restart)
    .expect(delivery.get(1).attempts == 3 and delivery.get(1).state == Abandoned
      and clientWatermark == 0 and reportedGaps == Set())
    .then(advanceWatermark(true))
    .expect(reportedGaps == Set(1) and clientWatermark == 2 and allSafetyInvariants)

  run terminalResponsesTest = initWith(false, false)
    .then(upstreamCommit(0, Human, Normal))
    .then(upstreamCommit(0, Human, Normal))
    .then(tick).then(tick)
    .then(completeScan)
    .then(attemptDelivery(1, Gone410))
    .then(attemptDelivery(2, TooLarge413))
    .expect(subscription.authorized and delivery.get(1).state == Abandoned
      and delivery.get(2).state == Abandoned and delivery.get(1).attempts == 1
      and delivery.get(2).attempts == 1)
    .then(advanceWatermark(true))
    .expect(reportedGaps == Set(1, 2) and clientWatermark == 2)

  run revocationBeforeRetryTest = initWith(false, false)
    .then(upstreamCommit(0, Human, Critical))
    .then(upstreamCommit(0, Human, Critical))
    .then(tick).then(tick)
    .then(completeScan)
    .then(attemptDelivery(1, Timeout))
    .then(attemptDelivery(2, Timeout))
    .then(tick)
    .then(restrictEvent(1))
    .then(attemptDelivery(1, Accepted))
    .then(revokeSubscription)
    .then(restart)
    .then(attemptDelivery(2, Accepted))
    .expect(scanResult == AuthorizationRevoked
      and delivery.get(1).state == Suppressed and delivery.get(2).state == Suppressed
      and delivery.get(1).attempts == 1 and delivery.get(2).attempts == 1
      and reportedGaps == Set() and boundedAuthorizedAttempts)

  run sameSecondSelectionTest = initWith(false, true)
    .then(upstreamCommit(0, ConfirmedSelf, Critical))
    .then(upstreamCommit(0, Human, Critical))
    .then(upstreamCommit(0, Human, Normal))
    .then(upstreamCommit(0, Uncertain, Critical))
    .then(tick).then(tick)
    .then(completeScan)
    .expect(delivery.keys() == Set(2, 4))
    .then(attemptDelivery(2, Accepted))
    .then(attemptDelivery(4, Accepted))
    .then(advanceWatermark(false))
    .expect(clientWatermark == 2 and allSafetyInvariants)

  run includeSelfSelectionTest = initWith(true, true)
    .then(upstreamCommit(0, ConfirmedSelf, Critical))
    .then(upstreamCommit(0, ConfirmedSelf, Normal))
    .then(tick).then(tick)
    .then(completeScan)
    .expect(delivery.keys() == Set(1) and allSafetyInvariants)
}
