import { Effect, type JsonSchema, Result, Schema } from "effect";
import { BugIdSchema, IsoTimestampSchema, NonEmptyTrimmedStringSchema } from "./domain.js";
import { formatSchemaIssues, STRICT_PARSE_OPTIONS } from "./errors.js";
import { HttpsUrlSchema, type SchemaValidationIssue } from "./mcp-wire.js";

export const EventsProfileSchema = Schema.Literals(["sep-3415", "chatgpt-events"]);
export type EventsProfile = typeof EventsProfileSchema.Type;

export const EventNameSchema = Schema.Literals([
  "bugzilla.bug.created",
  "bugzilla.bug.updated",
  "bugzilla.bug.commented",
  "bugzilla.flag.needinfo",
]);
export type EventName = typeof EventNameSchema.Type;

export const DeliveryModeSchema = Schema.Literals(["poll", "push", "webhook"]);
export type DeliveryMode = typeof DeliveryModeSchema.Type;

export const WATCHED_FIELDS = ["status", "assigned_to", "priority", "flags"] as const;
export const WatchedFieldSchema = Schema.Literals(WATCHED_FIELDS);
export type WatchedField = typeof WatchedFieldSchema.Type;

const IncludeSelfField = Schema.Boolean.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(false)),
  Schema.annotateEncoded({ default: false }),
);

export const BugCreatedFilterArgsSchema = Schema.Struct({
  product: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  component: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  severity: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  includeSelf: IncludeSelfField,
});
export type BugCreatedFilterArgs = typeof BugCreatedFilterArgsSchema.Type;

export const BugUpdatedFilterArgsSchema = Schema.Struct({
  product: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  bugIds: Schema.optionalKey(Schema.Array(BugIdSchema).check(Schema.isMaxLength(100))),
  watchedFields: Schema.optionalKey(Schema.Array(WatchedFieldSchema)),
  includeSelf: IncludeSelfField,
});
export type BugUpdatedFilterArgs = typeof BugUpdatedFilterArgsSchema.Type;

export const BugCommentedFilterArgsSchema = Schema.Struct({
  product: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  bugIds: Schema.optionalKey(Schema.Array(BugIdSchema).check(Schema.isMaxLength(100))),
  mentionMe: Schema.optionalKey(Schema.Boolean),
  includeSelf: IncludeSelfField,
});
export type BugCommentedFilterArgs = typeof BugCommentedFilterArgsSchema.Type;

export const FlagNeedinfoFilterArgsSchema = Schema.Struct({
  product: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  requestee: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  includeSelf: IncludeSelfField,
});
export type FlagNeedinfoFilterArgs = typeof FlagNeedinfoFilterArgsSchema.Type;

/** Superset filter type used across storage and internal event matching. */
export const EventFilterArgsSchema = Schema.Struct({
  product: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  component: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  bugIds: Schema.optionalKey(Schema.Array(BugIdSchema).check(Schema.isMaxLength(100))),
  severity: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  watchedFields: Schema.optionalKey(Schema.Array(WatchedFieldSchema)),
  mentionMe: Schema.optionalKey(Schema.Boolean),
  requestee: Schema.optionalKey(NonEmptyTrimmedStringSchema),
  includeSelf: IncludeSelfField,
});
export type EventFilterArgs = typeof EventFilterArgsSchema.Type;

export const EVENT_FILTER_SCHEMAS = {
  "bugzilla.bug.created": BugCreatedFilterArgsSchema,
  "bugzilla.bug.updated": BugUpdatedFilterArgsSchema,
  "bugzilla.bug.commented": BugCommentedFilterArgsSchema,
  "bugzilla.flag.needinfo": FlagNeedinfoFilterArgsSchema,
} as const;

export type EventFilterByName = {
  readonly "bugzilla.bug.created": BugCreatedFilterArgs;
  readonly "bugzilla.bug.updated": BugUpdatedFilterArgs;
  readonly "bugzilla.bug.commented": BugCommentedFilterArgs;
  readonly "bugzilla.flag.needinfo": FlagNeedinfoFilterArgs;
};

export type ParseEventFiltersResult<N extends EventName> =
  | { readonly success: true; readonly data: EventFilterByName[N] }
  | {
      readonly success: false;
      readonly error: Schema.SchemaError;
      readonly issues: readonly SchemaValidationIssue[];
    };

