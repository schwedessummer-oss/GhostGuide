import "server-only";
import { env } from "@/config/env";
import { withSystem } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { safeEqual } from "@/server/auth/tokens";
import { deriveAccessCode, hashAccessCode } from "@/integrations/partners/gear-locker/access-code";

/**
 * Reveal locker access codes to the booking OWNER only. Codes are never
 * stored; they are re-derived from the reservation id and checked against
 * the stored hash. Returns fulfillmentId → code for active, unexpired
 * reservations. Never call this for anyone but the authenticated owner.
 */
export async function revealAccessCodes(user: SessionUser, bookingId: string): Promise<Record<string, string>> {
  const rows = await withSystem(
    (tx) => tx<{ fulfillmentId: string; reservationId: string; accessCodeHash: string | null }[]>`
      select distinct on (f.id) f.id as fulfillment_id, gr.id as reservation_id, gr.access_code_hash
      from public.fulfillments f
      join public.bookings b on b.id = f.booking_id
      join public.gear_reservations gr on gr.fulfillment_id = f.id and gr.id::text = f.details ->> 'primaryReservationId'
      where b.id = ${bookingId} and b.user_id = ${user.id} and b.status = 'confirmed'
        and f.status = 'confirmed' and gr.status in ('reserved', 'picked_up')
        and gr.access_code_expires_at > now()
      order by f.id`,
  );
  const out: Record<string, string> = {};
  for (const r of rows) {
    const code = deriveAccessCode(env().AUTH_SECRET, r.reservationId);
    if (r.accessCodeHash && safeEqual(hashAccessCode(r.reservationId, code), r.accessCodeHash)) out[r.fulfillmentId] = code;
  }
  return out;
}
