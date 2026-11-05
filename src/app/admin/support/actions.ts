"use server";

import type { FormState } from "@/server/admin/common";
import { updateTicket } from "@/server/admin/support";
import { runAction, str } from "../_lib/action";

export async function updateTicketAction(ticketId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("support.manage", "/admin/support", (user) =>
    updateTicket(user, ticketId, { status: str(fd, "status") as never, priority: str(fd, "priority") as never, assignedTo: str(fd, "assignedTo") }),
  );
}
