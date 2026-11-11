import "server-only";
import { withUser } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { revealAccessCodes } from "@/server/fulfillment/access-codes";
import { describeFulfillment, type AddonKind } from "@/domain/booking";
import type { FulfillmentStatus } from "@/domain/types";
import type { BundleAddon, BundleLogistics, BundlePermit } from "@/lib/offline/wire";

/**
 * Booked add-on details (locker, shuttle pickup, meal pickup) and permit
 * status for a trip the caller has ALREADY verified the user owns. Read as
 * the user (RLS) and filtered on user_id. Locker access codes are revealed
 * only to the owner, only for a confirmed booking and only while the code is
 * valid (src/server/fulfillment/access-codes.ts). Used by the offline bundle
 * (so the help/pre-start screens work at a trailhead without signal) and the
 * prepare page.
 */
interface AddonRow {
  id: string;
  kind: AddonKind;
  status: FulfillmentStatus;
  name: string;
  quantity: number;
  details: Record<string, unknown> | null;
  providerKey: string;
  srStatus: string | null;
  srPickup: string | null;
  srDropoff: string | null;
  srPickupAt: Date | null;
  srQuoteExpiresAt: Date | null;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

export async function getTripLogistics(user: SessionUser, trip: { id: string; trailId: string }): Promise<BundleLogistics> {
  const data = await withUser(user, async (tx) => {
    const [booking] = await tx<{ id: string; status: string }[]>`
      select id, status from public.bookings
      where trip_id = ${trip.id} and user_id = ${user.id} and status in ('confirmed', 'cancellation_requested', 'refund_pending', 'needs_attention')
      order by created_at desc limit 1`;
    const [addons, permits] = await Promise.all([
      booking
        ? tx<AddonRow[]>`
            select f.id, f.provider_kind as kind, f.status, coalesce(a.name, initcap(replace(f.provider_kind, '_', ' '))) as name,
                   ba.quantity, f.details, f.provider_key,
                   sr.status as sr_status, sr.pickup_description as sr_pickup, sr.dropoff_description as sr_dropoff,
                   sr.pickup_at as sr_pickup_at, sr.quote_expires_at as sr_quote_expires_at
            from public.fulfillments f
            join public.booking_addons ba on ba.id = f.booking_addon_id
            left join public.addons a on a.id = ba.addon_id
            left join public.shuttle_requests sr on sr.fulfillment_id = f.id
            where f.booking_id = ${booking.id}
            order by f.provider_kind, f.id`
        : Promise.resolve([] as AddonRow[]),
      tx<BundlePermit[]>`
        select pr.name, pr.authority, pr.official_url, pr.requirement_summary, pr.how_to_obtain,
               coalesce(tp.status, 'not_started') as status, tp.confirmation_ref
        from public.permit_requirements pr
        left join public.trip_permits tp on tp.permit_requirement_id = pr.id and tp.trip_id = ${trip.id}
        where pr.trail_id = ${trip.trailId}
        order by pr.name`,
    ]);
    return { booking: booking ?? null, addons, permits };
  });

  const codes = data.booking?.status === "confirmed" ? await revealAccessCodes(user, data.booking.id) : {};
  const addons: BundleAddon[] = data.addons.map((f) => {
    const det = f.details ?? {};
    const accessCode = codes[f.id] ?? null;
    const quoteExpired = !!f.srQuoteExpiresAt && f.srQuoteExpiresAt.getTime() <= Date.now();
    const statusText = describeFulfillment(f.kind, f.status, { codeReady: !!accessCode, shuttleQuoteExpired: quoteExpired }).text;
    const ready = f.status === "confirmed" || f.status === "completed";
    const isLocker = f.kind === "gear_locker" || f.kind === "satellite_device";
    const pickupAt = f.srPickupAt?.toISOString() ?? str(det.pickupAt);
    return {
      id: f.id,
      kind: f.kind,
      name: f.name,
      quantity: f.quantity,
      status: f.status,
      statusText,
      simulated: f.providerKey === "demo",
      locker:
        isLocker && ready
          ? {
              name: str(det.lockerName),
              location: str(det.locationDescription),
              items: strList(det.items),
              accessCode,
              codeHint: accessCode ? null : str(det.codeHint),
              codeExpiresAt: str(det.codeExpiresAt),
              disclaimer: str(det.disclaimer),
            }
          : null,
      shuttle:
        f.kind === "shuttle"
          ? {
              pickup: f.srPickup ?? str(det.pickup),
              dropoff: f.srDropoff ?? str(det.dropoff),
              pickupAt,
              confirmed: f.status === "confirmed" || f.status === "requested" || f.status === "completed",
            }
          : null,
      meal: f.kind === "meal_pack" && ready ? { pickup: str(det.pickup) } : null,
    };
  });
  return { bookingStatus: data.booking?.status ?? null, addons, permits: data.permits };
}
