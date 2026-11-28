import { Cause, Effect, Exit } from "effect";
import {
  BugzillaAccessDeniedError,
  type BugzillaClientError,
  BugzillaCredentialRevokedError,
  BugzillaRateLimitError,
  BugzillaTransientError,
  BugzillaUnsupportedAttachmentError,
  BugzillaValidationError,
  isBugzillaClientError,
  redactErrorMessage,
} from "./errors.js";
import { createRestBugzillaClientEffect } from "./rest-client.js";
import type {
  BugzillaClient,
  BugzillaClientConfig,
  BugzillaClientEffect,
  BugzillaInstanceCapabilities,
} from "./types.js";

export {
  classifyResponse,
  classifyResponseOutcome,
  createRestBugzillaClientEffect,
  extractMissingFields,
  isPrivateCommentRejection,
  parseRetryAfterMs,
  type BugzillaHttpMethod,
  type RawHttpResponse,
} from "./rest-client.js";
export {
  BugzillaAccessDeniedError,
  BugzillaCredentialRevokedError,
  BugzillaRateLimitError,
  BugzillaTransientError,
  BugzillaUnsupportedAttachmentError,
  BugzillaValidationError,
  isBugzillaClientError,
  redactErrorMessage,
  type BugzillaClientError,
} from "./errors.js";
export { normalizeBugzillaFieldName } from "./field-codec.js";
export { confirmedHistoryKey, type ConfirmedFieldChange } from "./history.js";
export type {
  ApplyBugUpdateResult,
  AttachmentExcerptResult,
  BugzillaAuthMode,
  BugzillaClient,
  BugzillaClientConfig,
  BugzillaClientEffect,
  BugzillaInstanceCapabilities,
  BugzillaSearchParams,
  BugzillaSearchResult,
  EnterableProductSummary,
  ListChangesSinceResult,
  PostPrivateCommentResult,
  PostPublicCommentResult,
  PromiseBugzillaCapabilities,
  UpstreamBugzillaOccurrence,
  VisibilityStatus,
} from "./types.js";

async function runEffectToPromise<A>(effect: Effect.Effect<A, BugzillaClientError>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
}

function mapUnknownToBugzillaError(err: unknown, isWrite: boolean): BugzillaClientError {
  if (isBugzillaClientError(err)) {
    return err;
  }
  if (err instanceof Error) {
    const redacted = redactErrorMessage(err.message);
    switch (err.name) {
      case "BugzillaCredentialRevokedError":
        return new BugzillaCredentialRevokedError({ bzMessage: redacted });
      case "BugzillaAccessDeniedError":
        return new BugzillaAccessDeniedError({ bzMessage: redacted });
      case "BugzillaUnsupportedAttachmentError":
        return new BugzillaUnsupportedAttachmentError({ message: redacted });
      case "BugzillaValidationError":
        return new BugzillaValidationError({ httpStatus: 400, bzMessage: redacted });
      case "BugzillaRateLimitError":
        return new BugzillaRateLimitError({ bzMessage: redacted });
      case "BugzillaTransientError":
        return new BugzillaTransientError({
          effectCertainty: isWrite ? "uncertain" : "none",
          message: redacted,
        });
      default:
        return new BugzillaTransientError({
          effectCertainty: isWrite ? "uncertain" : "none",
          message: redacted,
        });
    }
  }
  return new BugzillaTransientError({
    effectCertainty: isWrite ? "uncertain" : "none",
    message: redactErrorMessage(String(err)),
  });
}

function liftPromise<A>(
  thunk: () => Promise<A>,
  isWrite: boolean,
): Effect.Effect<A, BugzillaClientError> {
  const eff = Effect.tryPromise({
    try: () => thunk(),
    catch: (err) => mapUnknownToBugzillaError(err, isWrite),
  });
  return isWrite ? Effect.uninterruptible(eff) : eff;
}

/**
 * Adapts an Effect-native `BugzillaClientEffect` into a Promise-based `BugzillaClient`.
 * Preserves the exact typed `BugzillaClientError` instance on rejection (via `Cause.squash`).
 */
