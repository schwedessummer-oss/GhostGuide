"use server";

import { redirect } from "next/navigation";
import type { FormState } from "@/server/admin/common";
import { approveNarration, createNarration, editNarration, rejectNarration, retireNarration, submitNarration } from "@/server/admin/content";
import { checked, runAction, str } from "../_lib/action";

const P = "/admin/content";

function contentInput(fd: FormData) {
  return { title: str(fd, "title"), transcript: str(fd, "transcript"), poiId: str(fd, "poiId"), sourceId: str(fd, "sourceId"), sourceCitation: str(fd, "sourceCitation") };
}

export async function createNarrationAction(_prev: FormState, fd: FormData): Promise<FormState> {
  const r = await runAction("trails.manage", P, (user) => createNarration(user, str(fd, "trailId"), { ...contentInput(fd), submit: checked(fd, "submit") }));
  if (r.ok && r.data) redirect(`${P}/${(r.data as { id: string }).id}`);
  return r;
}

export async function editNarrationAction(id: string, _prev: FormState, fd: FormData): Promise<FormState> {
  const r = await runAction("trails.manage", `${P}/${id}`, (user) => editNarration(user, id, contentInput(fd)));
  if (r.ok && r.data && r.data.id !== id) redirect(`${P}/${r.data.id}?revision=1`);
  return r;
}

export async function submitNarrationAction(id: string, _prev: FormState, fd: FormData): Promise<FormState> {
  void fd;
  return runAction("trails.manage", `${P}/${id}`, (user) => submitNarration(user, id));
}

export async function approveNarrationAction(id: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("content.approve", `${P}/${id}`, (user) => approveNarration(user, id, { sourceId: str(fd, "sourceId"), sourceCitation: str(fd, "sourceCitation") }));
}

export async function rejectNarrationAction(id: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("content.approve", `${P}/${id}`, (user) => rejectNarration(user, id, str(fd, "reason")));
}

export async function retireNarrationAction(id: string, _prev: FormState, fd: FormData): Promise<FormState> {
  if (!checked(fd, "confirm")) return { ok: false, error: "Tick the confirmation box to retire this narration." };
  return runAction("content.approve", `${P}/${id}`, (user) => retireNarration(user, id));
}
