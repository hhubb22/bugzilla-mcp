import { randomUUID } from "node:crypto";
import type { BugzillaClientEffect, BugzillaClientError } from "@bugzilla-mcp/bugzilla-client";
import {
  AccessDenied,
  AppGetDraftInputSchema,
  AppResolveProposalInputSchema,
  AppSaveDraftInputSchema,
  BugzillaCreateBugInputSchema,
  BugzillaPostAnalysisInputSchema,
  BugzillaProposeUpdateInputSchema,
  CredentialBindingRequired,
  CredentialRevoked,
  decodeOrInvalidInput,
  InvalidToolInput,
  UnsupportedAttachment,
  UpstreamTransient,
  type AppResolveProposalInput,
  type AppSaveDraftInput,
  type BugId,
  type BugzillaCreateBugInput,
  type BugzillaPostAnalysisInput,
  type BugzillaProposeUpdateInput,
  type DomainError,
  type DraftSaveResult,
  type PrincipalContext,
  type ProposalDiff,
  type WriteGuardOutcome,
} from "@bugzilla-mcp/contracts";
import {
  DEFAULT_RECEIPT_LEASE_MS,
  toEffectStorage,
  type IdempotencyScope,
  type StorageError,
  type StoredDraft,
  type StoredProposal,
  type StoredReceipt,
  type WriteAuditEntry,
} from "@bugzilla-mcp/storage";
import { Cause, Context, Effect, Exit, Layer } from "effect";
import {
  asEffectBugzillaClient,
  canonicalJson,
  clientSupportsPostPublicComment,
  runCoreEffect,
  sha256Hex,
  type AnyBugzillaClient,
} from "./canonical.js";
import type { CoreDependencies, WriteGuardService } from "./index.js";
import { createMetadataCacheEffect, type MetadataCacheEffect } from "./metadata-cache.js";

const INDETERMINATE_HINT =
  "Upstream write status is unknown after dispatch; reconcile Bugzilla before retrying.";

export type WriteGuardError = DomainError | StorageError;

export interface GuardedMutationEngine {
  postAnalysis(
    ctx: PrincipalContext,
    input: BugzillaPostAnalysisInput,
  ): Effect.Effect<WriteGuardOutcome, WriteGuardError>;
  proposeUpdate(
    ctx: PrincipalContext,
    input: BugzillaProposeUpdateInput,
  ): Effect.Effect<WriteGuardOutcome, WriteGuardError>;
  createBug(
    ctx: PrincipalContext,
    input: BugzillaCreateBugInput,
  ): Effect.Effect<WriteGuardOutcome, WriteGuardError>;
  resolveProposal(
    ctx: PrincipalContext,
    input: AppResolveProposalInput,
  ): Effect.Effect<WriteGuardOutcome, WriteGuardError>;
  saveDraft(
    ctx: PrincipalContext,
    input: AppSaveDraftInput,
  ): Effect.Effect<DraftSaveResult, WriteGuardError>;
  getDraft(
    ctx: PrincipalContext,
    params: { readonly bugId: BugId; readonly draftKind: AppSaveDraftInput["draftKind"] },
  ): Effect.Effect<StoredDraft | null, WriteGuardError>;
}

export class WriteGuardTag extends Context.Service<WriteGuardTag, GuardedMutationEngine>()(
  "@bugzilla-mcp/core/WriteGuardTag",
) {}

function nowIso(clock: () => number): string {
  return new Date(clock()).toISOString();
}

function parseTargetBugFromArtifact(artifactId: string): BugId | undefined {
  const bugMatch = /^(?:bug|update):(\d+)/.exec(artifactId);
  if (bugMatch?.[1]) return Number(bugMatch[1]);
  return undefined;
}

function isCommentOnlyDiff(diff: ProposalDiff): boolean {
  return (
    typeof diff.publicComment === "string" &&
    diff.publicComment.trim().length > 0 &&
    diff.status === undefined &&
    diff.resolution === undefined &&
    diff.assignedTo === undefined &&
    diff.priority === undefined &&
    diff.severity === undefined &&
    diff.dupeOf === undefined &&
    diff.flags === undefined
  );
}

function buildRemediationHint(
  missingFields: readonly string[] | undefined,
  bzMessage: string,
): string {
  if (missingFields && missingFields.length > 0) {
    return `Provide valid values for: ${missingFields.join(", ")}.`;
  }
  return `Adjust the request to satisfy Bugzilla validation: ${bzMessage}`;
}

function mapReadBugzillaErrorToDomain(error: BugzillaClientError, resource?: string): DomainError {
  switch (error._tag) {
    case "BugzillaCredentialRevokedError":
      return new CredentialRevoked({
        message: error.message,
        ...(error.bzErrorCode !== undefined ? { bzErrorCode: error.bzErrorCode } : {}),
      });
    case "BugzillaAccessDeniedError":
      return new AccessDenied({
        message: error.message,
        ...(resource !== undefined ? { resource } : {}),
      });
    case "BugzillaRateLimitError":
      return new UpstreamTransient({
        message: error.message,
        effectCertainty: "none",
        upstreamHttpStatus: 429,
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      });
    case "BugzillaUnsupportedAttachmentError":
      return new UnsupportedAttachment({
        message: error.message,
        ...(error.contentType !== undefined ? { contentType: error.contentType } : {}),
        ...(error.sizeBytes !== undefined ? { sizeBytes: error.sizeBytes } : {}),
      });
    case "BugzillaValidationError":
      return new InvalidToolInput({
        message: error.bzMessage,
        issues: [{ path: "$", code: "invalid_value", message: error.bzMessage }],
      });
    case "BugzillaTransientError":
      return new UpstreamTransient({
        message: error.message,
        effectCertainty: error.effectCertainty,
        ...(error.httpStatus !== undefined ? { upstreamHttpStatus: error.httpStatus } : {}),
      });
  }
}

function logStage4StorageFailure(operation: string, artifactId: string, cause: unknown): void {
  const detail = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(
    `[bugzilla-mcp/core] Stage 4 post-commit persistence failed (${operation}, artifact=${artifactId}): ${detail}\n`,
  );
}