export function toPromiseBugzillaClient(
  effectClient: BugzillaClientEffect,
): Required<BugzillaClient> {
  return {
    probeCapabilities: () => runEffectToPromise(effectClient.probeCapabilities()),
    searchBugs: (params) => runEffectToPromise(effectClient.searchBugs(params)),
    getBugDossierData: (bugId, opts) =>
      runEffectToPromise(effectClient.getBugDossierData(bugId, opts)),
    listAttachments: (bugId) => runEffectToPromise(effectClient.listAttachments(bugId)),
    getAttachmentExcerpt: (params) => runEffectToPromise(effectClient.getAttachmentExcerpt(params)),
    postPrivateComment: (bugId, text) =>
      runEffectToPromise(effectClient.postPrivateComment(bugId, text)),
    postPublicComment: (bugId, text) =>
      runEffectToPromise(effectClient.postPublicComment(bugId, text)),
    applyBugUpdate: (bugId, diff) => runEffectToPromise(effectClient.applyBugUpdate(bugId, diff)),
    createBug: (input) => runEffectToPromise(effectClient.createBug(input)),
    listChangesSince: (params) => runEffectToPromise(effectClient.listChangesSince(params)),
    checkVisibility: (bugId, commentId) =>
      runEffectToPromise(effectClient.checkVisibility(bugId, commentId)),
    listEnterableProducts: () => runEffectToPromise(effectClient.listEnterableProducts()),
    getProductMetadata: (productName) =>
      runEffectToPromise(effectClient.getProductMetadata(productName)),
    getBugFields: () => runEffectToPromise(effectClient.getBugFields()),
  };
}

/**
 * Adapts a Promise-based `BugzillaClient` (such as test fakes) into an Effect-native
 * `BugzillaClientEffect` with typed `BugzillaClientError` failure channel.
 */
export function toEffectBugzillaClient(client: BugzillaClient): BugzillaClientEffect {
  return {
    probeCapabilities: () =>
      liftPromise(async (): Promise<BugzillaInstanceCapabilities> => {
        const caps = await client.probeCapabilities();
        return {
          version: caps.version,
          supportsHeaderAuth: caps.supportsHeaderAuth,
          authMode: caps.authMode ?? (caps.supportsHeaderAuth ? "header" : "query_fallback"),
          authenticatedUser: caps.authenticatedUser,
          isInsider: caps.isInsider,
        };
      }, false),
    searchBugs: (params) => liftPromise(() => client.searchBugs(params), false),
    getBugDossierData: (bugId, opts) =>
      liftPromise(() => client.getBugDossierData(bugId, opts), false),
    listAttachments: (bugId) => liftPromise(() => client.listAttachments(bugId), false),
    getAttachmentExcerpt: (params) =>
      client.getAttachmentExcerpt
        ? liftPromise(() => client.getAttachmentExcerpt!(params), false)
        : Effect.succeed(null),
    postPrivateComment: (bugId, text) =>
      liftPromise(() => client.postPrivateComment(bugId, text), true),
    postPublicComment: (bugId, text) =>
      client.postPublicComment
        ? liftPromise(() => client.postPublicComment!(bugId, text), true)
        : Effect.fail(
            new BugzillaTransientError({
              effectCertainty: "none",
              message: "BugzillaClient.postPublicComment is not implemented",
            }),
          ),
    applyBugUpdate: (bugId, diff) => liftPromise(() => client.applyBugUpdate(bugId, diff), true),
    createBug: (input) => liftPromise(() => client.createBug(input), true),
    listChangesSince: (params) => liftPromise(() => client.listChangesSince(params), false),
    checkVisibility: (bugId, commentId) =>
      liftPromise(() => client.checkVisibility(bugId, commentId), false),
    listEnterableProducts: () =>
      client.listEnterableProducts
        ? liftPromise(() => client.listEnterableProducts!(), false)
        : Effect.succeed([]),
    getProductMetadata: (productName) =>
      client.getProductMetadata
        ? liftPromise(() => client.getProductMetadata!(productName), false)
        : Effect.succeed(null),
    getBugFields: () =>
      client.getBugFields ? liftPromise(() => client.getBugFields!(), false) : Effect.succeed([]),
  };
}

export function createRestBugzillaClient(config: BugzillaClientConfig): Required<BugzillaClient> {
  return toPromiseBugzillaClient(createRestBugzillaClientEffect(config));
}

export function createBugzillaClient(config: BugzillaClientConfig): Required<BugzillaClient> {
  return createRestBugzillaClient(config);
}
