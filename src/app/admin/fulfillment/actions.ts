"use server";

import type { FormState } from "@/server/admin/common";
import { staffRetryFulfillment, staffSetFulfillmentStatus, type StaffActionResult } from "@/server/commerce/staff-actions";
import { runAction, str } from "../_lib/action";

const asForm = (r: StaffActionResult) => (r.ok ? { ok: true as const, message: r.message ?? "Done." } : { ok: false as const, error: r.error });

export async function retryFulfillmentAction(fulfillmentId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  void fd;
  return runAction("fulfillment.manage", "/admin/fulfillment", async (user) => asForm(await staffRetryFulfillment(user, fulfillmentId)));
}

export async function setFulfillmentStatusAction(fulfillmentId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const status = str(fd, "status");
  if (!["confirmed", "completed", "cancelled", "failed"].includes(status)) return { ok: false, error: "Choose a status." };
  return runAction("fulfillment.manage", "/admin/fulfillment", async (user) =>
    asForm(await staffSetFulfillmentStatus(user, fulfillmentId, status as "confirmed" | "completed" | "cancelled" | "failed", str(fd, "note"))),
  );
}
