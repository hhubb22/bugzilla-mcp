import { Cause, Context, Duration, Effect, Layer, Schedule, Scope, Semaphore } from "effect";

export interface WebhookLoopParams {
  readonly intervalMs: number;
  readonly tick: () => Effect.Effect<void, unknown>;
  readonly onError?: (err: unknown) => void;
}

/**
 * Narrow, reversible scheduler seam isolating webhook loop execution & per-subscription
 * single-flight serialization (`[R-836a57]`) from domain invariants in `events.ts`.
 */
export interface WebhookSchedulerService {
  /** Execute `effect` strictly serialized per key using a 1-permit Semaphore. */
  serialize<A, E, R>(key: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  /** Notify the scheduler that a subscription is ready for sweep (no-op in default SQLite loop). */
  scheduleSweep(subscriptionId: string, delayMs?: number): Effect.Effect<void>;
  /** Release per-subscription scheduler state on unsubscribe or termination. */
  cancelSubscription(subscriptionId: string): Effect.Effect<void>;
  /** Fork a scoped periodic delivery loop that cleanly stops when `Scope` closes. */
  startLoop(params: WebhookLoopParams): Effect.Effect<void, never, Scope.Scope>;
}

export class WebhookSchedulerPort extends Context.Service<
  WebhookSchedulerPort,
  WebhookSchedulerService
>()("@bugzilla-mcp/core/WebhookSchedulerPort") {}

const MAX_SEMAPHORE_ENTRIES = 4_096;

export function createSqliteWebhookScheduler(): WebhookSchedulerService {
  const semaphores = new Map<string, Semaphore.Semaphore>();
  const activeCounts = new Map<string, number>();

  function getOrCreateSemaphore(key: string): Semaphore.Semaphore {
    let sem = semaphores.get(key);
    if (sem) {
      return sem;
    }
    if (semaphores.size >= MAX_SEMAPHORE_ENTRIES) {
      for (const [candidateKey] of semaphores) {
        if ((activeCounts.get(candidateKey) ?? 0) === 0) {
          semaphores.delete(candidateKey);
          activeCounts.delete(candidateKey);
          if (semaphores.size < MAX_SEMAPHORE_ENTRIES) break;
        }
      }
    }
    sem = Semaphore.makeUnsafe(1);
    semaphores.set(key, sem);
    return sem;
  }

  return WebhookSchedulerPort.of({
    serialize: <A, E, R>(key: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.suspend(() => {
        const sem = getOrCreateSemaphore(key);
        activeCounts.set(key, (activeCounts.get(key) ?? 0) + 1);
        return sem.withPermit(effect).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              const remaining = (activeCounts.get(key) ?? 1) - 1;
              if (remaining <= 0) {
                activeCounts.delete(key);
              } else {
                activeCounts.set(key, remaining);
              }
            }),
          ),
        );
      }),

    scheduleSweep: (_subscriptionId: string, _delayMs?: number) => Effect.void,

    cancelSubscription: (subscriptionId: string) =>
      Effect.sync(() => {
        if ((activeCounts.get(subscriptionId) ?? 0) === 0) {
          semaphores.delete(subscriptionId);
          activeCounts.delete(subscriptionId);
        }
      }),

    startLoop: (params: WebhookLoopParams) =>
      Effect.gen(function* () {
        const spacing = Duration.millis(Math.max(1, params.intervalMs));
        const runOneTick = Effect.suspend(() => params.tick()).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.failCause(cause);
            }
            return Effect.sync(() => {
              params.onError?.(Cause.squash(cause));
            });
          }),
        );
        const loop = Effect.sleep(spacing).pipe(
          Effect.andThen(runOneTick),
          Effect.repeat(Schedule.spaced(spacing)),
          Effect.asVoid,
        );
        yield* Effect.forkScoped(loop);
      }),
  });
}

export const sqliteWebhookSchedulerLayer: Layer.Layer<WebhookSchedulerPort> = Layer.sync(
  WebhookSchedulerPort,
  createSqliteWebhookScheduler,
);