export function createGuardedMutationEngine(deps: CoreDependencies): GuardedMutationEngine {
  const clock = deps.clock ?? (() => Date.now());
  const causalWindowMs = deps.causalBudgetWindowMs ?? 60_000;
  const leaseMs = deps.receiptLeaseMs ?? DEFAULT_RECEIPT_LEASE_MS;
  const storage = toEffectStorage(deps.storage);
  const metadataCache: MetadataCacheEffect =
    deps.metadataCache ?? createMetadataCacheEffect({ clock });
  // Synchronous in-flight proposal claim lock prevents concurrent resolution with different keys.
  const claimingProposals = new Set<string>();

  const requireClient = Effect.fnUntraced(function* (
    ctx: PrincipalContext,
  ): Effect.fn.Return<
    { readonly client: BugzillaClientEffect; readonly supportsPublicComment: boolean },
    DomainError
  > {
    const raw: AnyBugzillaClient | null = yield* Effect.tryPromise({
      try: () => deps.resolveClient(ctx),
      catch: (err) =>
        new UpstreamTransient({
          message: err instanceof Error ? err.message : String(err),
          effectCertainty: "none",
        }),
    });
    if (!raw) {
      return yield* Effect.fail(
        new CredentialBindingRequired({ message: "CredentialBindingRequired" }),
      );
    }
    return {
      client: asEffectBugzillaClient(raw),
      supportsPublicComment: clientSupportsPostPublicComment(raw),
    };
  });

  const requireBugVisibility = Effect.fnUntraced(function* (
    ctx: PrincipalContext,
    bugId: BugId,
    resolvedClient?: BugzillaClientEffect,
  ): Effect.fn.Return<void, DomainError> {
    const client = resolvedClient ?? (yield* requireClient(ctx)).client;
    const vis = yield* client
      .checkVisibility(bugId)
      .pipe(Effect.mapError((err) => mapReadBugzillaErrorToDomain(err, `bug:${bugId}`)));
    if (vis === "credential_revoked") {
      return yield* Effect.fail(new CredentialRevoked({ message: "Bugzilla credential revoked" }));
    }
    if (vis !== "visible") {
      return yield* Effect.fail(
        new AccessDenied({
          message: "Target bug is no longer accessible",
          resource: `bug:${bugId}`,
        }),
      );
    }
  });

  const handleExistingReceipt = Effect.fnUntraced(function* (
    ctx: PrincipalContext,
    scope: IdempotencyScope,
    existing: StoredReceipt,
    intentHash: string,
    targetBugId?: BugId,
  ): Effect.fn.Return<WriteGuardOutcome, WriteGuardError> {
    if (existing.intentHash !== intentHash) {
      return { outcome: "IdempotencyConflict", idempotencyKey: scope.key };
    }
    if (existing.status === "pending") {
      return { outcome: "OperationPending", idempotencyKey: scope.key };
    }
    if (existing.status === "indeterminate") {
      return {
        outcome: "OperationIndeterminate",
        idempotencyKey: scope.key,
        reconciliationHint: INDETERMINATE_HINT,
      };
    }
    if (existing.status === "applied") {
      const checkBugId = targetBugId ?? parseTargetBugFromArtifact(existing.artifactId);
      if (checkBugId !== undefined) {
        yield* requireBugVisibility(ctx, checkBugId);
      }
      return { outcome: "DuplicateNoOp", originalArtifactId: existing.artifactId };
    }
    return { outcome: "IdempotencyConflict", idempotencyKey: scope.key };
  });

  const safeFinalizeFailed = (
    scope: IdempotencyScope,
    intentHash: string,
    leaseToken: string,
    errorCode: string,
  ): Effect.Effect<void> =>
    storage
      .finalizeReceipt(
        scope,
        { status: "failed", intentHash, errorCode },
        { expectedLeaseToken: leaseToken },
      )
      .pipe(Effect.ignore);

  const safeFinalizeIndeterminate = (
    scope: IdempotencyScope,
    intentHash: string,
    leaseToken: string,
  ): Effect.Effect<void> =>
    storage
      .finalizeReceipt(
        scope,
        { status: "indeterminate", intentHash, recordedAt: nowIso(clock) },
        { expectedLeaseToken: leaseToken },
      )
      .pipe(Effect.ignore);

  const safeRevertProposal = (
    proposal: StoredProposal,
    toState: "pending" | "indeterminate" | "stale",
  ): Effect.Effect<void> =>
    storage
      .transitionProposalCas({
        issuer: proposal.issuer,
        principalId: proposal.principalId,
        instanceUrl: proposal.instanceUrl,
        proposalId: proposal.proposalId,
        revision: proposal.revision,
        fromStates: ["executing"],
        toState,
      })
      .pipe(Effect.ignore);

  const safeRefundBudget = (
    ctx: PrincipalContext,
    bugId: BugId,
    tokenId: number | undefined,
  ): Effect.Effect<void> => {
    if (tokenId === undefined) return Effect.void;
    return storage
      .refundCausalBudget({
        issuer: ctx.issuer,
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
        bugId,
        tokenId,
      })
      .pipe(Effect.ignore);
  };

  /**
   * Executes Stage 3 (commit-threshold fence + uninterruptible upstream dispatch) and
   * Stage 4 (post-commit atomic persistence strictly outside the indeterminate catch).
   */
  const executeStage3And4 = Effect.fnUntraced(function* <UpstreamRes>(params: {
    readonly ctx: PrincipalContext;
    readonly scope: IdempotencyScope;
    readonly leaseToken: string;
    readonly intentHash: string;
    readonly bugIdForCleanup?: BugId;
    readonly proposal?: StoredProposal;
    readonly resource?: string;
    readonly beforeDispatch?: () => Effect.Effect<
      | { readonly ok: true; readonly budgetTokenId?: number }
      | { readonly ok: false; readonly outcome: WriteGuardOutcome },
      WriteGuardError
    >;
    readonly dispatch: () => Effect.Effect<UpstreamRes, BugzillaClientError>;
    readonly afterUpstream: (upstream: UpstreamRes) => Effect.Effect<WriteGuardOutcome, never>;
  }): Effect.fn.Return<WriteGuardOutcome, WriteGuardError> {
    return yield* Effect.uninterruptibleMask(() =>
      Effect.gen(function* () {
        let budgetTokenId: number | undefined;
        const cleanupPreDispatch = (errorCode: string) =>
          Effect.gen(function* () {
            yield* safeRefundBudget(
              params.ctx,
              params.bugIdForCleanup ?? params.proposal?.bugId ?? 0,
              budgetTokenId,
            );
            if (params.proposal) {
              yield* safeRevertProposal(params.proposal, "pending");
            }
            yield* safeFinalizeFailed(
              params.scope,
              params.intentHash,
              params.leaseToken,
              errorCode,
            );
          });

        if (params.beforeDispatch) {
          const pre = yield* params
            .beforeDispatch()
            .pipe(Effect.onError(() => cleanupPreDispatch("commit_threshold_failed")));
          if (!pre.ok) {
            yield* cleanupPreDispatch("commit_threshold_rejected");
            return pre.outcome;
          }
          budgetTokenId = pre.budgetTokenId;
        }

        const started = yield* storage
          .markDispatchStarted(params.scope, params.leaseToken, { nowMs: clock() })
          .pipe(Effect.onError(() => cleanupPreDispatch("mark_dispatch_failed")));
        if (!started) {
          // Lease was fenced out or already transitioned.
          yield* safeRefundBudget(
            params.ctx,
            params.bugIdForCleanup ?? params.proposal?.bugId ?? 0,
            budgetTokenId,
          );
          if (params.proposal) {
            yield* safeRevertProposal(params.proposal, "pending");
          }
          return { outcome: "OperationPending" as const, idempotencyKey: params.scope.key };
        }

        // Single upstream Bugzilla write call — exhaustive classification by effectCertainty.
        type DispatchBranch =
          | { readonly kind: "ok"; readonly value: UpstreamRes }
          | { readonly kind: "outcome"; readonly outcome: WriteGuardOutcome };

        const markIndeterminate = (): Effect.Effect<DispatchBranch> =>
          Effect.gen(function* () {
            if (params.proposal) {
              yield* safeRevertProposal(params.proposal, "indeterminate");
            }
            yield* safeFinalizeIndeterminate(params.scope, params.intentHash, params.leaseToken);
            return {
              kind: "outcome" as const,
              outcome: {
                outcome: "OperationIndeterminate" as const,
                idempotencyKey: params.scope.key,
                reconciliationHint: INDETERMINATE_HINT,
              },
            };
          });

        const dispatchBranch: DispatchBranch = yield* params.dispatch().pipe(
          Effect.map((value): DispatchBranch => ({ kind: "ok", value })),
          Effect.catchTags({
            BugzillaValidationError: (err) =>
              Effect.gen(function* () {
                yield* cleanupPreDispatch("upstream_validation_rejected");
                return {
                  kind: "outcome" as const,
                  outcome: {
                    outcome: "UpstreamRejected" as const,
                    effectCertainty: "none" as const,
                    ...(err.bzErrorCode !== undefined ? { bzErrorCode: err.bzErrorCode } : {}),
                    reason: err.bzMessage,
                    ...(err.missingFields !== undefined
                      ? { missingFields: [...err.missingFields] }
                      : {}),
                    ...(err.fieldHints !== undefined
                      ? {
                          fieldHints: Object.fromEntries(
                            Object.entries(err.fieldHints).map(([k, v]) => [k, [...v]]),
                          ),
                        }
                      : {}),
                    remediationHint: buildRemediationHint(err.missingFields, err.bzMessage),
                  },
                };
              }),
            BugzillaRateLimitError: (err) =>
              Effect.gen(function* () {
                yield* cleanupPreDispatch("upstream_rate_limited");
                const retryHint =
                  err.retryAfterMs !== undefined
                    ? `Retry after ${err.retryAfterMs}ms.`
                    : "Retry after rate limit window resets.";
                return {
                  kind: "outcome" as const,
                  outcome: {
                    outcome: "UpstreamRejected" as const,
                    effectCertainty: "none" as const,
                    reason: err.message,
                    remediationHint: retryHint,
                  },
                };
              }),
            BugzillaCredentialRevokedError: (err) =>
              Effect.gen(function* () {
                yield* cleanupPreDispatch("credential_revoked");
                return yield* Effect.fail(
                  new CredentialRevoked({
                    message: err.message,
                    ...(err.bzErrorCode !== undefined ? { bzErrorCode: err.bzErrorCode } : {}),
                  }),
                );
              }),
            BugzillaAccessDeniedError: (err) =>
              Effect.gen(function* () {
                yield* cleanupPreDispatch("resource_inaccessible");
                return yield* Effect.fail(
                  new AccessDenied({
                    message: err.message,
                    ...(params.resource !== undefined ? { resource: params.resource } : {}),
                  }),
                );
              }),
            BugzillaUnsupportedAttachmentError: (err) =>
              Effect.gen(function* () {
                yield* cleanupPreDispatch("unsupported_attachment");
                return yield* Effect.fail(
                  new UnsupportedAttachment({
                    message: err.message,
                    ...(err.contentType !== undefined ? { contentType: err.contentType } : {}),
                    ...(err.sizeBytes !== undefined ? { sizeBytes: err.sizeBytes } : {}),
                  }),
                );
              }),
            BugzillaTransientError: (err) => {
              if (err.effectCertainty === "none") {
                return Effect.gen(function* () {
                  yield* cleanupPreDispatch("upstream_transient_none");
                  return yield* Effect.fail(
                    new UpstreamTransient({
                      message: err.message,
                      effectCertainty: "none",
                      ...(err.httpStatus !== undefined
                        ? { upstreamHttpStatus: err.httpStatus }
                        : {}),
                    }),
                  );
                });
              }
              return markIndeterminate();
            },
          }),
          // Any unexpected defect (Cause.Die) or interrupt AFTER markDispatchStarted
          // is indeterminate — never re-dispatch, never leave pending!
          Effect.catchCause((cause) => {
            if (Cause.hasFails(cause)) {
              return Effect.failCause(cause);
            }
            return markIndeterminate();
          }),
        );

        if (dispatchBranch.kind === "outcome") {
          return dispatchBranch.outcome;
        }

        // Stage 4 (Post-Commit Atomic Persistence — strictly OUTSIDE the indeterminate catch!).
        return yield* params.afterUpstream(dispatchBranch.value);
      }),
    );
  });

  /**
   * Dispatches a guarded bug update, routing comment-only diffs to `postPublicComment`
   * so deterministic `commentId` is captured for `[R-5d5271]` self-write attribution.
   */
  function dispatchGuardedUpdate(
    client: BugzillaClientEffect,
    supportsPublicComment: boolean,
    bugId: BugId,
    diff: ProposalDiff,
  ): Effect.Effect<
    {
      readonly updatedLastChangeTime?: string;
      readonly commentId?: number;
      readonly confirmedHistoryKey?: string;
    },
    BugzillaClientError
  > {
    if (supportsPublicComment && isCommentOnlyDiff(diff) && diff.publicComment !== undefined) {
      return client.postPublicComment(bugId, diff.publicComment).pipe(
        Effect.map((res) => ({
          commentId: res.commentId,
          ...(res.updatedLastChangeTime !== undefined
            ? { updatedLastChangeTime: res.updatedLastChangeTime }
            : {}),
        })),
      );
    }
    return client.applyBugUpdate(bugId, diff);
  }

  function commitAppliedPostDispatch(params: {
    readonly operation: string;
    readonly scope: IdempotencyScope;
    readonly leaseToken: string;
    readonly intentHash: string;
    readonly artifactId: string;
    readonly bugId: BugId;
    readonly proposal?: {
      readonly proposalId: string;
      readonly revision: number;
      readonly fromStates?: readonly ("executing" | "pending" | "approved")[];
    };
    readonly writeAudit?: WriteAuditEntry;
    readonly selfWrite?: {
      readonly issuer: string;
      readonly principalId: string;
      readonly instanceUrl: string;
      readonly bugId: BugId;
      readonly commentId?: number;
      readonly diffKey?: string;
    };
  }): Effect.Effect<WriteGuardOutcome, never> {
    return storage
      .commitAppliedMutation({
        scope: params.scope,
        leaseToken: params.leaseToken,
        intentHash: params.intentHash,
        artifactId: params.artifactId,
        ...(params.proposal !== undefined ? { proposal: params.proposal } : {}),
        ...(params.writeAudit !== undefined ? { writeAudit: params.writeAudit } : {}),
        ...(params.selfWrite !== undefined ? { selfWrite: params.selfWrite } : {}),
      })
      .pipe(
        Effect.matchCause({
          onSuccess: (res): WriteGuardOutcome => {
            if (!res.committed) {
              logStage4StorageFailure(
                params.operation,
                params.artifactId,
                `commitAppliedMutation returned committed=false (${res.reason})`,
              );
              return {
                outcome: "Applied",
                artifactId: params.artifactId,
                bugId: params.bugId,
                auditRecorded: false,
              };
            }
            return {
              outcome: "Applied",
              artifactId: params.artifactId,
              bugId: params.bugId,
              auditRecorded: params.writeAudit !== undefined,
            };
          },
          onFailure: (cause): WriteGuardOutcome => {
            // Bugzilla already returned 2xx; NEVER regress applied -> indeterminate!
            logStage4StorageFailure(params.operation, params.artifactId, Cause.squash(cause));
            return {
              outcome: "Applied",
              artifactId: params.artifactId,
              bugId: params.bugId,
              auditRecorded: false,
            };
          },
        }),
      );
  }

  const postAnalysis: GuardedMutationEngine["postAnalysis"] = Effect.fn("WriteGuard.postAnalysis")(
    function* (ctx: PrincipalContext, input: BugzillaPostAnalysisInput) {
      // Stage 1: Pre-Reserve (0 durable side effects)
      const validInput = yield* decodeOrInvalidInput(BugzillaPostAnalysisInputSchema, input, {
        contextLabel: "bugzilla_post_analysis",
      });
      const { client } = yield* requireClient(ctx);

      const scope: IdempotencyScope = {
        issuer: ctx.issuer,
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
        operation: "bugzilla_post_analysis",
        key: validInput.idempotencyKey,
      };
      const intentHash = sha256Hex(
        canonicalJson({
          bugId: validInput.bugId,
          isPrivate: true,
          analysisMarkdown: validInput.analysisMarkdown,
        }),
      );

      // Stage 2: Reserve + Pre-Dispatch Checks with uninterruptible onExit cleanup
      const reservation = yield* storage.reservePending(scope, intentHash, {
        nowMs: clock(),
        leaseMs,
      });
      if (reservation.kind === "existing") {
        return yield* handleExistingReceipt(
          ctx,
          scope,
          reservation.receipt,
          intentHash,
          validInput.bugId,
        );
      }
      const { leaseToken } = reservation;
      let stage3Entered = false;

      return yield* Effect.gen(function* () {
        const caps = yield* client
          .probeCapabilities()
          .pipe(
            Effect.mapError((err) => mapReadBugzillaErrorToDomain(err, `bug:${validInput.bugId}`)),
          );

        if (!caps.isInsider) {
          // SavedAsInternalNote retains causal-budget decrement per #13 #6 / write_guard.qnt.
          return yield* Effect.uninterruptibleMask(() =>
            Effect.gen(function* () {
              stage3Entered = true;
              const budget = yield* storage.consumeCausalBudget({
                issuer: ctx.issuer,
                principalId: ctx.principalId,
                instanceUrl: ctx.instanceUrl,
                bugId: validInput.bugId,
                maxWrites: deps.causalBudgetPerBug,
                windowMs: causalWindowMs,
                nowMs: clock(),
              });
              if (!budget.allowed) {
                yield* safeFinalizeFailed(scope, intentHash, leaseToken, "causal_budget_exhausted");
                return {
                  outcome: "CausalBudgetExhausted" as const,
                  bugId: validInput.bugId,
                  retryAfterMs: Math.max(1, budget.retryAfterMs ?? causalWindowMs),
                };
              }
              const note = yield* storage.saveInternalNote(
                ctx.issuer,
                ctx.principalId,
                ctx.instanceUrl,
                validInput.bugId,
                validInput.analysisMarkdown,
              );
              yield* storage
                .commitAppliedMutation({
                  scope,
                  leaseToken,
                  intentHash,
                  artifactId: note.id,
                })
                .pipe(
                  Effect.catchCause((cause) => {
                    logStage4StorageFailure(
                      "postAnalysis.non_insider",
                      note.id,
                      Cause.squash(cause),
                    );
                    return Effect.void;
                  }),
                );
              return {
                outcome: "SavedAsInternalNote" as const,
                noteId: note.id,
                bugId: validInput.bugId,
                reason: "non_insider" as const,
              };
            }),
          );
        }

        stage3Entered = true;
        return yield* executeStage3And4({
          ctx,
          scope,
          leaseToken,
          intentHash,
          bugIdForCleanup: validInput.bugId,
          resource: `bug:${validInput.bugId}`,
          beforeDispatch: () =>
            Effect.gen(function* () {
              const budget = yield* storage.consumeCausalBudget({
                issuer: ctx.issuer,
                principalId: ctx.principalId,
                instanceUrl: ctx.instanceUrl,
                bugId: validInput.bugId,
                maxWrites: deps.causalBudgetPerBug,
                windowMs: causalWindowMs,
                nowMs: clock(),
              });
              if (!budget.allowed) {
                return {
                  ok: false as const,
                  outcome: {
                    outcome: "CausalBudgetExhausted" as const,
                    bugId: validInput.bugId,
                    retryAfterMs: Math.max(1, budget.retryAfterMs ?? causalWindowMs),
                  },
                };
              }
              return {
                ok: true as const,
                ...(budget.tokenId !== undefined ? { budgetTokenId: budget.tokenId } : {}),
              };
            }),
          dispatch: () => client.postPrivateComment(validInput.bugId, validInput.analysisMarkdown),
          afterUpstream: (res) => {
            if (res.kind === "private_rejected") {
              // SavedAsInternalNote retains causal-budget decrement per #13 #6.
              return storage
                .saveInternalNote(
                  ctx.issuer,
                  ctx.principalId,
                  ctx.instanceUrl,
                  validInput.bugId,
                  validInput.analysisMarkdown,
                )
                .pipe(
                  Effect.flatMap((note) =>
                    storage
                      .commitAppliedMutation({
                        scope,
                        leaseToken,
                        intentHash,
                        artifactId: note.id,
                      })
                      .pipe(
                        Effect.catchCause((cause) => {
                          logStage4StorageFailure(
                            "postAnalysis.private_rejected",
                            note.id,
                            Cause.squash(cause),
                          );
                          return Effect.void;
                        }),
                        Effect.as<WriteGuardOutcome>({
                          outcome: "SavedAsInternalNote",
                          noteId: note.id,
                          bugId: validInput.bugId,
                          reason: "private_rejected",
                        }),
                      ),
                  ),
                  Effect.catchCause((cause) => {
                    logStage4StorageFailure(
                      "postAnalysis.saveInternalNote",
                      `bug:${validInput.bugId}`,
                      Cause.squash(cause),
                    );
                    return Effect.succeed<WriteGuardOutcome>({
                      outcome: "SavedAsInternalNote",
                      noteId: `note-unpersisted:${validInput.bugId}`,
                      bugId: validInput.bugId,
                      reason: "private_rejected",
                    });
                  }),
                );
            }
            const artifactId = `comment:${res.commentId}`;
            return commitAppliedPostDispatch({
              operation: "postAnalysis",
              scope,
              leaseToken,
              intentHash,
              artifactId,
              bugId: validInput.bugId,
              selfWrite: {
                issuer: ctx.issuer,
                principalId: ctx.principalId,
                instanceUrl: ctx.instanceUrl,
                bugId: validInput.bugId,
                commentId: res.commentId,
              },
            });
          },
        });
      }).pipe(
        Effect.onExit((exit) =>
          !stage3Entered && Exit.isFailure(exit)
            ? safeFinalizeFailed(scope, intentHash, leaseToken, "preflight_failed")
            : Effect.void,
        ),
      );
    },
  );

  const proposeUpdate: GuardedMutationEngine["proposeUpdate"] = Effect.fn(
    "WriteGuard.proposeUpdate",
  )(function* (ctx: PrincipalContext, input: BugzillaProposeUpdateInput) {
    // Stage 1: Pre-Reserve (0 durable side effects)
    const validInput = yield* decodeOrInvalidInput(BugzillaProposeUpdateInputSchema, input, {
      contextLabel: "bugzilla_propose_update",
    });
    const { client, supportsPublicComment } = yield* requireClient(ctx);

    const scope: IdempotencyScope = {
      issuer: ctx.issuer,
      principalId: ctx.principalId,
      instanceUrl: ctx.instanceUrl,
      operation: "bugzilla_propose_update",
      key: validInput.idempotencyKey,
    };
    const intentHash = sha256Hex(
      canonicalJson({
        bugId: validInput.bugId,
        expectedLastChangeTime: validInput.expectedLastChangeTime,
        diff: validInput.diff,
        rationale: validInput.rationale,
      }),
    );

    // Stage 2: Reserve + Pre-Dispatch Checks with uninterruptible onExit cleanup
    const reservation = yield* storage.reservePending(scope, intentHash, {
      nowMs: clock(),
      leaseMs,
    });
    if (reservation.kind === "existing") {
      return yield* handleExistingReceipt(
        ctx,
        scope,
        reservation.receipt,
        intentHash,
        validInput.bugId,
      );
    }
    const { leaseToken } = reservation;
    let stage3Entered = false;
    let settledInStage2 = false;

    return yield* Effect.gen(function* () {
      const policyGranted = deps.isPolicyGranted
        ? yield* Effect.tryPromise({
            try: () => deps.isPolicyGranted!(ctx, validInput),
            catch: (err) =>
              new UpstreamTransient({
                message: err instanceof Error ? err.message : String(err),
                effectCertainty: "none",
              }),
          })
        : false;

      if (!policyGranted) {
        const proposalId = `prop-${randomUUID()}`;
        const revision = 1;
        const stored: StoredProposal = {
          proposalId,
          revision,
          issuer: ctx.issuer,
          principalId: ctx.principalId,
          instanceUrl: ctx.instanceUrl,
          bugId: validInput.bugId,
          baseVersion: validInput.expectedLastChangeTime,
          diff: validInput.diff,
          rationale: validInput.rationale,
          state: "pending",
        };
        yield* storage.saveProposal(stored);
        yield* storage.finalizeReceipt(
          scope,
          {
            status: "applied",
            intentHash,
            artifactId: `${proposalId}:${revision}`,
          },
          { expectedLeaseToken: leaseToken },
        );
        settledInStage2 = true;
        return {
          outcome: "ProposalPending" as const,
          proposalId,
          revision,
        };
      }

      const dossier = yield* client
        .getBugDossierData(validInput.bugId, { maxComments: 0, maxHistory: 0 })
        .pipe(
          Effect.mapError((err) => mapReadBugzillaErrorToDomain(err, `bug:${validInput.bugId}`)),
        );
      if (!dossier) {
        return yield* Effect.fail(
          new AccessDenied({
            message: "Bug not found or inaccessible",
            resource: `bug:${validInput.bugId}`,
          }),
        );
      }
      if (dossier.bug.lastChangeTime !== validInput.expectedLastChangeTime) {
        yield* safeFinalizeFailed(scope, intentHash, leaseToken, "stale_bug_conflict");
        settledInStage2 = true;
        return {
          outcome: "StaleBugConflict" as const,
          expectedLastChangeTime: validInput.expectedLastChangeTime,
          actualLastChangeTime: dossier.bug.lastChangeTime,
          latestAuthorizedSnapshot: dossier.bug,
        };
      }

      stage3Entered = true;
      return yield* executeStage3And4({
        ctx,
        scope,
        leaseToken,
        intentHash,
        bugIdForCleanup: validInput.bugId,
        resource: `bug:${validInput.bugId}`,
        dispatch: () =>
          dispatchGuardedUpdate(client, supportsPublicComment, validInput.bugId, validInput.diff),
        afterUpstream: (updated) => {
          const updatedLastChangeTime = updated.updatedLastChangeTime ?? nowIso(clock);
          const artifactSuffix =
            updated.updatedLastChangeTime ??
            (updated.commentId !== undefined
              ? `comment-${updated.commentId}`
              : updatedLastChangeTime);
          const artifactId = `update:${validInput.bugId}:${artifactSuffix}`;
          return commitAppliedPostDispatch({
            operation: "proposeUpdate",
            scope,
            leaseToken,
            intentHash,
            artifactId,
            bugId: validInput.bugId,
            writeAudit: {
              auditId: randomUUID(),
              issuer: ctx.issuer,
              principalId: ctx.principalId,
              instanceUrl: ctx.instanceUrl,
              bugId: validInput.bugId,
              expectedLastChangeTime: validInput.expectedLastChangeTime,
              updatedLastChangeTime,
              diff: validInput.diff,
              recordedAt: nowIso(clock),
            },
            selfWrite: {
              issuer: ctx.issuer,
              principalId: ctx.principalId,
              instanceUrl: ctx.instanceUrl,
              bugId: validInput.bugId,
              ...(updated.commentId !== undefined ? { commentId: updated.commentId } : {}),
              ...(updated.confirmedHistoryKey ? { diffKey: updated.confirmedHistoryKey } : {}),
            },
          });
        },
      });
    }).pipe(
      Effect.onExit((exit) =>
        !stage3Entered && !settledInStage2 && Exit.isFailure(exit)
          ? safeFinalizeFailed(scope, intentHash, leaseToken, "preflight_failed")
          : Effect.void,
      ),
    );
  });

  const createBug: GuardedMutationEngine["createBug"] = Effect.fn("WriteGuard.createBug")(
    function* (ctx: PrincipalContext, input: BugzillaCreateBugInput) {
      // Stage 1: Pre-Reserve (0 durable side effects)
      const validInput = yield* decodeOrInvalidInput(BugzillaCreateBugInputSchema, input, {
        contextLabel: "bugzilla_create_bug",
      });
      const { client } = yield* requireClient(ctx);
      const { idempotencyKey, ...rawPayload } = validInput;

      const scope: IdempotencyScope = {
        issuer: ctx.issuer,
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
        operation: "bugzilla_create_bug",
        key: idempotencyKey,
      };
      const intentHash = sha256Hex(canonicalJson(rawPayload));

      // Check existing non-failed receipt read-only before preflight so idempotent retries
      // never lose DuplicateNoOp / OperationIndeterminate / IdempotencyConflict semantics,
      // while still allowing expired leases to reclaim (pre-dispatch) or lock indeterminate (post-dispatch).
      const nowBeforePreflight = clock();
      const existingBeforePreflight = yield* storage.getReceipt(scope);
      if (existingBeforePreflight && existingBeforePreflight.status !== "failed") {
        if (
          existingBeforePreflight.status === "pending" &&
          nowBeforePreflight >= existingBeforePreflight.leaseExpiresAtMs
        ) {
          if (existingBeforePreflight.dispatchAttempted) {
            const expiredRes = yield* storage.reservePending(scope, intentHash, {
              nowMs: nowBeforePreflight,
              leaseMs,
            });
            if (expiredRes.kind === "existing") {
              return yield* handleExistingReceipt(ctx, scope, expiredRes.receipt, intentHash);
            }
          }
          // Expired pre-dispatch lease (dispatchAttempted === false): fall through to preflight & reclaim.
        } else {
          return yield* handleExistingReceipt(ctx, scope, existingBeforePreflight, intentHash);
        }
      }

      // Lazy per-tenant metadata preflight (0 durable side effects!).
      const preflight = yield* metadataCache.preflightCreateBug(ctx, client, rawPayload).pipe(
        Effect.mapError(
          (err) =>
            new CredentialRevoked({
              message: err.message,
              ...(err.bzErrorCode !== undefined ? { bzErrorCode: err.bzErrorCode } : {}),
            }),
        ),
      );
      if (!preflight.ok) {
        return {
          outcome: "UpstreamRejected" as const,
          effectCertainty: "none" as const,
          reason: preflight.reason,
          missingFields: [...preflight.missingFields],
          fieldHints: Object.fromEntries(
            Object.entries(preflight.fieldHints).map(([k, v]) => [k, [...v]]),
          ),
          remediationHint: preflight.remediationHint,
        };
      }

      const dispatchPayload: Omit<BugzillaCreateBugInput, "idempotencyKey"> = {
        ...rawPayload,
        ...(rawPayload.opSys === undefined && preflight.resolvedOpSys !== undefined
          ? { opSys: preflight.resolvedOpSys }
          : {}),
        ...(rawPayload.platform === undefined && preflight.resolvedPlatform !== undefined
          ? { platform: preflight.resolvedPlatform }
          : {}),
      };

      // Stage 2: Reserve
      const reservation = yield* storage.reservePending(scope, intentHash, {
        nowMs: clock(),
        leaseMs,
      });
      if (reservation.kind === "existing") {
        return yield* handleExistingReceipt(ctx, scope, reservation.receipt, intentHash);
      }
      const { leaseToken } = reservation;

      // Stage 3 + Stage 4
      return yield* executeStage3And4({
        ctx,
        scope,
        leaseToken,
        intentHash,
        dispatch: () => client.createBug(dispatchPayload),
        afterUpstream: (created) => {
          const artifactId = `bug:${created.bugId}`;
          return commitAppliedPostDispatch({
            operation: "createBug",
            scope,
            leaseToken,
            intentHash,
            artifactId,
            bugId: created.bugId,
            selfWrite: {
              issuer: ctx.issuer,
              principalId: ctx.principalId,
              instanceUrl: ctx.instanceUrl,
              bugId: created.bugId,
              diffKey: `created-${created.bugId}`,
            },
          });
        },
      });
    },
  );

  const resolveProposal: GuardedMutationEngine["resolveProposal"] = Effect.fn(
    "WriteGuard.resolveProposal",
  )(function* (ctx: PrincipalContext, input: AppResolveProposalInput) {
    // Stage 1: Pre-Reserve (0 durable side effects)
    const validInput = yield* decodeOrInvalidInput(AppResolveProposalInputSchema, input, {
      contextLabel: "app_resolve_proposal",
    });
    const { client, supportsPublicComment } = yield* requireClient(ctx);

    const scope: IdempotencyScope = {
      issuer: ctx.issuer,
      principalId: ctx.principalId,
      instanceUrl: ctx.instanceUrl,
      operation: "app_resolve_proposal",
      key: validInput.idempotencyKey,
    };
    const intentHash = sha256Hex(
      canonicalJson({
        proposalId: validInput.proposalId,
        revision: validInput.revision,
        decision: validInput.decision,
      }),
    );

    let proposal = yield* storage.getProposal(
      ctx.issuer,
      ctx.principalId,
      ctx.instanceUrl,
      validInput.proposalId,
      validInput.revision,
    );

    const claimKey = JSON.stringify([
      ctx.issuer,
      ctx.principalId,
      ctx.instanceUrl,
      validInput.proposalId,
      validInput.revision,
    ]);

    // Check existing non-failed receipt read-only before checking pending state so
    // idempotent retries after apply/reject still return DuplicateNoOp / OperationIndeterminate,
    // while expired leases properly reclaim (pre-dispatch) or transition to indeterminate (post-dispatch).
    const nowBeforeResolve = clock();
    const existingReceipt = yield* storage.getReceipt(scope);
    if (existingReceipt && existingReceipt.status !== "failed") {
      if (
        existingReceipt.status === "pending" &&
        nowBeforeResolve >= existingReceipt.leaseExpiresAtMs
      ) {
        if (existingReceipt.dispatchAttempted) {
          const expiredRes = yield* storage.reservePending(scope, intentHash, {
            nowMs: nowBeforeResolve,
            leaseMs,
          });
          if (proposal?.state === "executing") {
            yield* safeRevertProposal(proposal, "indeterminate");
          }
          if (expiredRes.kind === "existing") {
            return yield* handleExistingReceipt(
              ctx,
              scope,
              expiredRes.receipt,
              intentHash,
              proposal?.bugId,
            );
          }
        } else if (proposal?.state === "executing" && !claimingProposals.has(claimKey)) {
          const reverted = yield* storage.transitionProposalCas({
            issuer: ctx.issuer,
            principalId: ctx.principalId,
            instanceUrl: ctx.instanceUrl,
            proposalId: proposal.proposalId,
            revision: proposal.revision,
            fromStates: ["executing"],
            toState: "pending",
          });
          if (reverted) {
            proposal = { ...proposal, state: "pending" };
          }
        }
      } else {
        return yield* handleExistingReceipt(
          ctx,
          scope,
          existingReceipt,
          intentHash,
          proposal?.bugId,
        );
      }
    }

    if (!proposal || proposal.state !== "pending") {
      return yield* Effect.fail(
        new InvalidToolInput({
          message: "Proposal not found or already resolved",
          issues: [
            {
              path: "proposalId",
              code: "invalid_value",
              message: "Proposal not found or already resolved",
            },
          ],
        }),
      );
    }

    // Stage 1 non-consuming approval proof verification (0 JTI consumption, 0 receipt mutation).
    let verifiedCloudJti: { readonly jti: string; readonly expiresAtMs: number } | undefined;
    let needsFallbackVerifyAndConsume = false;

    if (validInput.decision === "approve") {
      if (!validInput.approval) {
        return yield* Effect.fail(
          new AccessDenied({
            message: "Guarded proposal approval requires a valid approval proof",
          }),
        );
      }

      switch (validInput.approval.kind) {
        case "cloud_signed_token": {
          if (!deps.cloudApprovalService) {
            return yield* Effect.fail(
              new UpstreamTransient({
                message: "Cloud approval verification service is not configured",
                effectCertainty: "none",
              }),
            );
          }
          if (deps.cloudApprovalService.verifySignatureAndBinding) {
            const precheck = yield* Effect.tryPromise({
              try: () =>
                deps.cloudApprovalService!.verifySignatureAndBinding!(
                  validInput.approval!.kind === "cloud_signed_token"
                    ? validInput.approval!.token
                    : "",
                  {
                    approverIssuer: ctx.issuer,
                    approverPrincipalId: ctx.principalId,
                    instanceUrl: ctx.instanceUrl,
                    proposalId: proposal.proposalId,
                    revision: proposal.revision,
                    bugId: proposal.bugId,
                    baseVersion: proposal.baseVersion,
                    diff: proposal.diff,
                    visibility: "public",
                    nowMs: clock(),
                  },
                ),
              catch: (err) =>
                new UpstreamTransient({
                  message: err instanceof Error ? err.message : String(err),
                  effectCertainty: "none",
                }),
            });
            if (!precheck.valid) {
              return yield* Effect.fail(
                new AccessDenied({
                  message: `Approval verification failed: ${precheck.reason}`,
                }),
              );
            }
            verifiedCloudJti = { jti: precheck.jti, expiresAtMs: precheck.expiresAtMs };
          } else {
            needsFallbackVerifyAndConsume = true;
          }
          break;
        }
        case "local_ide_host_confirmed": {
          if (ctx.deploymentMode !== "local-trusted-ide") {
            return yield* Effect.fail(
              new AccessDenied({
                message: "Cloud guarded execution requires a server-verified signed approval token",
              }),
            );
          }
          break;
        }
        case "policy_grant": {
          const granted = deps.isPolicyGranted
            ? yield* Effect.tryPromise({
                try: () =>
                  deps.isPolicyGranted!(ctx, {
                    bugId: proposal.bugId,
                    idempotencyKey: validInput.idempotencyKey,
                    expectedLastChangeTime: proposal.baseVersion,
                    diff: proposal.diff,
                    rationale: proposal.rationale,
                  }),
                catch: (err) =>
                  new UpstreamTransient({
                    message: err instanceof Error ? err.message : String(err),
                    effectCertainty: "none",
                  }),
              })
            : false;
          if (!granted) {
            return yield* Effect.fail(
              new AccessDenied({ message: "Policy grant denied by server policy" }),
            );
          }
          break;
        }
      }
    }

    // Stage 2: Reserve + synchronous in-flight guard + CAS + dossier check
    const reservation = yield* storage.reservePending(scope, intentHash, {
      nowMs: clock(),
      leaseMs,
    });
    if (reservation.kind === "existing") {
      return yield* handleExistingReceipt(
        ctx,
        scope,
        reservation.receipt,
        intentHash,
        proposal.bugId,
      );
    }
    const { leaseToken } = reservation;

    if (claimingProposals.has(claimKey)) {
      yield* safeFinalizeFailed(scope, intentHash, leaseToken, "proposal_claim_in_flight");
      return yield* Effect.fail(
        new InvalidToolInput({
          message: "Proposal resolution already in flight",
          issues: [
            {
              path: "proposalId",
              code: "invalid_value",
              message: "Proposal resolution already in flight",
            },
          ],
        }),
      );
    }
    claimingProposals.add(claimKey);

    let proposalClaimedExecuting = false;
    let stage3Entered = false;
    let settledInStage2 = false;

    return yield* Effect.gen(function* () {
      if (validInput.decision === "reject") {
        const won = yield* storage.transitionProposalCas({
          issuer: ctx.issuer,
          principalId: ctx.principalId,
          instanceUrl: ctx.instanceUrl,
          proposalId: proposal.proposalId,
          revision: proposal.revision,
          fromStates: ["pending"],
          toState: "rejected",
        });
        if (!won) {
          return yield* Effect.fail(
            new InvalidToolInput({
              message: "Proposal not found or already resolved",
              issues: [
                {
                  path: "proposalId",
                  code: "invalid_value",
                  message: "Proposal not found or already resolved",
                },
              ],
            }),
          );
        }
        const artifactId = `rejected:${proposal.proposalId}:${proposal.revision}`;
        const rejectedAt = nowIso(clock);
        yield* storage.finalizeReceipt(
          scope,
          { status: "applied", intentHash, artifactId },
          { expectedLeaseToken: leaseToken },
        );
        settledInStage2 = true;
        return {
          outcome: "ProposalRejected" as const,
          proposalId: proposal.proposalId,
          revision: proposal.revision,
          bugId: proposal.bugId,
          artifactId,
          rejectedAt,
        };
      }

      // Atomically claim pending -> executing before upstream checks.
      const won = yield* storage.transitionProposalCas({
        issuer: ctx.issuer,
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
        proposalId: proposal.proposalId,
        revision: proposal.revision,
        fromStates: ["pending"],
        toState: "executing",
      });
      if (!won) {
        return yield* Effect.fail(
          new InvalidToolInput({
            message: "Proposal not found or already resolved",
            issues: [
              {
                path: "proposalId",
                code: "invalid_value",
                message: "Proposal not found or already resolved",
              },
            ],
          }),
        );
      }
      proposalClaimedExecuting = true;

      // Optimistic last_change_time freshness check.
      const dossier = yield* client
        .getBugDossierData(proposal.bugId, { maxComments: 0, maxHistory: 0 })
        .pipe(Effect.mapError((err) => mapReadBugzillaErrorToDomain(err, `bug:${proposal.bugId}`)));
      if (!dossier) {
        return yield* Effect.fail(
          new AccessDenied({
            message: "Bug inaccessible",
            resource: `bug:${proposal.bugId}`,
          }),
        );
      }
      if (dossier.bug.lastChangeTime !== proposal.baseVersion) {
        yield* safeRevertProposal(proposal, "stale");
        proposalClaimedExecuting = false;
        yield* safeFinalizeFailed(scope, intentHash, leaseToken, "stale_bug_conflict");
        settledInStage2 = true;
        return {
          outcome: "StaleBugConflict" as const,
          expectedLastChangeTime: proposal.baseVersion,
          actualLastChangeTime: dossier.bug.lastChangeTime,
          latestAuthorizedSnapshot: dossier.bug,
        };
      }

      // Stage 3 + Stage 4: Commit-threshold JTI consumption + uninterruptible dispatch
      stage3Entered = true;
      const beforeDispatch =
        validInput.approval?.kind === "cloud_signed_token"
          ? () =>
              Effect.gen(function* () {
                if (verifiedCloudJti && deps.cloudApprovalService?.consumeVerifiedJti) {
                  const consumed = yield* Effect.tryPromise({
                    try: () =>
                      deps.cloudApprovalService!.consumeVerifiedJti!(
                        verifiedCloudJti!.jti,
                        verifiedCloudJti!.expiresAtMs,
                        clock(),
                      ),
                    catch: (err) =>
                      new UpstreamTransient({
                        message: err instanceof Error ? err.message : String(err),
                        effectCertainty: "none",
                      }),
                  });
                  if (!consumed) {
                    return yield* Effect.fail(
                      new AccessDenied({
                        message: "Approval verification failed: replayed",
                      }),
                    );
                  }
                  return { ok: true as const };
                }
                if (needsFallbackVerifyAndConsume && deps.cloudApprovalService) {
                  const token =
                    validInput.approval?.kind === "cloud_signed_token"
                      ? validInput.approval.token
                      : "";
                  const verified = yield* Effect.tryPromise({
                    try: () =>
                      deps.cloudApprovalService!.verifyAndConsume(token, {
                        approverIssuer: ctx.issuer,
                        approverPrincipalId: ctx.principalId,
                        instanceUrl: ctx.instanceUrl,
                        proposalId: proposal.proposalId,
                        revision: proposal.revision,
                        bugId: proposal.bugId,
                        baseVersion: proposal.baseVersion,
                        diff: proposal.diff,
                        visibility: "public",
                        nowMs: clock(),
                      }),
                    catch: (err) =>
                      new UpstreamTransient({
                        message: err instanceof Error ? err.message : String(err),
                        effectCertainty: "none",
                      }),
                  });
                  if (!verified.valid) {
                    return yield* Effect.fail(
                      new AccessDenied({
                        message: `Approval verification failed: ${verified.reason}`,
                      }),
                    );
                  }
                }
                return { ok: true as const };
              })
          : undefined;
      return yield* executeStage3And4({
        ctx,
        scope,
        leaseToken,
        intentHash,
        proposal,
        resource: `bug:${proposal.bugId}`,
        ...(beforeDispatch !== undefined ? { beforeDispatch } : {}),
        dispatch: () =>
          dispatchGuardedUpdate(client, supportsPublicComment, proposal.bugId, proposal.diff),
        afterUpstream: (updated) => {
          const updatedLastChangeTime = updated.updatedLastChangeTime ?? nowIso(clock);
          const artifactSuffix =
            updated.updatedLastChangeTime ??
            (updated.commentId !== undefined
              ? `comment-${updated.commentId}`
              : updatedLastChangeTime);
          const artifactId = `update:${proposal.bugId}:${artifactSuffix}`;
          return commitAppliedPostDispatch({
            operation: "resolveProposal",
            scope,
            leaseToken,
            intentHash,
            artifactId,
            bugId: proposal.bugId,
            proposal: {
              proposalId: proposal.proposalId,
              revision: proposal.revision,
              fromStates: ["executing"],
            },
            writeAudit: {
              auditId: randomUUID(),
              issuer: ctx.issuer,
              principalId: ctx.principalId,
              instanceUrl: ctx.instanceUrl,
              bugId: proposal.bugId,
              proposalId: proposal.proposalId,
              revision: proposal.revision,
              expectedLastChangeTime: proposal.baseVersion,
              updatedLastChangeTime,
              diff: proposal.diff,
              recordedAt: nowIso(clock),
            },
            selfWrite: {
              issuer: ctx.issuer,
              principalId: ctx.principalId,
              instanceUrl: ctx.instanceUrl,
              bugId: proposal.bugId,
              ...(updated.commentId !== undefined ? { commentId: updated.commentId } : {}),
              ...(updated.confirmedHistoryKey ? { diffKey: updated.confirmedHistoryKey } : {}),
            },
          });
        },
      });
    }).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          claimingProposals.delete(claimKey);
          if (!stage3Entered && !settledInStage2 && Exit.isFailure(exit)) {
            if (proposalClaimedExecuting) {
              yield* safeRevertProposal(proposal, "pending");
            }
            yield* safeFinalizeFailed(scope, intentHash, leaseToken, "preflight_failed");
          }
        }),
      ),
    );
  });

  const saveDraft: GuardedMutationEngine["saveDraft"] = Effect.fn("WriteGuard.saveDraft")(
    function* (ctx: PrincipalContext, input: AppSaveDraftInput) {
      const validInput = yield* decodeOrInvalidInput(AppSaveDraftInputSchema, input, {
        contextLabel: "app_save_draft",
      });
      yield* requireBugVisibility(ctx, validInput.bugId);
      return yield* storage.saveDraft({
        issuer: ctx.issuer,
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
        bugId: validInput.bugId,
        draftKind: validInput.draftKind,
        draftRevision: validInput.draftRevision,
        content: validInput.content,
      });
    },
  );

  const getDraft: GuardedMutationEngine["getDraft"] = Effect.fn("WriteGuard.getDraft")(function* (
    ctx: PrincipalContext,
    params: { readonly bugId: BugId; readonly draftKind: AppSaveDraftInput["draftKind"] },
  ) {
    const validParams = yield* decodeOrInvalidInput(AppGetDraftInputSchema, params, {
      contextLabel: "app_get_draft",
    });
    yield* requireBugVisibility(ctx, validParams.bugId);
    return yield* storage.getDraft({
      issuer: ctx.issuer,
      principalId: ctx.principalId,
      instanceUrl: ctx.instanceUrl,
      bugId: validParams.bugId,
      draftKind: validParams.draftKind,
    });
  });

  return WriteGuardTag.of({
    postAnalysis,
    proposeUpdate,
    createBug,
    resolveProposal,
    saveDraft,
    getDraft,
  });
}

export function makeWriteGuardLayer(deps: CoreDependencies): Layer.Layer<WriteGuardTag> {
  return Layer.succeed(WriteGuardTag, createGuardedMutationEngine(deps));
}

export function buildWriteGuardService(deps: CoreDependencies): WriteGuardService {
  const engine = createGuardedMutationEngine(deps);
  return {
    postAnalysis: (ctx, input) => runCoreEffect(engine.postAnalysis(ctx, input)),
    proposeUpdate: (ctx, input) => runCoreEffect(engine.proposeUpdate(ctx, input)),
    createBug: (ctx, input) => runCoreEffect(engine.createBug(ctx, input)),
    resolveProposal: (ctx, input) => runCoreEffect(engine.resolveProposal(ctx, input)),
    saveDraft: (ctx, input) => runCoreEffect(engine.saveDraft(ctx, input)),
    getDraft: (ctx, params) => runCoreEffect(engine.getDraft(ctx, params)),
  };
}
