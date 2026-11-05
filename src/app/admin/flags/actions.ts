"use server";

import type { FormState } from "@/server/admin/common";
import { setFlag } from "@/server/admin/feature-flags";
import { runAction } from "../_lib/action";

export async function setFlagAction(key: string, enabled: boolean, _prev: FormState, fd: FormData): Promise<FormState> {
  void fd;
  return runAction("flags.manage", "/admin/flags", (user) => setFlag(user, key, enabled));
}
