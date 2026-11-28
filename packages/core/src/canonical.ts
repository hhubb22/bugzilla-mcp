import { createHash } from "node:crypto";
import {
  toEffectBugzillaClient,
  type BugzillaClient,
  type BugzillaClientEffect,
} from "@bugzilla-mcp/bugzilla-client";
import {
  domainErrorToToolPayload,
  isDomainError,
  McpErrorCode,
  type DomainError,
} from "@bugzilla-mcp/contracts";
import { Cause, Effect, Exit } from "effect";

export type AnyBugzillaClient = BugzillaClient | BugzillaClientEffect;

/**
 * Adapts either a Promise `BugzillaClient` or an Effect-native `BugzillaClientEffect`
 * into a `BugzillaClientEffect` without eagerly invoking any method.
 */
export function asEffectBugzillaClient(client: AnyBugzillaClient): BugzillaClientEffect {
  const promiseAdapted = toEffectBugzillaClient(client as BugzillaClient);
  const adapt = <A, E>(
    invokeRaw: () => unknown,
    fallback: () => Effect.Effect<A, E>,
  ): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      const out = invokeRaw();
      if (Effect.isEffect(out)) {
        return out as Effect.Effect<A, E>;
      }
      if (out instanceof Promise) {
        // Avoid calling the raw method a second time if it already returned a Promise.
        return Effect.tryPromise({
          try: () => out as Promise<A>,
          catch: (err) => err as E,
        });
      }
      return fallback();
    });

  // Note: for Promise clients, we want toEffectBugzillaClient's exact error mapping
  // (BugzillaClientError) without double-invoking side-effecting calls.
  // Detect cleanly: if a method on `client` is wrapped by `toEffectBugzillaClient`,
  // we can check once on a read or distinguish via `Effect.isEffect` on non-mutating
  // methods, OR better: wrap `client` so that if `invokeRaw()` returns a Promise we
  // feed that exact Promise into `toEffectBugzillaClient`!
  const wrapMethod = <K extends keyof BugzillaClientEffect>(
    key: K,
    ...args: Parameters<BugzillaClientEffect[K]>
  ): ReturnType<BugzillaClientEffect[K]> =>
    Effect.suspend(() => {
      const rawFn = (
        client as unknown as Record<string, ((...a: unknown[]) => unknown) | undefined>
      )[key];
      if (typeof rawFn !== "function") {
        return (promiseAdapted[key] as (...a: unknown[]) => Effect.Effect<unknown, unknown>)(
          ...args,
        );
      }
      let returned: unknown;
      try {
        returned = rawFn.apply(client, args);
      } catch (syncErr) {
        const single = toEffectBugzillaClient({
          ...(client as BugzillaClient),
          [key]: () => Promise.reject(syncErr),
        });
        return (single[key] as (...a: unknown[]) => Effect.Effect<unknown, unknown>)(...args);
      }
      if (Effect.isEffect(returned)) {
        return returned;
      }
      const resolvedPromise = Promise.resolve(returned);
      const single = toEffectBugzillaClient({
        ...(client as BugzillaClient),
        [key]: () => resolvedPromise,
      });
      return (single[key] as (...a: unknown[]) => Effect.Effect<unknown, unknown>)(...args);
    }) as ReturnType<BugzillaClientEffect[K]>;

  void adapt;

  return {
    probeCapabilities: () => wrapMethod("probeCapabilities"),
    searchBugs: (params) => wrapMethod("searchBugs", params),
    getBugDossierData: (bugId, opts) => wrapMethod("getBugDossierData", bugId, opts),
    listAttachments: (bugId) => wrapMethod("listAttachments", bugId),
    getAttachmentExcerpt: (params) => wrapMethod("getAttachmentExcerpt", params),
    postPrivateComment: (bugId, text) => wrapMethod("postPrivateComment", bugId, text),
    postPublicComment: (bugId, text) => wrapMethod("postPublicComment", bugId, text),
    applyBugUpdate: (bugId, diff) => wrapMethod("applyBugUpdate", bugId, diff),
    createBug: (input) => wrapMethod("createBug", input),
    listChangesSince: (params) => wrapMethod("listChangesSince", params),
    checkVisibility: (bugId, commentId) => wrapMethod("checkVisibility", bugId, commentId),
    listEnterableProducts: () => wrapMethod("listEnterableProducts"),
    getProductMetadata: (productName) => wrapMethod("getProductMetadata", productName),
    getBugFields: () => wrapMethod("getBugFields"),
  };
}

export function clientSupportsPostPublicComment(client: AnyBugzillaClient): boolean {
  return (
    typeof (client as { readonly postPublicComment?: unknown }).postPublicComment === "function"
  );
}

export class McpDomainError extends Error {
  readonly code: number;
  readonly data?: unknown;
  readonly domainError?: DomainError | undefined;

  constructor(code: number, message: string, data?: unknown, domainError?: DomainError) {
    super(message);
    this.name = "McpDomainError";
    this.code = code;
    this.data = data;
    this.domainError = domainError;
  }

  static fromDomainError(error: DomainError): McpDomainError {
    return new McpDomainError(error.rpcCode, error.message, domainErrorToToolPayload(error), error);
  }
}

export function domainErrorToMcpDomainError(error: DomainError): McpDomainError {
  return McpDomainError.fromDomainError(error);
}

export function toMcpDomainError(error: unknown): McpDomainError {
  if (error instanceof McpDomainError) {
    return error;
  }
  if (isDomainError(error)) {
    return McpDomainError.fromDomainError(error);
  }
  return new McpDomainError(
    McpErrorCode.INTERNAL_ERROR,
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * Executes a self-contained Effect and converts typed failures into thrown errors
 * without FiberFailure wrapping (via `Cause.squash`), keeping Promise facades ergonomic.
 */
export async function runCoreEffect<A, E>(effect: Effect.Effect<A, E>): Promise<A> {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  throw Cause.squash(exit.cause);
}

export function canonicalJson(value: unknown): string {
  if (value === undefined || value === null) {
    return "null";
  }
  if (typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => (item === undefined ? "null" : canonicalJson(item))).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function normalizeArgsForCanonical<T extends Record<string, unknown>>(
  args: T | undefined,
): Record<string, unknown> {
  const definedArgs: Record<string, unknown> = {};
  if (args) {
    for (const [key, value] of Object.entries(args)) {
      if (value !== undefined) {
        definedArgs[key] = value;
      }
    }
  }
  return { includeSelf: false, ...definedArgs };
}
