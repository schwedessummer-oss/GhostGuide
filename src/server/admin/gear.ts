import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import { assertCan, auditInStaffTx, auditInSystemTx, fail, guarded, isUuid, ok, optionalText, staffTx, systemTx, zodFail, type ActionResult } from "./common";

/** Gear lockers, items and reservations (simulated partner hardware in demo mode). */
export const LOCKER_STATUSES = ["online", "offline", "maintenance"] as const;
export const ITEM_STATUSES = ["available", "reserved", "checked_out", "maintenance", "retired"] as const;
export const STAFF_SETTABLE_ITEM_STATUSES = ["available", "maintenance", "retired"] as const;
export const RESERVATION_STATUSES = ["reserved", "picked_up", "returned", "cancelled", "overdue"] as const;

export interface LockerRow {
  id: string;
  name: string;
  locationDescription: string;
  status: (typeof LOCKER_STATUSES)[number];
  providerKey: string;
  itemCount: number;
  availableCount: number;
}

export interface GearItemRow {
  id: string;
  lockerId: string | null;
  lockerName: string | null;
  kind: string;
  label: string;
  status: (typeof ITEM_STATUSES)[number];
  conditionNotes: string | null;
  lastMaintenanceAt: Date | null;
  updatedAt: Date;
  activeReservations: number;
}

export interface ReservationRow {
  id: string;
  reservedFor: string;
  status: (typeof RESERVATION_STATUSES)[number];
  itemLabel: string;
  itemId: string;
  lockerName: string | null;
  fulfillmentId: string;
  bookingId: string;
  bookingStatus: string;
  accessCodeExpiresAt: Date | null;
  pickedUpAt: Date | null;
  returnedAt: Date | null;
}

export async function getGearOverview(user: SessionUser, filters: { itemStatus?: string; days?: number } = {}) {
  assertCan(user, "gear.manage");
  const itemStatus = z.enum(ITEM_STATUSES).safeParse(filters.itemStatus).data ?? null;
  const days = Math.min(Math.max(filters.days ?? 7, 1), 60);
  return staffTx(user, async (tx) => {
    const [lockers, items, reservations] = await Promise.all([
      tx<LockerRow[]>`
        select l.id, l.name, l.location_description, l.status, l.provider_key,
               (select count(*)::int from public.gear_items i where i.locker_id = l.id and i.status <> 'retired') as item_count,
               (select count(*)::int from public.gear_items i where i.locker_id = l.id and i.status = 'available') as available_count
        from public.gear_lockers l order by l.name`,
      tx<GearItemRow[]>`
        select i.id, i.locker_id, l.name as locker_name, i.kind, i.label, i.status, i.condition_notes, i.last_maintenance_at, i.updated_at,
               (select count(*)::int from public.gear_reservations r where r.gear_item_id = i.id and r.status in ('reserved', 'picked_up', 'overdue')
                  and r.reserved_for >= current_date - 1) as active_reservations
        from public.gear_items i left join public.gear_lockers l on l.id = i.locker_id
        where (${itemStatus}::text is null or i.status = ${itemStatus}::text)
        order by i.kind, i.label`,
      tx<ReservationRow[]>`
        select r.id, to_char(r.reserved_for, 'YYYY-MM-DD') as reserved_for, r.status, i.label as item_label, i.id as item_id,
               l.name as locker_name, r.fulfillment_id, f.booking_id, b.status as booking_status, r.access_code_expires_at, r.picked_up_at, r.returned_at
        from public.gear_reservations r
        join public.gear_items i on i.id = r.gear_item_id
        left join public.gear_lockers l on l.id = r.locker_id
        join public.fulfillments f on f.id = r.fulfillment_id
        join public.bookings b on b.id = f.booking_id
        where (r.reserved_for between current_date - 1 and current_date + ${days}::int) or r.status in ('picked_up', 'overdue')
        order by r.reserved_for, i.label`,
    ]);
    return { lockers, items, reservations, days };
  });
}

export async function setLockerStatus(user: SessionUser, lockerId: string, status: unknown): Promise<ActionResult> {
  assertCan(user, "gear.manage");
  if (!isUuid(lockerId)) return fail("Locker not found.");
  const s = z.enum(LOCKER_STATUSES).safeParse(status);
  if (!s.success) return fail("Choose online, offline or maintenance.");
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [before] = await tx<{ status: string }[]>`select status from public.gear_lockers where id = ${lockerId} for update`;
      if (!before) return fail("Locker not found.");
      await tx`update public.gear_lockers set status = ${s.data} where id = ${lockerId}`;
      await auditInStaffTx(tx, user, "gear.locker_status", "gear_locker", lockerId, { from: before.status, to: s.data });
      return ok(`Locker marked ${s.data}.`, {
        warnings: s.data !== "online" ? ["New gear-locker fulfillments for this locker may fail until it is back online."] : [],
      });
    }),
  );
}

