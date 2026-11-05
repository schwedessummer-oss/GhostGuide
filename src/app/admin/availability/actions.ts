"use server";

import type { FormState } from "@/server/admin/common";
import { setDayInventory } from "@/server/admin/availability";
import { checked, runAction, str } from "../_lib/action";

export async function setDayAction(trailId: string, day: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("inventory.manage", "/admin/availability", (user) =>
    setDayInventory(user, trailId, { day, capacity: str(fd, "capacity"), blocked: checked(fd, "blocked"), note: str(fd, "note") }),
  );
}
