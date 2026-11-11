import { z } from "zod";
import { HIKE_EVENT_KINDS } from "@/lib/offline/wire";

/**
 * Request validation for the hike API. Every route handler parses its body
 * with one of these before calling a use-case; use-cases also accept only
 * these parsed shapes.
 */
const clientId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/, "invalid client id");
const isoDate = z.iso.datetime({ offset: true });

export const MAX_SYNC_POINTS = 500;
export const MAX_SYNC_EVENTS = 200;
/**
 * Points/events stamped further than this in the future (AFTER correcting the
 * device clock skew estimated from the request's `sentAt`) are rejected —
 * except safety events (I'm okay, extend, finish), which are accepted with
 * the time clamped to now.
 */
export const FUTURE_TOLERANCE_MS = 2 * 60_000;

export const syncPointSchema = z.object({
  id: clientId,
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().min(0).max(100_000).nullable().default(null),
  altitudeM: z.number().min(-1000).max(10_000).nullable().default(null),
  recordedAt: isoDate,
});

/** Event payloads are whitelisted (and never include coordinates). */
export const eventPayloadSchema = z
  .object({
    poiId: z.uuid().optional(),
    narrationId: z.uuid().optional(),
    source: z.enum(["gps", "manual"]).optional(),
    distanceM: z.number().min(0).max(1_000_000).optional(),
    reason: z.string().max(120).optional(),
    reminder: z.enum(["hydration", "pace_check"]).optional(),
    progressM: z.number().min(0).max(1_000_000).optional(),
    movingTimeSec: z.number().int().min(0).max(14 * 86_400).optional(),
    simulated: z.boolean().optional(),
    newExpectedReturnAt: isoDate.optional(),
  })
  .strict();

export const syncEventSchema = z
  .object({
    id: clientId,
    kind: z.enum(HIKE_EVENT_KINDS),
    occurredAt: isoDate,
    payload: eventPayloadSchema.default({}),
  })
  .refine((e) => e.kind !== "checkin_extend" || !!e.payload.newExpectedReturnAt, {
    message: "checkin_extend needs payload.newExpectedReturnAt",
    path: ["payload", "newExpectedReturnAt"],
  });

export const syncRequestSchema = z.object({
  sessionId: z.uuid(),
  points: z.array(syncPointSchema).max(MAX_SYNC_POINTS).default([]),
  events: z.array(syncEventSchema).max(MAX_SYNC_EVENTS).default([]),
  progressM: z.number().min(0).max(1_000_000).optional(),
  /** device clock at send time, for clock-skew correction */
  sentAt: isoDate.optional(),
});
export type SyncInput = z.infer<typeof syncRequestSchema>;

export const startRequestSchema = z.object({
  tripId: z.uuid(),
  clientSessionId: z.uuid().optional(),
  startedAt: isoDate.optional(),
  /** honoured only when APP_MODE=demo: "Start anyway (demo)" on a day other than the booked date */
  demoStartAnyway: z.boolean().optional(),
  sentAt: isoDate.optional(),
});
export type StartInput = z.infer<typeof startRequestSchema>;

export const finishRequestSchema = z.object({
  tripId: z.uuid(),
  sessionId: z.uuid().optional(),
  finishedAt: isoDate.optional(),
  distanceCompletedM: z.number().min(0).max(1_000_000).optional(),
  sentAt: isoDate.optional(),
});
export type FinishInput = z.infer<typeof finishRequestSchema>;

export const downloadRecordSchema = z.object({
  manifestVersion: z.number().int().min(1).max(1_000_000),
  manifestChecksum: z.string().regex(/^[0-9a-f]{64}$/),
  itemCount: z.number().int().min(0).max(10_000),
  verifiedComplete: z.boolean(),
});
export type DownloadRecordInput = z.infer<typeof downloadRecordSchema>;

export const FEEDBACK_ISSUES = [
  { value: "gps_inaccurate", label: "Location was inaccurate" },
  { value: "audio_missed", label: "Narration didn't play where expected" },
  { value: "audio_quality", label: "Audio or voice was hard to hear" },
  { value: "offline_problem", label: "Offline download didn't work" },
  { value: "route_mismatch", label: "Route didn't match the trail" },
  { value: "battery", label: "Battery drained quickly" },
  { value: "addon_problem", label: "Problem with gear, shuttle or meals" },
  { value: "other", label: "Something else" },
] as const;

export const feedbackSchema = z.object({
  rating: z.coerce.number().int().min(1).max(5),
  comments: z.string().trim().max(4000).optional().transform((s) => (s ? s : null)),
  issues: z.array(z.enum(FEEDBACK_ISSUES.map((i) => i.value) as [string, ...string[]])).max(FEEDBACK_ISSUES.length).default([]),
});
export type FeedbackInput = z.infer<typeof feedbackSchema>;

export const PERMIT_STATUSES = ["not_started", "applied", "obtained", "denied", "not_required"] as const;
export const permitUpdateSchema = z.object({
  permitRequirementId: z.uuid(),
  status: z.enum(PERMIT_STATUSES),
  confirmationRef: z.string().trim().max(120).optional().transform((s) => (s ? s : null)),
});
