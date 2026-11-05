"use server";

import type { FormState } from "@/server/admin/common";
import { cancelJobAsStaff, retryJobAsStaff } from "@/server/admin/jobs";
import { runDueJobsNow } from "@/server/admin/run-jobs";
import { runAction } from "../_lib/action";

export async function retryJobAction(jobId: number, _prev: FormState, fd: FormData): Promise<FormState> {
  void fd;
  return runAction("jobs.manage", "/admin/jobs", (user) => retryJobAsStaff(user, jobId));
}

export async function cancelJobAction(jobId: number, _prev: FormState, fd: FormData): Promise<FormState> {
  if (fd.get("confirm") !== "on") return { ok: false, error: "Tick the confirmation box to cancel this job." };
  return runAction("jobs.manage", "/admin/jobs", (user) => cancelJobAsStaff(user, jobId));
}

/** Demo mode only (the use-case refuses in live mode). */
export async function runDueJobsAction(_prev: FormState, fd: FormData): Promise<FormState> {
  void fd;
  return runAction("jobs.manage", "/admin/jobs", (user) => runDueJobsNow(user));
}
