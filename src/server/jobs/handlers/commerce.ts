import "server-only";
import type { JobHandlers } from "../queue";

/** Job handlers for bookings, payments, refunds, partner fulfillment (owned by the commerce slice). Handlers must be idempotent. */
export const commerceHandlers: JobHandlers = {};
