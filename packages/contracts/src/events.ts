import { z } from "zod";
import { BugIdSchema, IsoTimestampSchema } from "./domain.js";

export const EventsProfileSchema = z.enum(["sep-3415", "chatgpt-events"]);
export type EventsProfile = z.infer<typeof EventsProfileSchema>;

export const EventNameSchema = z.enum([
  "bugzilla.bug.created",
  "bugzilla.bug.updated",
  "bugzilla.bug.commented",
  "bugzilla.flag.needinfo",
]);
export type EventName = z.infer<typeof EventNameSchema>;

export const DeliveryModeSchema = z.enum(["poll", "push", "webhook"]);
export type DeliveryMode = z.infer<typeof DeliveryModeSchema>;

export const EventFilterArgsSchema = z.object({
  product: z.string().min(1).optional(),
  component: z.string().min(1).optional(),
  bugIds: z.array(BugIdSchema).max(100).optional(),
  severity: z.string().min(1).optional(),
  watchedFields: z.array(z.string().min(1)).optional(),
  mentionMe: z.boolean().optional(),
  requestee: z.string().min(1).optional(),
  includeSelf: z.boolean().default(false),
});
export type EventFilterArgs = z.infer<typeof EventFilterArgsSchema>;

const watchedFields = ["status", "assigned_to", "priority", "flags"] as const;
const filtersByEvent = {
  "bugzilla.bug.created": EventFilterArgsSchema.pick({
    product: true,
    component: true,
    severity: true,
    includeSelf: true,
  }).strict(),
  "bugzilla.bug.updated": EventFilterArgsSchema.pick({
    product: true,
    bugIds: true,
    includeSelf: true,
  })
    .extend({ watchedFields: z.array(z.enum(watchedFields)).optional() })
    .strict(),
  "bugzilla.bug.commented": EventFilterArgsSchema.pick({
    product: true,
    bugIds: true,
    mentionMe: true,
    includeSelf: true,
  }).strict(),
  "bugzilla.flag.needinfo": EventFilterArgsSchema.pick({
    product: true,
    requestee: true,
    includeSelf: true,
  }).strict(),
} satisfies Record<EventName, object>;

export function parseEventFilters(name: EventName, input: unknown) {
  return filtersByEvent[name].safeParse(input === undefined ? {} : input);
}

export function eventFilterJsonSchema(name: EventName) {
  const string = { type: "string", minLength: 1 };
  const fields: Record<keyof EventFilterArgs, object> = {
    product: string,
    component: string,
    severity: string,
    bugIds: { type: "array", items: { type: "integer", minimum: 1 }, maxItems: 100 },
    watchedFields: { type: "array", items: { type: "string", enum: watchedFields } },
    mentionMe: { type: "boolean" },
    requestee: string,
    includeSelf: { type: "boolean", default: false },
  };
  return {
    type: "object",
    additionalProperties: false,
    properties: Object.fromEntries(
      Object.keys(filtersByEvent[name].shape).map((key) => [
        key,
        fields[key as keyof EventFilterArgs],
      ]),
    ),
  };
}

export const EventOccurrenceSchema = z.object({
  eventId: z.string().min(1),
  name: EventNameSchema,
  timestamp: IsoTimestampSchema,
  data: z.record(z.unknown()),
  cursor: z.string().nullable().optional(),
});
export type EventOccurrence = z.infer<typeof EventOccurrenceSchema>;

export const PollEventsParamsSchema = z.object({
  name: EventNameSchema,
  arguments: EventFilterArgsSchema.default({}),
  cursor: z.string().nullable().optional(),
  maxAgeMs: z.number().int().positive().optional(),
  maxEvents: z.number().int().min(1).max(100).optional(),
});
export type PollEventsParams = z.infer<typeof PollEventsParamsSchema>;

export const PollEventsResultSchema = z.object({
  resultType: z.literal("complete"),
  events: z.array(EventOccurrenceSchema.omit({ cursor: true })),
  cursor: z.string().nullable(),
  truncated: z.boolean(),
  hasMore: z.boolean(),
  nextPollMs: z.number().int().min(1000),
});
export type PollEventsResult = z.infer<typeof PollEventsResultSchema>;

export const WebhookSecretSchema = z
  .string()
  .regex(
    /^whsec_[A-Za-z0-9+/=]{32,88}$/,
    "Must be whsec_ followed by base64 of 24-64 random bytes",
  );

export const WebhookSubscribeParamsSchema = z.object({
  name: EventNameSchema,
  arguments: EventFilterArgsSchema.default({}),
  delivery: z.object({
    mode: z.literal("webhook"),
    url: z.string().url(),
    secret: WebhookSecretSchema,
  }),
  cursor: z.string().nullable().optional(),
  maxAgeMs: z.number().int().positive().optional(),
  ttlMs: z.number().int().positive().nullable().optional(),
});
export type WebhookSubscribeParams = z.infer<typeof WebhookSubscribeParamsSchema>;

export const WebhookSubscribeResultSchema = z.object({
  resultType: z.literal("complete"),
  id: z.string().min(1),
  refreshBefore: IsoTimestampSchema.nullable(),
  cursor: z.string().nullable(),
  truncated: z.boolean(),
});
export type WebhookSubscribeResult = z.infer<typeof WebhookSubscribeResultSchema>;
