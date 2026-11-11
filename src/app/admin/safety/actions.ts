"use server";

import type { FormState } from "@/server/admin/common";
import { recordStaffCheckinFollowUp, revealHikeLocation } from "@/server/admin/safety";
import { runAction, str } from "../_lib/action";

/** Reveal a hike's precise last-known location (safety.sensitive; audited). */
export async function revealLocationAction(hikeSessionId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("safety.sensitive", "/admin/safety", (user) => revealHikeLocation(user, hikeSessionId, str(fd, "reason")));
}

/** Add a staff note to a check-in, or close it because the hiker is confirmed safe (trips.monitor; audited). */
export async function staffFollowUpAction(checkinId: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("trips.monitor", "/admin/safety", (user) =>
    recordStaffCheckinFollowUp(user, checkinId, { outcome: str(fd, "outcome") as never, note: str(fd, "note") }),
  );
}