export function parseEventFilters<N extends EventName>(
  name: N,
  input: unknown,
): ParseEventFiltersResult<N> {
  const schema = EVENT_FILTER_SCHEMAS[name];
  const decoded = Schema.decodeUnknownResult(
    schema,
    STRICT_PARSE_OPTIONS,
  )(input === undefined ? {} : input);
  if (Result.isFailure(decoded)) {
    return {
      success: false,
      error: decoded.failure,
      issues: formatSchemaIssues(decoded.failure),
    };
  }
  return {
    success: true,
    data: decoded.success as EventFilterByName[N],
  };
}

export function eventFilterJsonSchema(name: EventName): JsonSchema.JsonSchema {
  const doc = Schema.toJsonSchemaDocument(EVENT_FILTER_SCHEMAS[name], {
    onExcessProperty: "error",
  });
  return doc.schema;
}

export const EventOccurrenceSchema = Schema.Struct({
  eventId: Schema.NonEmptyString,
  name: EventNameSchema,
  timestamp: IsoTimestampSchema,
  data: Schema.Record(Schema.String, Schema.Unknown),
  cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type EventOccurrence = typeof EventOccurrenceSchema.Type;

const EventOccurrenceWithoutCursorSchema = Schema.Struct({
  eventId: Schema.NonEmptyString,
  name: EventNameSchema,
  timestamp: IsoTimestampSchema,
  data: Schema.Record(Schema.String, Schema.Unknown),
});

function makePollBranch<N extends EventName>(name: N) {
  const filterSchema = EVENT_FILTER_SCHEMAS[name];
  return Schema.Struct({
    name: Schema.Literal(name),
    arguments: filterSchema.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({})),
      Schema.annotateEncoded({ default: {} }),
    ),
    cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
    maxAgeMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    maxEvents: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  });
}

export const PollEventsParamsSchema = Schema.Union([
  makePollBranch("bugzilla.bug.created"),
  makePollBranch("bugzilla.bug.updated"),
  makePollBranch("bugzilla.bug.commented"),
  makePollBranch("bugzilla.flag.needinfo"),
]);
export type PollEventsParams = typeof PollEventsParamsSchema.Type;

export const PollEventsResultSchema = Schema.Struct({
  resultType: Schema.Literal("complete"),
  events: Schema.Array(EventOccurrenceWithoutCursorSchema),
  cursor: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
  hasMore: Schema.Boolean,
  nextPollMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1000)),
});
export type PollEventsResult = typeof PollEventsResultSchema.Type;

export const WebhookSecretSchema = Schema.String.check(
  Schema.isPattern(/^whsec_[A-Za-z0-9+/=]{32,88}$/, {
    message: "Must be whsec_ followed by base64 of 24-64 random bytes",
  }),
);
export type WebhookSecret = typeof WebhookSecretSchema.Type;

export const WebhookDeliveryConfigSchema = Schema.Struct({
  mode: Schema.Literal("webhook"),
  url: HttpsUrlSchema,
  secret: WebhookSecretSchema,
});
export type WebhookDeliveryConfig = typeof WebhookDeliveryConfigSchema.Type;

function makeWebhookSubscribeBranch<N extends EventName>(name: N) {
  const filterSchema = EVENT_FILTER_SCHEMAS[name];
  return Schema.Struct({
    name: Schema.Literal(name),
    arguments: filterSchema.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({})),
      Schema.annotateEncoded({ default: {} }),
    ),
    delivery: WebhookDeliveryConfigSchema,
    cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
    maxAgeMs: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
    ttlMs: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
  });
}

export const WebhookSubscribeParamsSchema = Schema.Union([
  makeWebhookSubscribeBranch("bugzilla.bug.created"),
  makeWebhookSubscribeBranch("bugzilla.bug.updated"),
  makeWebhookSubscribeBranch("bugzilla.bug.commented"),
  makeWebhookSubscribeBranch("bugzilla.flag.needinfo"),
]);
export type WebhookSubscribeParams = typeof WebhookSubscribeParamsSchema.Type;

export const WebhookSubscribeResultSchema = Schema.Struct({
  resultType: Schema.Literal("complete"),
  id: Schema.NonEmptyString,
  refreshBefore: Schema.NullOr(IsoTimestampSchema),
  cursor: Schema.NullOr(Schema.String),
  truncated: Schema.Boolean,
});
export type WebhookSubscribeResult = typeof WebhookSubscribeResultSchema.Type;
