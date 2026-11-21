import { randomUUID } from "node:crypto";
import {
  BugzillaPostAnalysisInputSchema,
  McpErrorCode,
  type AppResolveProposalInput,
  type AppSaveDraftInput,
  type BugId,
  type BugzillaCreateBugInput,
  type BugzillaPostAnalysisInput,
  type BugzillaProposeUpdateInput,
  type PrincipalContext,
  type WriteGuardOutcome,
} from "@bugzilla-mcp/contracts";
import type { IdempotencyScope, StoredProposal, StoredReceipt } from "@bugzilla-mcp/storage";
import { canonicalJson, McpDomainError, sha256Hex } from "./canonical.js";
import type { CoreDependencies, WriteGuardService } from "./index.js";

const INDETERMINATE_HINT =
  "Upstream write status is unknown after dispatch; reconcile Bugzilla before retrying.";

function nowIso(clock: () => number): string {
  return new Date(clock()).toISOString();
}

export function buildWriteGuardService(deps: CoreDependencies): WriteGuardService {
  const clock = deps.clock ?? (() => Date.now());
  const causalWindowMs = deps.causalBudgetWindowMs ?? 60_000;
  // Synchronous in-flight proposal claim lock prevents concurrent resolution with different keys (WRITE-01)
  const claimingProposals = new Set<string>();

  function parseTargetBugFromArtifact(artifactId: string): BugId | undefined {
    const bugMatch = /^(?:bug|update):(\d+)/.exec(artifactId);
    if (bugMatch?.[1]) return Number(bugMatch[1]);
    return undefined;
  }

  async function requireClient(ctx: PrincipalContext) {
    const client = await deps.resolveClient(ctx);
    if (!client) {
      throw new McpDomainError(McpErrorCode.INVALID_PARAMS, "CredentialBindingRequired");
    }
    return client;
  }

  async function handleExistingReceipt(
    ctx: PrincipalContext,
    scope: IdempotencyScope,
    existing: StoredReceipt,
    intentHash: string,
    targetBugId?: BugId,
  ): Promise<WriteGuardOutcome> {
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
        const client = await requireClient(ctx);
        const vis = await client.checkVisibility(checkBugId);
        if (vis !== "visible") {
          throw new McpDomainError(
            McpErrorCode.INVALID_PARAMS,
            "Target bug is no longer accessible",
          );
        }
      }
      return { outcome: "DuplicateNoOp", originalArtifactId: existing.artifactId };
    }
    return { outcome: "IdempotencyConflict", idempotencyKey: scope.key };
  }

  return {
    async postAnalysis(
      ctx: PrincipalContext,
      input: BugzillaPostAnalysisInput,
    ): Promise<WriteGuardOutcome> {
      const parsed = BugzillaPostAnalysisInputSchema.safeParse(input);
      if (!parsed.success) {
        throw new McpDomainError(
          McpErrorCode.INVALID_PARAMS,
          "Safe-Auto analysis requires isPrivate: true and valid fields",
        );
      }
      const validInput = parsed.data;
      const client = await requireClient(ctx);

      const scope: IdempotencyScope = {
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

      const reservation = await deps.storage.reservePending(scope, intentHash);
      if (reservation !== "reserved") {
        return handleExistingReceipt(ctx, scope, reservation, intentHash, validInput.bugId);
      }

      const budget = await deps.storage.consumeCausalBudget({
        instanceUrl: ctx.instanceUrl,
        bugId: validInput.bugId,
        maxWrites: deps.causalBudgetPerBug,
        windowMs: causalWindowMs,
        nowMs: clock(),
      });
      if (!budget.allowed) {
        await deps.storage.finalizeReceipt(scope, {
          status: "failed",
          intentHash,
          errorCode: "causal_budget_exhausted",
        });
        return {
          outcome: "CausalBudgetExhausted",
          bugId: validInput.bugId,
          retryAfterMs: Math.max(1, budget.retryAfterMs ?? causalWindowMs),
        };
      }

      let caps: Awaited<ReturnType<typeof client.probeCapabilities>>;
      try {
        caps = await client.probeCapabilities();
      } catch (err) {
        // Pre-dispatch failure: release pending receipt so retries are not stranded (WRITE-05)
        await deps.storage.finalizeReceipt(scope, {
          status: "failed",
          intentHash,
          errorCode: "preflight_probe_failed",
        });
        throw err;
      }
      if (!caps.isInsider) {
        const note = await deps.storage.saveInternalNote(
          ctx.principalId,
          ctx.instanceUrl,
          validInput.bugId,
          validInput.analysisMarkdown,
        );
        await deps.storage.finalizeReceipt(scope, {
          status: "applied",
          intentHash,
          artifactId: note.id,
        });
        return {
          outcome: "SavedAsInternalNote",
          noteId: note.id,
          bugId: validInput.bugId,
          reason: "non_insider",
        };
      }

      try {
        const res = await client.postPrivateComment(validInput.bugId, validInput.analysisMarkdown);
        if (res.kind === "private_rejected") {
          const note = await deps.storage.saveInternalNote(
            ctx.principalId,
            ctx.instanceUrl,
            validInput.bugId,
            validInput.analysisMarkdown,
          );
          await deps.storage.finalizeReceipt(scope, {
            status: "applied",
            intentHash,
            artifactId: note.id,
          });
          return {
            outcome: "SavedAsInternalNote",
            noteId: note.id,
            bugId: validInput.bugId,
            reason: "private_rejected",
          };
        }

        const artifactId = `comment:${res.commentId}`;
        await deps.storage.recordSelfWrite({
          instanceUrl: ctx.instanceUrl,
          bugId: validInput.bugId,
          commentId: res.commentId,
        });
        await deps.storage.finalizeReceipt(scope, {
          status: "applied",
          intentHash,
          artifactId,
        });
        return {
          outcome: "Applied",
          artifactId,
          bugId: validInput.bugId,
          auditRecorded: false,
        };
      } catch (err) {
        // Definitive upstream access denial or credential revocation is NOT indeterminate (REST-01)
        if (err instanceof Error && err.name === "BugzillaAccessDeniedError") {
          await deps.storage.finalizeReceipt(scope, {
            status: "failed",
            intentHash,
            errorCode: "resource_inaccessible",
          });
          throw new McpDomainError(
            McpErrorCode.INVALID_PARAMS,
            "Resource not found or inaccessible",
          );
        }
        if (err instanceof Error && err.name === "BugzillaCredentialRevokedError") {
          await deps.storage.finalizeReceipt(scope, {
            status: "failed",
            intentHash,
            errorCode: "credential_revoked",
          });
          throw new McpDomainError(McpErrorCode.SEP_EVENTS_FORBIDDEN, "Credential revoked");
        }
        await deps.storage.finalizeReceipt(scope, {
          status: "indeterminate",
          intentHash,
          recordedAt: nowIso(clock),
        });
        return {
          outcome: "OperationIndeterminate",
          idempotencyKey: validInput.idempotencyKey,
          reconciliationHint: INDETERMINATE_HINT,
        };
      }
    },

    async proposeUpdate(
      ctx: PrincipalContext,
      input: BugzillaProposeUpdateInput,
    ): Promise<WriteGuardOutcome> {
      const client = await requireClient(ctx);
      const scope: IdempotencyScope = {
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
        operation: "bugzilla_propose_update",
        key: input.idempotencyKey,
      };
      const intentHash = sha256Hex(
        canonicalJson({
          bugId: input.bugId,
          expectedLastChangeTime: input.expectedLastChangeTime,
          diff: input.diff,
          rationale: input.rationale,
        }),
      );

      const reservation = await deps.storage.reservePending(scope, intentHash);
      if (reservation !== "reserved") {
        return handleExistingReceipt(ctx, scope, reservation, intentHash, input.bugId);
      }

      const policyGranted = deps.isPolicyGranted ? await deps.isPolicyGranted(ctx, input) : false;
      if (!policyGranted) {
        const proposalId = `prop-${randomUUID()}`;
        const revision = 1;
        const stored: StoredProposal = {
          proposalId,
          revision,
          principalId: ctx.principalId,
          instanceUrl: ctx.instanceUrl,
          bugId: input.bugId,
          baseVersion: input.expectedLastChangeTime,
          diff: input.diff,
          rationale: input.rationale,
          state: "pending",
        };
        await deps.storage.saveProposal(stored);
        await deps.storage.finalizeReceipt(scope, {
          status: "applied",
          intentHash,
          artifactId: `${proposalId}:${revision}`,
        });
        return {
          outcome: "ProposalPending",
          proposalId,
          revision,
        };
      }

      const dossier = await client.getBugDossierData(input.bugId, {
        maxComments: 0,
        maxHistory: 0,
      });
      if (!dossier) {
        await deps.storage.finalizeReceipt(scope, {
          status: "failed",
          intentHash,
          errorCode: "not_found",
        });
        throw new McpDomainError(McpErrorCode.INVALID_PARAMS, "Bug not found or inaccessible");
      }
      if (dossier.bug.lastChangeTime !== input.expectedLastChangeTime) {
        await deps.storage.finalizeReceipt(scope, {
          status: "failed",
          intentHash,
          errorCode: "stale_bug_conflict",
        });
        return {
          outcome: "StaleBugConflict",
          expectedLastChangeTime: input.expectedLastChangeTime,
          actualLastChangeTime: dossier.bug.lastChangeTime,
          latestAuthorizedSnapshot: dossier.bug,
        };
      }

      try {
        const updated = await client.applyBugUpdate(input.bugId, input.diff);
        const artifactId = `update:${input.bugId}:${updated.updatedLastChangeTime}`;
        await deps.storage.recordWriteAudit({
          auditId: randomUUID(),
          principalId: ctx.principalId,
          instanceUrl: ctx.instanceUrl,
          bugId: input.bugId,
          expectedLastChangeTime: input.expectedLastChangeTime,
          updatedLastChangeTime: updated.updatedLastChangeTime,
          diff: input.diff,
          recordedAt: nowIso(clock),
        });
        await deps.storage.recordSelfWrite({
          instanceUrl: ctx.instanceUrl,
          bugId: input.bugId,
          ...(updated.commentId !== undefined ? { commentId: updated.commentId } : {}),
          diffKey: sha256Hex(canonicalJson(input.diff)),
        });
        await deps.storage.finalizeReceipt(scope, {
          status: "applied",
          intentHash,
          artifactId,
        });
        return {
          outcome: "Applied",
          artifactId,
          bugId: input.bugId,
          auditRecorded: true,
        };
      } catch {
        await deps.storage.finalizeReceipt(scope, {
          status: "indeterminate",
          intentHash,
          recordedAt: nowIso(clock),
        });
        return {
          outcome: "OperationIndeterminate",
          idempotencyKey: input.idempotencyKey,
          reconciliationHint: INDETERMINATE_HINT,
        };
      }
    },

    async createBug(
      ctx: PrincipalContext,
      input: BugzillaCreateBugInput,
    ): Promise<WriteGuardOutcome> {
      const client = await requireClient(ctx);
      const { idempotencyKey, ...payload } = input;
      const scope: IdempotencyScope = {
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
        operation: "bugzilla_create_bug",
        key: idempotencyKey,
      };
      const intentHash = sha256Hex(canonicalJson(payload));

      const reservation = await deps.storage.reservePending(scope, intentHash);
      if (reservation !== "reserved") {
        return handleExistingReceipt(ctx, scope, reservation, intentHash);
      }

      try {
        const created = await client.createBug(payload);
        const artifactId = `bug:${created.bugId}`;
        await deps.storage.recordSelfWrite({
          instanceUrl: ctx.instanceUrl,
          bugId: created.bugId,
          diffKey: `create:${created.bugId}`,
        });
        await deps.storage.finalizeReceipt(scope, {
          status: "applied",
          intentHash,
          artifactId,
        });
        return {
          outcome: "Applied",
          artifactId,
          bugId: created.bugId,
          auditRecorded: false,
        };
      } catch {
        await deps.storage.finalizeReceipt(scope, {
          status: "indeterminate",
          intentHash,
          recordedAt: nowIso(clock),
        });
        return {
          outcome: "OperationIndeterminate",
          idempotencyKey,
          reconciliationHint: INDETERMINATE_HINT,
        };
      }
    },

    async resolveProposal(
      ctx: PrincipalContext,
      input: AppResolveProposalInput,
    ): Promise<WriteGuardOutcome> {
      const client = await requireClient(ctx);
      const scope: IdempotencyScope = {
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
        operation: "app_resolve_proposal",
        key: input.idempotencyKey,
      };
      const intentHash = sha256Hex(
        canonicalJson({
          proposalId: input.proposalId,
          revision: input.revision,
          decision: input.decision,
        }),
      );

      const reservation = await deps.storage.reservePending(scope, intentHash);
      if (reservation !== "reserved") {
        return handleExistingReceipt(ctx, scope, reservation, intentHash);
      }

      // Synchronous atomic proposal claim prevents concurrent approve/reject races across keys (WRITE-01)
      const claimKey = `${ctx.issuer}|${ctx.principalId}|${ctx.instanceUrl}|${input.proposalId}|${input.revision}`;
      if (claimingProposals.has(claimKey)) {
        await deps.storage.finalizeReceipt(scope, {
          status: "failed",
          intentHash,
          errorCode: "proposal_claim_in_flight",
        });
        throw new McpDomainError(
          McpErrorCode.INVALID_PARAMS,
          "Proposal resolution already in flight",
        );
      }
      claimingProposals.add(claimKey);

      try {
        const proposal = await deps.storage.getProposal(
          ctx.principalId,
          ctx.instanceUrl,
          input.proposalId,
          input.revision,
        );
        if (!proposal || proposal.state !== "pending") {
          await deps.storage.finalizeReceipt(scope, {
            status: "failed",
            intentHash,
            errorCode: "proposal_not_pending",
          });
          throw new McpDomainError(
            McpErrorCode.INVALID_PARAMS,
            "Proposal not found or already resolved",
          );
        }

        if (input.decision === "reject") {
          if (deps.storage.claimProposalTransition) {
            const won = await deps.storage.claimProposalTransition({
              principalId: ctx.principalId,
              instanceUrl: ctx.instanceUrl,
              proposalId: proposal.proposalId,
              revision: proposal.revision,
              fromState: "pending",
              toState: "rejected",
            });
            if (!won) {
              await deps.storage.finalizeReceipt(scope, {
                status: "failed",
                intentHash,
                errorCode: "proposal_not_pending",
              });
              throw new McpDomainError(
                McpErrorCode.INVALID_PARAMS,
                "Proposal not found or already resolved",
              );
            }
          } else {
            await deps.storage.saveProposal({ ...proposal, state: "rejected" });
          }
          const artifactId = `rejected:${proposal.proposalId}:${proposal.revision}`;
          await deps.storage.finalizeReceipt(scope, {
            status: "applied",
            intentHash,
            artifactId,
          });
          return {
            outcome: "Applied",
            artifactId,
            bugId: proposal.bugId,
            auditRecorded: false,
          };
        }

        // Decision is "approve": exhaustively verify approval proof by deployment mode (WRITE-02)
        if (!input.approval) {
          await deps.storage.finalizeReceipt(scope, {
            status: "failed",
            intentHash,
            errorCode: "missing_approval",
          });
          throw new McpDomainError(
            McpErrorCode.SEP_EVENTS_FORBIDDEN,
            "Guarded proposal approval requires a valid approval proof",
          );
        }

        switch (input.approval.kind) {
          case "cloud_signed_token": {
            if (!deps.cloudApprovalService) {
              await deps.storage.finalizeReceipt(scope, {
                status: "failed",
                intentHash,
                errorCode: "approval_service_unavailable",
              });
              throw new McpDomainError(
                McpErrorCode.INTERNAL_ERROR,
                "Cloud approval verification service is not configured",
              );
            }
            const verification = await deps.cloudApprovalService.verifyAndConsume(
              input.approval.token,
              {
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
            );
            if (!verification.valid) {
              await deps.storage.finalizeReceipt(scope, {
                status: "failed",
                intentHash,
                errorCode: verification.reason,
              });
              throw new McpDomainError(
                McpErrorCode.SEP_EVENTS_FORBIDDEN,
                `Approval verification failed: ${verification.reason}`,
              );
            }
            break;
          }
          case "local_ide_host_confirmed": {
            if (ctx.deploymentMode !== "local-trusted-ide") {
              await deps.storage.finalizeReceipt(scope, {
                status: "failed",
                intentHash,
                errorCode: "local_proof_forbidden_in_cloud",
              });
              throw new McpDomainError(
                McpErrorCode.SEP_EVENTS_FORBIDDEN,
                "Cloud guarded execution requires a server-verified signed approval token",
              );
            }
            break;
          }
          case "policy_grant": {
            const granted = deps.isPolicyGranted
              ? await deps.isPolicyGranted(ctx, {
                  bugId: proposal.bugId,
                  idempotencyKey: input.idempotencyKey,
                  expectedLastChangeTime: proposal.baseVersion,
                  diff: proposal.diff,
                  rationale: proposal.rationale,
                })
              : false;
            if (!granted) {
              await deps.storage.finalizeReceipt(scope, {
                status: "failed",
                intentHash,
                errorCode: "policy_not_granted",
              });
              throw new McpDomainError(
                McpErrorCode.SEP_EVENTS_FORBIDDEN,
                "Policy grant denied by server policy",
              );
            }
            break;
          }
        }

        // Atomically claim pending -> approved across workers before upstream dispatch (AUTH-10)
        if (deps.storage.claimProposalTransition) {
          const won = await deps.storage.claimProposalTransition({
            principalId: ctx.principalId,
            instanceUrl: ctx.instanceUrl,
            proposalId: proposal.proposalId,
            revision: proposal.revision,
            fromState: "pending",
            toState: "approved",
          });
          if (!won) {
            await deps.storage.finalizeReceipt(scope, {
              status: "failed",
              intentHash,
              errorCode: "proposal_not_pending",
            });
            throw new McpDomainError(
              McpErrorCode.INVALID_PARAMS,
              "Proposal not found or already resolved",
            );
          }
        } else {
          await deps.storage.saveProposal({ ...proposal, state: "approved" });
        }

        const dossier = await client.getBugDossierData(proposal.bugId, {
          maxComments: 0,
          maxHistory: 0,
        });
        if (!dossier) {
          await deps.storage.saveProposal({ ...proposal, state: "pending" });
          await deps.storage.finalizeReceipt(scope, {
            status: "failed",
            intentHash,
            errorCode: "bug_inaccessible",
          });
          throw new McpDomainError(McpErrorCode.INVALID_PARAMS, "Bug inaccessible");
        }
        if (dossier.bug.lastChangeTime !== proposal.baseVersion) {
          await deps.storage.saveProposal({ ...proposal, state: "stale" });
          await deps.storage.finalizeReceipt(scope, {
            status: "failed",
            intentHash,
            errorCode: "stale_bug_conflict",
          });
          return {
            outcome: "StaleBugConflict",
            expectedLastChangeTime: proposal.baseVersion,
            actualLastChangeTime: dossier.bug.lastChangeTime,
            latestAuthorizedSnapshot: dossier.bug,
          };
        }

        try {
          const updated = await client.applyBugUpdate(proposal.bugId, proposal.diff);
          const artifactId = `update:${proposal.bugId}:${updated.updatedLastChangeTime}`;
          await deps.storage.saveProposal({ ...proposal, state: "applied" });
          await deps.storage.recordWriteAudit({
            auditId: randomUUID(),
            principalId: ctx.principalId,
            instanceUrl: ctx.instanceUrl,
            bugId: proposal.bugId,
            proposalId: proposal.proposalId,
            revision: proposal.revision,
            expectedLastChangeTime: proposal.baseVersion,
            updatedLastChangeTime: updated.updatedLastChangeTime,
            diff: proposal.diff,
            recordedAt: nowIso(clock),
          });
          await deps.storage.recordSelfWrite({
            instanceUrl: ctx.instanceUrl,
            bugId: proposal.bugId,
            ...(updated.commentId !== undefined ? { commentId: updated.commentId } : {}),
            diffKey: sha256Hex(canonicalJson(proposal.diff)),
          });
          await deps.storage.finalizeReceipt(scope, {
            status: "applied",
            intentHash,
            artifactId,
          });
          return {
            outcome: "Applied",
            artifactId,
            bugId: proposal.bugId,
            auditRecorded: true,
          };
        } catch {
          await deps.storage.saveProposal({ ...proposal, state: "indeterminate" });
          await deps.storage.finalizeReceipt(scope, {
            status: "indeterminate",
            intentHash,
            recordedAt: nowIso(clock),
          });
          return {
            outcome: "OperationIndeterminate",
            idempotencyKey: input.idempotencyKey,
            reconciliationHint: INDETERMINATE_HINT,
          };
        }
      } finally {
        claimingProposals.delete(claimKey);
      }
    },

    async saveDraft(ctx: PrincipalContext, input: AppSaveDraftInput) {
      return deps.storage.saveDraft({
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
        bugId: input.bugId,
        draftKind: input.draftKind,
        draftRevision: input.draftRevision,
        content: input.content,
      });
    },

    async getDraft(ctx: PrincipalContext, params) {
      return deps.storage.getDraft({
        principalId: ctx.principalId,
        instanceUrl: ctx.instanceUrl,
        bugId: params.bugId,
        draftKind: params.draftKind,
      });
    },
  };
}
