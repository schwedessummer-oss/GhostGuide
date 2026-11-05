"use server";

import type { FormState } from "@/server/admin/common";
import { recordMaintenance, setLockerStatus, setReservationStatus, updateGearItem } from "@/server/admin/gear";
import { runAction, str } from "../_lib/action";

const P = "/admin/gear";

export async function setLockerStatusAction(lockerId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("gear.manage", P, (user) => setLockerStatus(user, lockerId, str(fd, "status")));
}

export async function updateGearItemAction(itemId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("gear.manage", P, (user) => updateGearItem(user, itemId, { status: str(fd, "status") as never, conditionNotes: str(fd, "conditionNotes") }));
}

export async function recordMaintenanceAction(itemId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("gear.manage", P, (user) => recordMaintenance(user, itemId, str(fd, "notes")));
}

export async function setReservationStatusAction(reservationId: string, status: string, _prev: FormState, fd: FormData): Promise<FormState> {
  void fd;
  return runAction("gear.manage", P, (user) => setReservationStatus(user, reservationId, status));
}
