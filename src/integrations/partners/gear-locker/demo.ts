import "server-only";
import { assertSimulationAllowed, env } from "@/config/env";
import type { Tx } from "@/server/db";
import { injectSimulatedFailure, partnerCall } from "../failure";
import {
  PartnerRejectedError,
  type GearAvailability,
  type GearKindRequest,
  type GearLockerProvider,
  type GearReservationResult,
  type PartnerCallContext,
} from "../types";
import { accessCodeHint, deriveAccessCode, hashAccessCode } from "./access-code";

/**
 * DEMO gear-locker partner. Simulates a smart-locker operator using Ghost
 * Guide's own gear inventory tables (gear_lockers / gear_items /
 * gear_reservations). No real locker hardware or vendor API is involved.
 *
 * Availability is per calendar day: an item can be reserved for many
 * different days, but the unique index gear_item_one_active_reservation_per_day
 * guarantees at most one active reservation per item per day. Items in
 * maintenance/retired, or in an offline locker, are never offered.
 */
const KIND = "gear_locker";

export class DemoGearLockerProvider implements GearLockerProvider {
  readonly key = "demo";
  readonly simulated = true;

  async checkAvailability(tx: Tx, regionId: string, date: string, kinds: GearKindRequest[]): Promise<GearAvailability> {
    assertSimulationAllowed("gear locker");
    const byKind: GearAvailability["byKind"] = [];
    for (const k of kinds) {
      const [row] = await tx<{ n: number }[]>`
        select count(*)::int as n
        from public.gear_items gi
        left join public.gear_lockers gl on gl.id = gi.locker_id
        where gi.region_id = ${regionId} and gi.kind = ${k.kind}
          and gi.status in ('available', 'reserved', 'checked_out')
          and (gl.id is null or gl.status = 'online')
          and not exists (
            select 1 from public.gear_reservations gr
            where gr.gear_item_id = gi.id and gr.reserved_for = ${date}::date and gr.status in ('reserved', 'picked_up'))`;
      byKind.push({ kind: k.kind, requested: k.count, available: row.n });
    }
    return { ok: byKind.every((k) => k.available >= k.requested), byKind };
  }

  async reserve(tx: Tx, ctx: PartnerCallContext & { regionId: string }, date: string, kinds: GearKindRequest[]): Promise<GearReservationResult> {
    assertSimulationAllowed("gear locker");
    return partnerCall(
      { providerKind: KIND, providerKey: this.key, operation: "reserve", entityType: "fulfillment", entityId: ctx.fulfillmentId, simulated: true },
      async () => {
        injectSimulatedFailure("gear locker", ctx);
        return reserveItems(tx, ctx.fulfillmentId, ctx.regionId, date, kinds);
      },
    );
  }

  async issueAccessCode(tx: Tx, reservation: Pick<GearReservationResult, "primaryReservationId" | "reservationIds">, expiresAt: Date) {
    assertSimulationAllowed("gear locker");
    return issueCode(tx, reservation, expiresAt);
  }

  async release(tx: Tx, fulfillmentId: string): Promise<number> {
    assertSimulationAllowed("gear locker");
    return releaseReservations(tx, fulfillmentId);
  }

  async markPickedUp(tx: Tx, reservationId: string): Promise<boolean> {
    assertSimulationAllowed("gear locker");
    const rows = await tx<{ gearItemId: string }[]>`
      update public.gear_reservations set status = 'picked_up', picked_up_at = now()
      where id = ${reservationId} and status = 'reserved' returning gear_item_id`;
    if (rows.length) await tx`update public.gear_items set status = 'checked_out' where id = ${rows[0].gearItemId}`;
    return rows.length > 0;
  }

  async markReturned(tx: Tx, reservationId: string): Promise<boolean> {
    assertSimulationAllowed("gear locker");
    const rows = await tx<{ gearItemId: string }[]>`
      update public.gear_reservations set status = 'returned', returned_at = now()
      where id = ${reservationId} and status in ('picked_up', 'overdue') returning gear_item_id`;
    if (rows.length) await freeItems(tx, [rows[0].gearItemId]);
    return rows.length > 0;
  }

  async reportMaintenance(tx: Tx, gearItemId: string, note: string): Promise<boolean> {
    assertSimulationAllowed("gear locker");
    const rows = await tx`
      update public.gear_items set status = 'maintenance', condition_notes = ${note.slice(0, 1000)}
      where id = ${gearItemId} and status <> 'retired' returning id`;
    return rows.length > 0;
  }
}