const itemSchema = z.object({ status: z.enum(STAFF_SETTABLE_ITEM_STATUSES), conditionNotes: optionalText(1000) });

export async function updateGearItem(user: SessionUser, itemId: string, input: z.input<typeof itemSchema>): Promise<ActionResult> {
  assertCan(user, "gear.manage");
  if (!isUuid(itemId)) return fail("Item not found.");
  const p = itemSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const d = p.data;
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [item] = await tx<{ status: string; label: string }[]>`select status, label from public.gear_items where id = ${itemId} for update`;
      if (!item) return fail("Item not found.");
      if (item.status === "checked_out" && d.status !== "maintenance") return fail("This item is checked out. Mark its reservation returned first.");
      if (d.status !== "available") {
        const [busy] = await tx<{ n: number }[]>`
          select count(*)::int as n from public.gear_reservations
          where gear_item_id = ${itemId} and status in ('reserved', 'picked_up') and reserved_for >= current_date`;
        if (busy.n > 0 && item.status !== "checked_out") return fail(`${item.label} has ${busy.n} upcoming reservation(s). Reassign them before taking it out of service.`);
      }
      await tx`update public.gear_items set status = ${d.status}, condition_notes = ${d.conditionNotes} where id = ${itemId}`;
      await auditInStaffTx(tx, user, "gear.item_updated", "gear_item", itemId, { from: item.status, to: d.status });
      return ok(`${item.label} saved as ${d.status}.`);
    }),
  );
}

export async function recordMaintenance(user: SessionUser, itemId: string, notes: unknown): Promise<ActionResult> {
  assertCan(user, "gear.manage");
  if (!isUuid(itemId)) return fail("Item not found.");
  const n = z.string().trim().min(3, "Describe the maintenance (at least 3 characters).").max(1000).safeParse(notes ?? "");
  if (!n.success) return zodFail(n.error);
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [item] = await tx<{ status: string; label: string }[]>`select status, label from public.gear_items where id = ${itemId} for update`;
      if (!item) return fail("Item not found.");
      if (item.status === "checked_out" || item.status === "retired") return fail(`A ${item.status.replace("_", " ")} item cannot be serviced here.`);
      const next = item.status === "maintenance" ? "available" : item.status;
      await tx`update public.gear_items set last_maintenance_at = now(), condition_notes = ${n.data}, status = ${next} where id = ${itemId}`;
      await auditInStaffTx(tx, user, "gear.maintenance_recorded", "gear_item", itemId, { from: item.status, to: next });
      return ok(`Maintenance recorded for ${item.label}${next !== item.status ? "; it is available again" : ""}.`);
    }),
  );
}

const RESERVATION_TRANSITIONS: Record<string, readonly string[]> = {
  reserved: ["picked_up"],
  picked_up: ["returned", "overdue"],
  overdue: ["returned"],
};

/** Mark a reservation picked up / returned / overdue (lifecycle table → trusted write after the check). */
export async function setReservationStatus(user: SessionUser, reservationId: string, status: unknown): Promise<ActionResult> {
  assertCan(user, "gear.manage");
  if (!isUuid(reservationId)) return fail("Reservation not found.");
  const s = z.enum(["picked_up", "returned", "overdue"]).safeParse(status);
  if (!s.success) return fail("Unsupported reservation status.");
  return guarded(() =>
    systemTx(async (tx) => {
      const [r] = await tx<{ status: string; gearItemId: string }[]>`
        select status, gear_item_id from public.gear_reservations where id = ${reservationId} for update`;
      if (!r) return fail("Reservation not found.");
      if (r.status === s.data) return ok(`Already ${s.data.replace("_", " ")}.`);
      if (!(RESERVATION_TRANSITIONS[r.status] ?? []).includes(s.data)) return fail(`A ${r.status.replace("_", " ")} reservation cannot become ${s.data.replace("_", " ")}.`);
      await tx`
        update public.gear_reservations set status = ${s.data},
          picked_up_at = case when ${s.data}::text = 'picked_up' then now() else picked_up_at end,
          returned_at = case when ${s.data}::text = 'returned' then now() else returned_at end
        where id = ${reservationId}`;
      const itemStatus = s.data === "returned" ? "available" : "checked_out";
      await tx`update public.gear_items set status = ${itemStatus} where id = ${r.gearItemId} and status <> 'retired'`;
      await auditInSystemTx(tx, user, "gear.reservation_status", "gear_reservation", reservationId, { from: r.status, to: s.data });
      return ok(`Reservation marked ${s.data.replace("_", " ")}.`, {
        warnings: s.data === "returned" ? ["Inspect the item; record maintenance if it needs service."] : [],
      });
    }),
  );
}
