"use server";

import type { FormState } from "@/server/admin/common";
import { revealCustomerSensitive } from "@/server/admin/customers";
import { runAction, str } from "../_lib/action";

/** Reveal restricted customer details (safety.sensitive; audited). */
export async function revealCustomerAction(customerId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("safety.sensitive", `/admin/customers/${customerId}`, (user) => revealCustomerSensitive(user, customerId, str(fd, "reason")));
}