/** Shared by the gear-locker and satellite-rental demo adapters. */
export async function reserveItems(
  tx: Tx,
  fulfillmentId: string,
  regionId: string,
  date: string,
  kinds: GearKindRequest[],
): Promise<GearReservationResult> {
  // Idempotent: a retried job that already reserved returns the same reservation.
  const existing = await tx<{ id: string; lockerId: string | null; label: string }[]>`
    select gr.id, gr.locker_id, gi.label from public.gear_reservations gr join public.gear_items gi on gi.id = gr.gear_item_id
    where gr.fulfillment_id = ${fulfillmentId} and gr.status in ('reserved', 'picked_up') order by gr.created_at, gr.id`;
  if (existing.length) return describe(tx, existing);

  const reserved: { id: string; lockerId: string | null; label: string }[] = [];
  for (const k of kinds) {
    if (k.count <= 0) continue;
    // SKIP LOCKED: concurrent reservations pick different items instead of blocking.
    const items = await tx<{ id: string; lockerId: string | null; label: string }[]>`
      select gi.id, gi.locker_id, gi.label
      from public.gear_items gi
      left join public.gear_lockers gl on gl.id = gi.locker_id
      where gi.region_id = ${regionId} and gi.kind = ${k.kind}
        and gi.status in ('available', 'reserved', 'checked_out')
        and (gl.id is null or gl.status = 'online')
        and not exists (
          select 1 from public.gear_reservations gr
          where gr.gear_item_id = gi.id and gr.reserved_for = ${date}::date and gr.status in ('reserved', 'picked_up'))
      order by gi.label
      for update of gi skip locked
      limit ${k.count}`;
    if (items.length < k.count) {
      throw new PartnerRejectedError(`Not enough ${k.kind.replace(/_/g, " ")} available on ${date} (${items.length} of ${k.count})`);
    }
    for (const item of items) {
      const [r] = await tx<{ id: string }[]>`
        insert into public.gear_reservations (fulfillment_id, gear_item_id, locker_id, reserved_for, status)
        values (${fulfillmentId}, ${item.id}, ${item.lockerId}, ${date}::date, 'reserved')
        returning id`;
      reserved.push({ id: r.id, lockerId: item.lockerId, label: item.label });
    }
    await tx`update public.gear_items set status = 'reserved' where id = any(${items.map((i) => i.id)}::uuid[]) and status = 'available'`;
  }
  if (!reserved.length) throw new PartnerRejectedError("Nothing to reserve");
  return describe(tx, reserved);
}

async function describe(tx: Tx, rows: { id: string; lockerId: string | null; label: string }[]): Promise<GearReservationResult> {
  const lockerId = rows[0].lockerId;
  const [locker] = lockerId
    ? await tx<{ name: string; locationDescription: string }[]>`select name, location_description from public.gear_lockers where id = ${lockerId}`
    : [];
  return {
    lockerId,
    lockerName: locker?.name ?? "Trailhead pickup (demo)",
    locationDescription: locker?.locationDescription ?? "Ask at the trailhead kiosk (demo).",
    reservationIds: rows.map((r) => r.id),
    primaryReservationId: rows[0].id,
    itemLabels: rows.map((r) => r.label),
  };
}

export async function issueCode(tx: Tx, reservation: Pick<GearReservationResult, "primaryReservationId" | "reservationIds">, expiresAt: Date) {
  const code = deriveAccessCode(env().AUTH_SECRET, reservation.primaryReservationId);
  const hash = hashAccessCode(reservation.primaryReservationId, code);
  const hint = accessCodeHint(code);
  await tx`
    update public.gear_reservations
    set access_code_hash = ${hash}, access_code_hint = ${hint}, access_code_expires_at = ${expiresAt}::timestamptz
    where id = any(${reservation.reservationIds}::uuid[])`;
  return { hint, expiresAt };
}

async function freeItems(tx: Tx, itemIds: string[]) {
  if (!itemIds.length) return;
  // An item goes back to 'available' only when no other active reservation remains.
  await tx`
    update public.gear_items gi set status = 'available'
    where gi.id = any(${itemIds}::uuid[]) and gi.status in ('reserved', 'checked_out')
      and not exists (select 1 from public.gear_reservations gr where gr.gear_item_id = gi.id and gr.status in ('reserved', 'picked_up'))`;
}

export async function releaseReservations(tx: Tx, fulfillmentId: string): Promise<number> {
  const rows = await tx<{ gearItemId: string }[]>`
    update public.gear_reservations set status = 'cancelled'
    where fulfillment_id = ${fulfillmentId} and status = 'reserved'
    returning gear_item_id`;
  await freeItems(
    tx,
    rows.map((r) => r.gearItemId),
  );
  return rows.length;
}
