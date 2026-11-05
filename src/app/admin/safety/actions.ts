"use server";

import type { FormState } from "@/server/admin/common";
import { revealHikeLocation } from "@/server/admin/safety";
import { runAction, str } from "../_lib/action";

/** Reveal a hike's precise last-known location (safety.sensitive; audited). */
export async function revealLocationAction(hikeSessionId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("safety.sensitive", "/admin/safety", (user) => revealHikeLocation(user, hikeSessionId, str(fd, "reason")));
}
