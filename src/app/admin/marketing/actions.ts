"use server";

import { redirect } from "next/navigation";
import type { FormState } from "@/server/admin/common";
import {
  approveMarketingDraft,
  generateMarketingDraft,
  publishMarketingDraft,
  rejectMarketingDraft,
  submitMarketingDraft,
  updateMarketingDraft,
} from "@/server/admin/marketing";
import { checked, runAction, str } from "../_lib/action";

const P = "/admin/marketing";

export async function generateDraftAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const r = await runAction("marketing.draft", P, (user) => generateMarketingDraft(user, { trailId: str(fd, "trailId"), channel: str(fd, "channel") }));
  if (r.ok && r.data) redirect(`${P}/${(r.data as { id: string }).id}?generated=1`);
  return r;
}

export async function updateDraftAction(id: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("marketing.draft", `${P}/${id}`, (user) => updateMarketingDraft(user, id, { title: str(fd, "title"), body: str(fd, "body") }));
}

export async function submitDraftAction(id: string, _prev: FormState, fd: FormData): Promise<FormState> {
  void fd;
  return runAction("marketing.draft", `${P}/${id}`, (user) => submitMarketingDraft(user, id));
}

export async function approveDraftAction(id: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("marketing.approve", `${P}/${id}`, (user) => approveMarketingDraft(user, id, checked(fd, "acknowledge")));
}

export async function rejectDraftAction(id: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("marketing.approve", `${P}/${id}`, (user) => rejectMarketingDraft(user, id, str(fd, "reason")));
}

export async function publishDraftAction(id: string, _prev: FormState, fd: FormData): Promise<FormState> {
  if (!checked(fd, "confirm")) return { ok: false, error: "Tick the confirmation box first." };
  return runAction("marketing.approve", `${P}/${id}`, (user) => publishMarketingDraft(user, id));
}
