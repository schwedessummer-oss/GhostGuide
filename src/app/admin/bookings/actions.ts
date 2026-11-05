"use server";

import { z } from "zod";
import type { FormState } from "@/server/admin/common";
import { staffCancelBooking, staffRefundBooking, type StaffActionResult } from "@/server/commerce/staff-actions";
import { checked, runAction, str } from "../_lib/action";

/** Commerce implements the cancel/refund contract (permission check, row locks, audit, idempotency); we call it and show the result. */
const asForm = (r: StaffActionResult) => (r.ok ? { ok: true as const, message: r.message ?? "Done." } : { ok: false as const, error: r.error });

export async function cancelBookingAction(bookingId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  if (!checked(fd, "confirm")) return { ok: false, error: "Tick the confirmation box to cancel this booking." };
  return runAction("bookings.cancel", `/admin/bookings/${bookingId}`, async (user) => asForm(await staffCancelBooking(user, bookingId, str(fd, "reason"))));
}

const dollars = z.coerce.number().positive("Enter an amount greater than 0.").max(100_000).transform((v) => Math.round(v * 100));

export async function refundBookingAction(bookingId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const amount = dollars.safeParse(str(fd, "amount"));
  if (!amount.success) return { ok: false, error: amount.error.issues[0].message };
  if (!checked(fd, "confirm")) return { ok: false, error: "Tick the confirmation box to issue this refund." };
  return runAction("bookings.refund", `/admin/bookings/${bookingId}`, async (user) => asForm(await staffRefundBooking(user, bookingId, amount.data, str(fd, "reason"))));
}
