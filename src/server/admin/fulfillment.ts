import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import type { FulfillmentStatus } from "@/domain/types";
import { assertCan, staffTx, type Page, type Paged } from "./common";

export const FULFILLMENT_STATUSES = ["pending", "requested", "awaiting_customer", "confirmed", "completed", "failed", "cancelled", "needs_attention"] as const satisfies readonly FulfillmentStatus[];
export const PROVIDER_KINDS = ["gear_locker", "shuttle", "meal_pack", "satellite_device", "other"] as const;

/** Queue presets for the fulfillment page. */
export const FULFILLMENT_QUEUES = {
  attention: ["failed", "needs_attention"],
  failed: ["failed"],
  needs_attention: ["needs_attention"],
  awaiting_customer: ["awaiting_customer"],
  in_progress: ["pending", "requested", "confirmed"],
  all: [...FULFILLMENT_STATUSES],
} as const satisfies Record<string, readonly FulfillmentStatus[]>;
export type FulfillmentQueue = keyof typeof FULFILLMENT_QUEUES;

export interface FulfillmentRow {
  id: string;
  bookingId: string;
  bookingStatus: string;
  hikeDate: string;
  trailName: string;
  providerKind: string;
  providerKey: string;
  addonName: string;
  status: FulfillmentStatus;
  externalRef: string | null;
  attempts: number;
  lastError: string | null;
  updatedAt: Date;
}

export async function listFulfillments(user: SessionUser, f: { queue?: string; kind?: string }, page: Page): Promise<Paged<FulfillmentRow>> {
  assertCan(user, "fulfillment.manage");
  const queue = (z.enum(Object.keys(FULFILLMENT_QUEUES) as [FulfillmentQueue, ...FulfillmentQueue[]]).safeParse(f.queue).data ?? "attention") as FulfillmentQueue;
  const statuses = [...FULFILLMENT_QUEUES[queue]];
  const kind = z.enum(PROVIDER_KINDS).safeParse(f.kind).data ?? null;
  const rows = await staffTx(user, (tx) => tx<(FulfillmentRow & { total: number })[]>`
    select f.id, f.booking_id, b.status as booking_status, to_char(b.hike_date, 'YYYY-MM-DD') as hike_date, t.name as trail_name,
           f.provider_kind, f.provider_key, a.name as addon_name, f.status, f.external_ref, f.attempts, f.last_error, f.updated_at,
           count(*) over()::int as total
    from public.fulfillments f
    join public.bookings b on b.id = f.booking_id
    join public.trails t on t.id = b.trail_id
    join public.booking_addons ba on ba.id = f.booking_addon_id
    join public.addons a on a.id = ba.addon_id
    where f.status::text = any(${statuses}::text[])
      and (${kind}::text is null or f.provider_kind = ${kind}::text)
    order by b.hike_date, f.updated_at desc
    limit ${page.limit} offset ${page.offset}`);
  return { rows, total: rows[0]?.total ?? 0, ...page };
}

export interface ShuttleAwaitingRow {
  id: string;
  fulfillmentId: string;
  bookingId: string;
  hikeDate: string;
  trailName: string;
  status: string;
  pickupDescription: string | null;
  pickupAt: Date | null;
  quotedPriceCents: number | null;
  quoteExpiresAt: Date | null;
  currency: string;
  updatedAt: Date;
}

/** Shuttle quotes waiting for the CUSTOMER to confirm (read-only for staff). */
export async function listShuttlesAwaitingCustomer(user: SessionUser): Promise<ShuttleAwaitingRow[]> {
  assertCan(user, "fulfillment.manage");
  return staffTx(user, (tx) => tx<ShuttleAwaitingRow[]>`
    select sr.id, sr.fulfillment_id, f.booking_id, to_char(b.hike_date, 'YYYY-MM-DD') as hike_date, t.name as trail_name, sr.status,
           sr.pickup_description, sr.pickup_at, sr.quoted_price_cents, sr.quote_expires_at, b.currency, sr.updated_at
    from public.shuttle_requests sr
    join public.fulfillments f on f.id = sr.fulfillment_id
    join public.bookings b on b.id = f.booking_id
    join public.trails t on t.id = b.trail_id
    where sr.customer_confirmed_at is null and sr.status in ('quote_pending', 'quoted')
      and f.status not in ('cancelled', 'completed')
    order by b.hike_date`);
}
