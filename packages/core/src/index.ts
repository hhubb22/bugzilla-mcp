import type { BugzillaClient } from "@bugzilla-mcp/bugzilla-client";
import type {
  AppResolveProposalInput,
  AppSaveDraftInput,
  BugzillaPostAnalysisInput,
  BugzillaProposeUpdateInput,
  DraftSaveResult,
  EventsProfile,
  PollEventsParams,
  PollEventsResult,
  PrincipalContext,
  WebhookSubscribeParams,
  WebhookSubscribeResult,
  WriteGuardOutcome,
} from "@bugzilla-mcp/contracts";
import type { StoragePorts } from "@bugzilla-mcp/storage";

export interface CoreDependencies {
  readonly storage: StoragePorts;
  readonly resolveClient: (ctx: PrincipalContext) => Promise<BugzillaClient | null>;
  readonly eventsProfile: EventsProfile;
  readonly causalBudgetPerBug: number;
  readonly lagWindowMs: number;
}

export interface WriteGuardService {
  postAnalysis(ctx: PrincipalContext, input: BugzillaPostAnalysisInput): Promise<WriteGuardOutcome>;
  proposeUpdate(ctx: PrincipalContext, input: BugzillaProposeUpdateInput): Promise<WriteGuardOutcome>;
  resolveProposal(ctx: PrincipalContext, input: AppResolveProposalInput): Promise<WriteGuardOutcome>;
  saveDraft(ctx: PrincipalContext, input: AppSaveDraftInput): Promise<DraftSaveResult>;
}

export interface SyntheticEventsService {
  poll(ctx: PrincipalContext, params: PollEventsParams): Promise<PollEventsResult>;
  subscribeWebhook(ctx: PrincipalContext, params: WebhookSubscribeParams): Promise<WebhookSubscribeResult>;
  unsubscribeWebhook(
    ctx: PrincipalContext,
    params: { name: string; arguments: Record<string, unknown>; delivery: { url: string; mode?: "webhook" } },
  ): Promise<{ resultType: "complete" }>;
}

export function createWriteGuardService(_deps: CoreDependencies): WriteGuardService {
  throw new Error("C0_CONTRACT_STUB");
}

export function createSyntheticEventsService(_deps: CoreDependencies): SyntheticEventsService {
  throw new Error("C0_CONTRACT_STUB");
}
