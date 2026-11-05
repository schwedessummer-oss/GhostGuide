import "server-only";
import { withSystem, type Tx } from "@/server/db";
import { cancelQueuedJobs, enqueueJob, type JobOutcome } from "@/server/jobs/queue";
import { getGearLockerProvider, getMealPackProvider, getShuttleProvider } from "@/integrations/partners";
import { releaseReservations } from "@/integrations/partners/gear-locker/demo";

/**
 * Cancel every open fulfillment of a booking inside the caller's
 * transaction: gear/satellite reservations are released immediately (our own
 * inventory), queued fulfillment jobs are cancelled, and partners that hold
 * an external order/ride get a `fulfillment.cancel` job (dedup
 * `fulfill-cancel:<id>`) so the partner call happens outside the lock.
 */
export async function cancelFulfillmentsForBooking(tx: Tx, bookingId: string): Promise<number> {
  const rows = await tx<{ id: string; providerKind: string; providerKey: string; externalRef: string | null; status: string }[]>`
    select id, provider_kind, provider_key, external_ref, status from public.fulfillments
    where booking_id = ${bookingId} and status not in ('cancelled', 'completed')
    for update`;
  for (const f of rows) await cancelOneFulfillment(tx, f);
  return rows.length;
}

export async function cancelOneFulfillment(tx: Tx, f: { id: string; providerKind: string; providerKey: string; externalRef: string | null }) {
  if (f.providerKind === "gear_locker" || f.providerKind === "satellite_device") {
    try {
      await getGearLockerProvider(f.providerKey).release(tx, f.id);
    } catch {
      // Unknown provider key: still free our own inventory rows.
      await releaseReservations(tx, f.id);
    }
  }
  if (f.providerKind === "shuttle") {
    await tx`update public.shuttle_requests set status = 'cancelled' where fulfillment_id = ${f.id} and status not in ('completed', 'cancelled')`;
  }
  await tx`update public.fulfillments set status = 'cancelled' where id = ${f.id}`;
  await cancelQueuedJobs(tx, `fulfill:${f.id}`);
  await cancelQueuedJobs(tx, `shuttle:${f.id}:`);
  if (f.externalRef && (f.providerKind === "meal_pack" || f.providerKind === "shuttle")) {
    await enqueueJob(tx, "fulfillment.cancel", { fulfillmentId: f.id }, { dedupKey: `fulfill-cancel:${f.id}`, maxAttempts: 5 });
  }
}

/** Job body for `fulfillment.cancel`: tell the partner. Idempotent via details.partnerCancelledAt. */
export async function cancelWithPartner(fulfillmentId: string): Promise<JobOutcome> {
  const [f] = await withSystem(
    (tx) => tx<{ id: string; providerKind: string; providerKey: string; externalRef: string | null; status: string; details: Record<string, unknown> }[]>`
      select id, provider_kind, provider_key, external_ref, status, details from public.fulfillments where id = ${fulfillmentId}`,
  );
  if (!f || f.status !== "cancelled" || !f.externalRef) return { outcome: "noop", note: "nothing to cancel" };
  if (f.details?.partnerCancelledAt) return { outcome: "noop", note: "already cancelled with partner" };
  const ctx = { fulfillmentId: f.id, attempt: 1, simulate: null };
  if (f.providerKind === "meal_pack") await getMealPackProvider(f.providerKey).cancelOrder(f.externalRef, ctx);
  else if (f.providerKind === "shuttle") await getShuttleProvider(f.providerKey).cancelRide(f.externalRef, ctx);
  await withSystem(
    (tx) => tx`update public.fulfillments set details = details || ${tx.json({ partnerCancelledAt: new Date().toISOString() })} where id = ${f.id}`,
  );
  return { outcome: "done" };
}
