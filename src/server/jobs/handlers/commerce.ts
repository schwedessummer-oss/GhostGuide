import "server-only";
import type { JobHandlers } from "../queue";
import { processRefundJob } from "@/server/commerce/refunds";
import { expireStaleHolds, reconcileEndedCheckouts, reconcilePendingPayments } from "@/server/commerce/reconcile";
import { processFulfillment } from "@/server/fulfillment/process";
import { requestShuttleRide } from "@/server/fulfillment/shuttle";
import { cancelWithPartner } from "@/server/fulfillment/cancel";
import { ShuttleConfirmationRequiredError } from "@/integrations/partners";

/**
 * Job handlers for bookings, payments, refunds, partner fulfillment (owned by
 * the commerce slice). Handlers re-load current state and are idempotent:
 * obsolete or repeated runs return { outcome: "noop" }.
 */
const str = (v: unknown): string => {
  if (typeof v !== "string" || !/^[0-9a-f-]{36}$/i.test(v)) throw new Error("invalid job payload");
  return v;
};

export const commerceHandlers: JobHandlers = {
  "fulfillment.process": async (job) => processFulfillment(str(job.payload.fulfillmentId)),

  "fulfillment.cancel": async (job) => cancelWithPartner(str(job.payload.fulfillmentId)),

  "shuttle.request_ride": async (job) => {
    try {
      return await requestShuttleRide(str(job.payload.fulfillmentId), { attempts: job.attempts, maxAttempts: job.maxAttempts });
    } catch (err) {
      // Never retry into a paid ride without confirmation: refuse permanently.
      if (err instanceof ShuttleConfirmationRequiredError) return { outcome: "noop", note: err.message };
      throw err;
    }
  },

  "refunds.process": async (job) => processRefundJob(str(job.payload.refundId)),

  "bookings.expire_holds": async () => {
    const t = await expireStaleHolds();
    return { outcome: "done", note: JSON.stringify(t) };
  },

  "payments.reconcile": async () => {
    const r = await reconcilePendingPayments();
    const ended = await reconcileEndedCheckouts();
    return { outcome: "done", note: JSON.stringify({ ...r, endedCheckouts: ended }) };
  },
};
