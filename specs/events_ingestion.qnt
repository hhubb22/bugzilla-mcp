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
    | SchemaChanged

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
    sentWithStaleAuthOrEpoch: bool,
  }

  type Subscription = {
    authorized: bool,
    includeSelf: bool,
    criticalOnly: bool,
    credentialGeneration: int,
    schemaEpoch: int,
    anchorWatermark: int,
    gapPending: bool,
    gapTargetWatermark: int,
    gapAttempts: int,
    gapEligibleAt: int,
    gapDeliveryAbandoned: bool,
    lastGapCursor: int,
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
  var currentCredentialGeneration: int
  var currentSchemaEpoch: int
  var lastRefreshTruncated: bool
  var gapSentWithStaleAuthOrEpoch: bool
  var subscription: Subscription

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
    currentCredentialGeneration' = 1,
    currentSchemaEpoch' = 1,
    lastRefreshTruncated' = false,
    gapSentWithStaleAuthOrEpoch' = false,
    subscription' = {
      authorized: true,
      includeSelf: includeSelf,
      criticalOnly: criticalOnly,
      credentialGeneration: 1,
      schemaEpoch: 1,
      anchorWatermark: 0,
      gapPending: false,
      gapTargetWatermark: 0,
      gapAttempts: 0,
      gapEligibleAt: 0,
      gapDeliveryAbandoned: false,
      lastGapCursor: 0,
    },
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
    currentCredentialGeneration' = currentCredentialGeneration,
    currentSchemaEpoch' = currentSchemaEpoch,
    lastRefreshTruncated' = lastRefreshTruncated,
    gapSentWithStaleAuthOrEpoch' = gapSentWithStaleAuthOrEpoch,
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
    currentCredentialGeneration' = currentCredentialGeneration,
    currentSchemaEpoch' = currentSchemaEpoch,
    lastRefreshTruncated' = lastRefreshTruncated,
    gapSentWithStaleAuthOrEpoch' = gapSentWithStaleAuthOrEpoch,
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
    currentCredentialGeneration' = currentCredentialGeneration,
    currentSchemaEpoch' = currentSchemaEpoch,
    lastRefreshTruncated' = lastRefreshTruncated,
    gapSentWithStaleAuthOrEpoch' = gapSentWithStaleAuthOrEpoch,
    subscription' = subscription,
  }

  action incompleteScan = all {
    subscription.authorized,
    subscription.credentialGeneration == currentCredentialGeneration,
    subscription.schemaEpoch == currentSchemaEpoch,
    now' = now,
    nextEventId' = nextEventId,
    upstream' = upstream,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    scanResult' = Incomplete,
    delivery' = delivery,
    clientWatermark' = clientWatermark,
    reportedGaps' = reportedGaps,
    currentCredentialGeneration' = currentCredentialGeneration,
    currentSchemaEpoch' = currentSchemaEpoch,
    lastRefreshTruncated' = lastRefreshTruncated,
    gapSentWithStaleAuthOrEpoch' = gapSentWithStaleAuthOrEpoch,
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
    currentCredentialGeneration' = currentCredentialGeneration,
    currentSchemaEpoch' = currentSchemaEpoch,
    lastRefreshTruncated' = lastRefreshTruncated,
    gapSentWithStaleAuthOrEpoch' = gapSentWithStaleAuthOrEpoch,
    subscription' = { ...subscription, authorized: false },
  }

  // Tenant rotates bound Bugzilla API key (increments credentialGeneration)
  action rotateCredential = all {
    currentCredentialGeneration < 3,
    currentCredentialGeneration' = currentCredentialGeneration + 1,
    now' = now,
    nextEventId' = nextEventId,
    upstream' = upstream,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    scanResult' = scanResult,
    delivery' = delivery,
    clientWatermark' = clientWatermark,
    reportedGaps' = reportedGaps,
    currentSchemaEpoch' = currentSchemaEpoch,
    lastRefreshTruncated' = lastRefreshTruncated,
    gapSentWithStaleAuthOrEpoch' = gapSentWithStaleAuthOrEpoch,
    subscription' = subscription,
  }

  // Sweep/delivery detects rotated credential and revokes stale subscription
  action detectCredentialRotation = all {
    subscription.authorized,
    subscription.credentialGeneration < currentCredentialGeneration,
    subscription' = { ...subscription, authorized: false },
    scanResult' = AuthorizationRevoked,
    now' = now,
    nextEventId' = nextEventId,
    upstream' = upstream,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    delivery' = delivery,
    clientWatermark' = clientWatermark,
    reportedGaps' = reportedGaps,
    currentCredentialGeneration' = currentCredentialGeneration,
    currentSchemaEpoch' = currentSchemaEpoch,
    lastRefreshTruncated' = lastRefreshTruncated,
    gapSentWithStaleAuthOrEpoch' = gapSentWithStaleAuthOrEpoch,
  }

  // Principal re-authorizes / supersedes subscription under rotated credentialGeneration
  action resubscribeAfterCredentialRotation = all {
    subscription.schemaEpoch == currentSchemaEpoch,
    not(subscription.authorized) or subscription.credentialGeneration < currentCredentialGeneration,
    subscription' = {
      ...subscription,
      authorized: true,
      credentialGeneration: currentCredentialGeneration,
    },
    // Any event suppressed solely due to prior revocation (still Visible) resumes delivery.
    delivery' = delivery.keys().fold(delivery, (acc, id) => {
      val rec = acc.get(id)
      if (rec.state == Suppressed and upstream.get(id).visibility == Visible) {
        acc.put(id, {
          ...rec,
          state: if (rec.attempts < 1 + MAX_RETRIES) Queued else Abandoned,
          eligibleAt: now,
        })
      } else acc
    }),
    scanResult' = NotScanned,
    now' = now,
    nextEventId' = nextEventId,
    upstream' = upstream,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    clientWatermark' = clientWatermark,
    reportedGaps' = reportedGaps,
    currentCredentialGeneration' = currentCredentialGeneration,
    currentSchemaEpoch' = currentSchemaEpoch,
    lastRefreshTruncated' = false,
    gapSentWithStaleAuthOrEpoch' = gapSentWithStaleAuthOrEpoch,
  }

  // Server deploys new eventSchemaEpoch
  action bumpSchemaEpoch = all {
    currentSchemaEpoch < 3,
    currentSchemaEpoch' = currentSchemaEpoch + 1,
    now' = now,
    nextEventId' = nextEventId,
    upstream' = upstream,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    scanResult' = scanResult,
    delivery' = delivery,
    clientWatermark' = clientWatermark,
    reportedGaps' = reportedGaps,
    currentCredentialGeneration' = currentCredentialGeneration,
    lastRefreshTruncated' = lastRefreshTruncated,
    gapSentWithStaleAuthOrEpoch' = gapSentWithStaleAuthOrEpoch,
    subscription' = subscription,
  }

  // Sweep detects eventSchemaEpoch mismatch -> explicit SchemaChanged termination (never silent zombie)
  action detectSchemaEpochMismatch = all {
    subscription.authorized,
    subscription.schemaEpoch < currentSchemaEpoch,
    subscription' = { ...subscription, authorized: false },
    scanResult' = SchemaChanged,
    now' = now,
    nextEventId' = nextEventId,
    upstream' = upstream,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    delivery' = delivery,
    clientWatermark' = clientWatermark,
    reportedGaps' = reportedGaps,
    currentCredentialGeneration' = currentCredentialGeneration,
    currentSchemaEpoch' = currentSchemaEpoch,
    lastRefreshTruncated' = lastRefreshTruncated,
    gapSentWithStaleAuthOrEpoch' = gapSentWithStaleAuthOrEpoch,
  }

  // Principal re-subscribes with cursor: null after eventSchemaEpoch bump -> anchors at safePrefix
  action resubscribeAfterSchemaBump = all {
    subscription.schemaEpoch < currentSchemaEpoch,
    subscription' = {
      ...subscription,
      authorized: true,
      credentialGeneration: currentCredentialGeneration,
      schemaEpoch: currentSchemaEpoch,
      anchorWatermark: safePrefix,
      gapPending: false,
      gapTargetWatermark: 0,
      gapAttempts: 0,
      gapEligibleAt: 0,
      gapDeliveryAbandoned: false,
      lastGapCursor: 0,
    },
    delivery' = Map(),
    clientWatermark' = safePrefix,
    reportedGaps' = Set(),
    scanResult' = NotScanned,
    lastRefreshTruncated' = false,
    now' = now,
    nextEventId' = nextEventId,
    upstream' = upstream,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    currentCredentialGeneration' = currentCredentialGeneration,
    currentSchemaEpoch' = currentSchemaEpoch,
    gapSentWithStaleAuthOrEpoch' = gapSentWithStaleAuthOrEpoch,
  }

  action restart = all {
    now' = now,
    nextEventId' = nextEventId,
    upstream' = upstream,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    scanResult' = if (subscription.authorized) NotScanned else scanResult,
    delivery' = delivery,
    clientWatermark' = clientWatermark,
    reportedGaps' = reportedGaps,
    currentCredentialGeneration' = currentCredentialGeneration,
    currentSchemaEpoch' = currentSchemaEpoch,
    lastRefreshTruncated' = lastRefreshTruncated,
    gapSentWithStaleAuthOrEpoch' = gapSentWithStaleAuthOrEpoch,
    subscription' = subscription,
  }

  def matches(ev: UpstreamEvent, includeSelf: bool, criticalOnly: bool): bool =
    (includeSelf or ev.provenance != ConfirmedSelf) and (not(criticalOnly) or ev.severity == Critical)

  def maxInt(a: int, b: int): int = if (a >= b) a else b

  def hasQueuedAtOrBefore(target: int): bool =
    delivery.keys().exists(id =>
      upstream.get(id).commitTs <= target and delivery.get(id).state == Queued
    )

  def abandonedAtOrBefore(target: int): Set[int] =
    delivery.keys().filter(id =>
      upstream.get(id).commitTs <= target and delivery.get(id).state == Abandoned
    )

  action completeScan = {
    val newSafe = now - LAG_BOUND
    val discovered = upstream.keys().filter(id =>
      val ev = upstream.get(id)
      ev.commitTs > subscription.anchorWatermark
        and ev.commitTs <= newSafe and ev.visibleAt <= now
        and matches(ev, subscription.includeSelf, subscription.criticalOnly)
        and not(delivery.keys().contains(id))
    )
    val eligible = discovered.filter(id => upstream.get(id).visibility == Visible)
    all {
      subscription.authorized,
      subscription.credentialGeneration == currentCredentialGeneration,
      subscription.schemaEpoch == currentSchemaEpoch,
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
        sentWithStaleAuthOrEpoch: false,
      })),
      now' = now,
      nextEventId' = nextEventId,
      upstream' = upstream,
      clientWatermark' = clientWatermark,
      reportedGaps' = reportedGaps,
      currentCredentialGeneration' = currentCredentialGeneration,
      currentSchemaEpoch' = currentSchemaEpoch,
      lastRefreshTruncated' = lastRefreshTruncated,
      gapSentWithStaleAuthOrEpoch' = gapSentWithStaleAuthOrEpoch,
      subscription' = subscription,
    }
  }

  def backoff(attempts: int): int = if (attempts > 4) 10 else 2 ^ (attempts - 1)

  action attemptDelivery(eid: int, outcome: Outcome): bool = all {
    delivery.keys().contains(eid),
    {
      val record = delivery.get(eid)
      val freshAuthAndEpoch =
        subscription.credentialGeneration == currentCredentialGeneration
          and subscription.schemaEpoch == currentSchemaEpoch
      val visible = subscription.authorized and freshAuthAndEpoch and upstream.get(eid).visibility == Visible
      all {
        record.state == Queued,
        now >= record.eligibleAt,
        if (not(subscription.authorized) or upstream.get(eid).visibility == Restricted) {
          delivery' = delivery.put(eid, { ...record, state: Suppressed })
        } else {
          all {
            freshAuthAndEpoch,
            {
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
                sentWithStaleAuthOrEpoch: record.sentWithStaleAuthOrEpoch or not(freshAuthAndEpoch),
              })
            }
          }
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
    currentCredentialGeneration' = currentCredentialGeneration,
    currentSchemaEpoch' = currentSchemaEpoch,
    lastRefreshTruncated' = lastRefreshTruncated,
    gapSentWithStaleAuthOrEpoch' = gapSentWithStaleAuthOrEpoch,
    subscription' = subscription,
  }

  // Normal watermark advance: ONLY when there are zero queued events and zero unreported gaps.
  action advanceWatermark: bool = {
    val target = safePrefix
    val gaps = abandonedAtOrBefore(target)
    all {
      subscription.authorized,
      subscription.credentialGeneration == currentCredentialGeneration,
      subscription.schemaEpoch == currentSchemaEpoch,
      not(subscription.gapPending),
      target > clientWatermark,
      not(hasQueuedAtOrBefore(target)),
      gaps.exclude(reportedGaps) == Set(),
      clientWatermark' = target,
      reportedGaps' = reportedGaps,
      now' = now,
      nextEventId' = nextEventId,
      upstream' = upstream,
      lastCompleteScanEnd' = lastCompleteScanEnd,
      safePrefix' = safePrefix,
      scanResult' = scanResult,
      delivery' = delivery,
      currentCredentialGeneration' = currentCredentialGeneration,
      currentSchemaEpoch' = currentSchemaEpoch,
      lastRefreshTruncated' = lastRefreshTruncated,
      gapSentWithStaleAuthOrEpoch' = gapSentWithStaleAuthOrEpoch,
      subscription' = subscription,
    }
  }

  // Record an uncommunicated gap when abandoned deliveries block watermark advancement.
  // Does NOT advance clientWatermark (safeWatermark) until sendGap 2xx or refreshSubscription truncated:true.
  action scheduleGap: bool = {
    val target = safePrefix
    val gaps = abandonedAtOrBefore(target)
    all {
      subscription.authorized,
      subscription.credentialGeneration == currentCredentialGeneration,
      subscription.schemaEpoch == currentSchemaEpoch,
      not(subscription.gapPending),
      target > clientWatermark,
      not(hasQueuedAtOrBefore(target)),
      gaps.exclude(reportedGaps) != Set(),
      subscription' = {
        ...subscription,
        gapPending: true,
        gapTargetWatermark: target,
        gapAttempts: 0,
        gapEligibleAt: now,
        gapDeliveryAbandoned: false,
      },
      now' = now,
      nextEventId' = nextEventId,
      upstream' = upstream,
      lastCompleteScanEnd' = lastCompleteScanEnd,
      safePrefix' = safePrefix,
      scanResult' = scanResult,
      delivery' = delivery,
      clientWatermark' = clientWatermark,
      reportedGaps' = reportedGaps,
      currentCredentialGeneration' = currentCredentialGeneration,
      currentSchemaEpoch' = currentSchemaEpoch,
      lastRefreshTruncated' = lastRefreshTruncated,
      gapSentWithStaleAuthOrEpoch' = gapSentWithStaleAuthOrEpoch,
    }
  }

  // SEP-3415 out-of-band sendGap delivery:
  // - 2xx (Accepted): communicates gap, advances safeWatermark, clears gapPending, preserves lastGapCursor.
  // - 410 / 413 / retry exhaustion: marks gapDeliveryAbandoned = true WITHOUT advancing safeWatermark
  //   or clearing gapPending (#13 Blocker #1 / [R-836a57]).
  // - Retryable error: schedules exponential backoff retry.
  action sendGap(outcome: Outcome): bool = {
    val target = subscription.gapTargetWatermark
    val freshAuthAndEpoch =
      subscription.credentialGeneration == currentCredentialGeneration
        and subscription.schemaEpoch == currentSchemaEpoch
    val attempts = subscription.gapAttempts + 1
    all {
      subscription.authorized,
      freshAuthAndEpoch,
      subscription.gapPending,
      not(subscription.gapDeliveryAbandoned),
      now >= subscription.gapEligibleAt,
      not(hasQueuedAtOrBefore(target)),
      gapSentWithStaleAuthOrEpoch' = (gapSentWithStaleAuthOrEpoch or not(freshAuthAndEpoch)),
      if (outcome == Accepted) {
        all {
          clientWatermark' = maxInt(clientWatermark, target),
          reportedGaps' = reportedGaps.union(abandonedAtOrBefore(target)),
          subscription' = {
            ...subscription,
            gapPending: false,
            gapTargetWatermark: 0,
            gapAttempts: 0,
            gapEligibleAt: 0,
            gapDeliveryAbandoned: false,
            lastGapCursor: maxInt(subscription.lastGapCursor, target),
          },
        }
      } else if (outcome == Gone410 or outcome == TooLarge413 or attempts == 1 + MAX_RETRIES) {
        all {
          clientWatermark' = clientWatermark,
          reportedGaps' = reportedGaps,
          subscription' = {
            ...subscription,
            gapAttempts: attempts,
            gapEligibleAt: now + backoff(attempts),
            gapDeliveryAbandoned: true,
            lastGapCursor: maxInt(subscription.lastGapCursor, target),
          },
        }
      } else {
        all {
          clientWatermark' = clientWatermark,
          reportedGaps' = reportedGaps,
          subscription' = {
            ...subscription,
            gapAttempts: attempts,
            gapEligibleAt: now + backoff(attempts),
          },
        }
      },
      now' = now,
      nextEventId' = nextEventId,
      upstream' = upstream,
      lastCompleteScanEnd' = lastCompleteScanEnd,
      safePrefix' = safePrefix,
      scanResult' = scanResult,
      delivery' = delivery,
      currentCredentialGeneration' = currentCredentialGeneration,
      currentSchemaEpoch' = currentSchemaEpoch,
      lastRefreshTruncated' = lastRefreshTruncated,
    }
  }

  // Refresh existing subscription:
  // If gapPending and no queued items block gapTargetWatermark, returns truncated: true,
  // advances safeWatermark = recoveryCursor, clears gapPending = false, and preserves lastGapCursor (#13 Blocker #1).
  // Older clientCursor (< lastGapCursor) still receives truncated: true.
  action refreshSubscription(clientCursor: int): bool = all {
    subscription.authorized,
    subscription.credentialGeneration == currentCredentialGeneration,
    subscription.schemaEpoch == currentSchemaEpoch,
    clientCursor >= subscription.anchorWatermark,
    clientCursor <= clientWatermark,
    if (subscription.gapPending and not(hasQueuedAtOrBefore(subscription.gapTargetWatermark))) {
      val recoveryCursor = subscription.gapTargetWatermark
      all {
        lastRefreshTruncated' = true,
        clientWatermark' = maxInt(clientWatermark, recoveryCursor),
        reportedGaps' = reportedGaps.union(abandonedAtOrBefore(recoveryCursor)),
        subscription' = {
          ...subscription,
          gapPending: false,
          gapTargetWatermark: 0,
          gapAttempts: 0,
          gapEligibleAt: 0,
          gapDeliveryAbandoned: false,
          lastGapCursor: maxInt(subscription.lastGapCursor, recoveryCursor),
        },
      }
    } else {
      all {
        lastRefreshTruncated' = clientCursor < subscription.lastGapCursor,
        clientWatermark' = clientWatermark,
        reportedGaps' = reportedGaps,
        subscription' = subscription,
      }
    },
    now' = now,
    nextEventId' = nextEventId,
    upstream' = upstream,
    lastCompleteScanEnd' = lastCompleteScanEnd,
    safePrefix' = safePrefix,
    scanResult' = scanResult,
    delivery' = delivery,
    currentCredentialGeneration' = currentCredentialGeneration,
    currentSchemaEpoch' = currentSchemaEpoch,
    gapSentWithStaleAuthOrEpoch' = gapSentWithStaleAuthOrEpoch,
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
    rotateCredential,
    detectCredentialRotation,
    resubscribeAfterCredentialRotation,
    bumpSchemaEpoch,
    detectSchemaEpochMismatch,
    resubscribeAfterSchemaBump,
    restart,
    nondet eid = oneOf(Set(1, 2, 3, 4, 5))
    nondet out = oneOf(Set(Accepted, Timeout, HttpFailure, Interrupted, Gone410, TooLarge413))
    attemptDelivery(eid, out),
    advanceWatermark,
    scheduleGap,
    nondet out = oneOf(Set(Accepted, Timeout, HttpFailure, Interrupted, Gone410, TooLarge413))
    sendGap(out),
    nondet cursor = oneOf(0.to(MAX_TIME))
    refreshSubscription(cursor),
  }

  // Safety Invariants
  val safePrefixBounded =
    safePrefix <= now - LAG_BOUND and safePrefix <= lastCompleteScanEnd - LAG_BOUND

  val boundedAuthorizedAttempts = and {
    delivery.keys().forall(id =>
      val record = delivery.get(id)
      record.attempts <= 1 + MAX_RETRIES
        and not(record.sentWhileRestricted)
        and not(record.sentWithStaleAuthOrEpoch)
        and record.lastSendAt >= record.lastSendNotBefore
        and (record.state == Queued implies record.attempts < 1 + MAX_RETRIES)
    ),
    subscription.gapAttempts <= 1 + MAX_RETRIES,
    not(gapSentWithStaleAuthOrEpoch),
  }

  val queuedFromVerifiedHistory = delivery.keys().forall(id =>
    val ev = upstream.get(id)
    ev.commitTs > subscription.anchorWatermark
      and ev.commitTs <= safePrefix
      and matches(ev, subscription.includeSelf, subscription.criticalOnly)
  )

  // [R-836a57] A cursor covers acknowledgements, restricted events, and explicitly communicated losses.
  // While gapPending is true (including after sendGap 410/413/exhaustion), safeWatermark NEVER advances past it.
  val noSilentSkipBeforeWatermark = and {
    clientWatermark <= safePrefix,
    subscription.gapPending implies (clientWatermark < subscription.gapTargetWatermark),
    upstream.keys().forall(id =>
      val ev = upstream.get(id)
      (ev.commitTs > subscription.anchorWatermark
        and ev.commitTs <= clientWatermark
        and matches(ev, subscription.includeSelf, subscription.criticalOnly)) implies (
        delivery.keys().contains(id) and (
          delivery.get(id).state == Acked
          or (delivery.get(id).state == Suppressed and ev.visibility == Restricted)
          or (delivery.get(id).state == Abandoned and reportedGaps.contains(id))
        )
      )
    ),
  }

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
    .then(advanceWatermark)
    .then(tick)
    .then(completeScan)
    .then(advanceWatermark)
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
    .then(scheduleGap)
    .then(sendGap(Accepted))
    .expect(reportedGaps == Set(1) and clientWatermark == 2 and not(subscription.gapPending) and allSafetyInvariants)

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
    .then(scheduleGap)
    .then(sendGap(Gone410))
    // #13 Blocker #1: sendGap 410 must NOT advance safeWatermark or clear gapPending
    .expect(subscription.gapPending and subscription.gapDeliveryAbandoned
      and clientWatermark == 0 and reportedGaps == Set() and allSafetyInvariants)
    // Refresh returns truncated: true, advances safeWatermark = recoveryCursor, clears gapPending
    .then(refreshSubscription(0))
    .expect(lastRefreshTruncated and not(subscription.gapPending)
      and reportedGaps == Set(1, 2) and clientWatermark == 2
      and subscription.lastGapCursor == 2 and allSafetyInvariants)
    // Older cursor refresh STILL reports truncated: true via preserved lastGapCursor
    .then(refreshSubscription(0))
    .expect(lastRefreshTruncated and allSafetyInvariants)

  run sendGapRetryExhaustionThenRefreshTest = initWith(false, false)
    .then(upstreamCommit(0, Human, Normal))
    .then(tick).then(tick)
    .then(completeScan)
    .then(attemptDelivery(1, Gone410))
    .then(scheduleGap)
    .then(sendGap(Timeout))
    .then(tick)
    .then(sendGap(HttpFailure))
    .then(tick).then(tick)
    .then(sendGap(Interrupted))
    .expect(subscription.gapPending and subscription.gapDeliveryAbandoned
      and subscription.gapAttempts == 3 and clientWatermark == 0 and allSafetyInvariants)
    .then(refreshSubscription(0))
    .expect(lastRefreshTruncated and not(subscription.gapPending)
      and clientWatermark == 2 and reportedGaps == Set(1) and allSafetyInvariants)

  run credentialRotationResubscribeTest = initWith(false, false)
    .then(upstreamCommit(0, Human, Critical))
    .then(tick).then(tick)
    .then(completeScan)
    .then(rotateCredential)
    .then(detectCredentialRotation)
    .expect(not(subscription.authorized) and scanResult == AuthorizationRevoked)
    .then(resubscribeAfterCredentialRotation)
    .expect(subscription.authorized and subscription.credentialGeneration == 2)
    .then(attemptDelivery(1, Accepted))
    .then(advanceWatermark)
    .expect(clientWatermark == 2 and allSafetyInvariants)

  run schemaEpochBumpTest = initWith(false, false)
    .then(upstreamCommit(0, Human, Critical))
    .then(tick).then(tick)
    .then(completeScan)
    .then(bumpSchemaEpoch)
    .then(detectSchemaEpochMismatch)
    .expect(not(subscription.authorized) and scanResult == SchemaChanged)
    .then(resubscribeAfterSchemaBump)
    .expect(subscription.authorized and subscription.schemaEpoch == 2
      and subscription.anchorWatermark == 2 and clientWatermark == 2 and allSafetyInvariants)

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
    .then(advanceWatermark)
    .expect(clientWatermark == 2 and allSafetyInvariants)

  run includeSelfSelectionTest = initWith(true, true)
    .then(upstreamCommit(0, ConfirmedSelf, Critical))
    .then(upstreamCommit(0, ConfirmedSelf, Normal))
    .then(tick).then(tick)
    .then(completeScan)
    .expect(delivery.keys() == Set(1) and allSafetyInvariants)
}
