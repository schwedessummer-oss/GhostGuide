"use server";

import type { FormState } from "@/server/admin/common";
import { queuePermitReminders, updateTripPermit } from "@/server/admin/permits";
import { runAction, str } from "../_lib/action";

export async function updateTripPermitAction(tripId: string, permitRequirementId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("permits.manage", "/admin/permits", (user) =>
    updateTripPermit(user, tripId, permitRequirementId, { status: str(fd, "status") as never, confirmationRef: str(fd, "confirmationRef"), notes: str(fd, "notes") }),
  );
}

export async function queueRemindersAction(_prev: FormState, fd: FormData): Promise<FormState> {
  void fd;
  return runAction("permits.manage", "/admin/permits", (user) => queuePermitReminders(user));
}
