"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/server/auth";
import {
  confirmOkByUser,
  extendCheckinByUser,
  finishTripByUser,
  optOutOfCheckin,
  setupCheckin,
  type ActionResult,
} from "@/server/checkins/manage";
import { createShare, revokeShare } from "@/server/sharing/shares";

/**
 * Server actions for the check-in cards and page. Every action re-resolves
 * the user from the session, validates the trip id, and calls a use-case
 * that checks ownership (404 semantics) and validates all input with zod.
 */
/** What the customer submitted in the setup form, echoed back on an error so React's post-action form reset keeps it. */
export interface SetupFormValues {
  contactId: string;
  expectedReturn: string;
  graceMinutes: string;
  reminders: string[];
  understand: boolean;
}
export type CheckinFormState = { ok?: boolean; message?: string; error?: string; values?: SetupFormValues } | undefined;
export type ShareFormState =
  | { ok?: boolean; message?: string; error?: string; url?: string; expiresAt?: string; /** preformatted in the trail's time zone */ expiresLabel?: string }
  | undefined;

const tripIdSchema = z.uuid();

function toState(r: ActionResult): CheckinFormState {
  if (r.ok) {
    refresh();
    return { ok: true, message: r.message };
  }
  return { ok: false, error: r.notFound ? "Trip not found." : r.error };
}

async function authed(tripId: string) {
  if (!tripIdSchema.safeParse(tripId).success) return null;
  return requireUser(`/trips/${tripId}/checkin`);
}

export async function setupCheckinAction(tripId: string, _prev: CheckinFormState, formData: FormData): Promise<CheckinFormState> {
  const user = await authed(tripId);
  if (!user) return { ok: false, error: "Trip not found." };
  const values: SetupFormValues = {
    contactId: String(formData.get("contactId") ?? "").slice(0, 64),
    expectedReturn: String(formData.get("expectedReturn") ?? "").slice(0, 25),
    graceMinutes: String(formData.get("graceMinutes") ?? "").slice(0, 8),
    reminders: formData
      .getAll("reminders")
      .slice(0, 20)
      .map((v) => String(v).slice(0, 8)),
    understand: formData.get("understand") === "on",
  };
  if (!values.understand) return { ok: false, error: "Please confirm you understand how check-ins work.", values };
  const state = toState(
    await setupCheckin(user, tripId, {
      contactId: values.contactId,
      expectedReturnLocal: values.expectedReturn,
      graceMinutes: values.graceMinutes,
      reminderOffsetsMin: values.reminders,
    }),
  );
  return state?.ok ? state : { ...state, values };
}

export async function optOutAction(tripId: string, _prev: CheckinFormState, formData: FormData): Promise<CheckinFormState> {
  void formData;
  const user = await authed(tripId);
  if (!user) return { ok: false, error: "Trip not found." };
  return toState(await optOutOfCheckin(user, tripId));
}

export async function confirmOkAction(tripId: string, _prev: CheckinFormState, formData: FormData): Promise<CheckinFormState> {
  void formData;
  const user = await authed(tripId);
  if (!user) return { ok: false, error: "Trip not found." };
  return toState(await confirmOkByUser(user, tripId));
}

export async function extendAction(tripId: string, _prev: CheckinFormState, formData: FormData): Promise<CheckinFormState> {
  const user = await authed(tripId);
  if (!user) return { ok: false, error: "Trip not found." };
  const minutes = formData.get("minutes");
  const until = formData.get("until");
  const input = typeof minutes === "string" && minutes ? { minutes } : { untilLocal: typeof until === "string" ? until : "" };
  return toState(await extendCheckinByUser(user, tripId, input));
}

export async function finishAction(tripId: string, _prev: CheckinFormState, formData: FormData): Promise<CheckinFormState> {
  const user = await authed(tripId);
  if (!user) return { ok: false, error: "Trip not found." };
  if (formData.get("confirmFinish") !== "yes") return { ok: false, error: "Confirm that you're back to finish your trip." };
  return toState(await finishTripByUser(user, tripId));
}

export async function createShareAction(tripId: string, _prev: ShareFormState, formData: FormData): Promise<ShareFormState> {
  const user = await authed(tripId);
  if (!user) return { ok: false, error: "Trip not found." };
  const hours = Number(formData.get("hours"));
  const includeLastLocation = formData.get("includeLastLocation") === "on";
  const r = await createShare(user, tripId, hours, includeLastLocation);
  if (!r.ok) return { ok: false, error: r.notFound ? "Trip not found." : r.error };
  refresh();
  // The token is shown exactly once; only its hash is stored.
  return {
    ok: true,
    message: "Link created. Copy it now — for your privacy we can't show it again.",
    url: r.url,
    expiresAt: r.expiresAt.toISOString(),
    expiresLabel: r.expiresLabel,
  };
}

export async function revokeShareAction(tripId: string, _prev: ShareFormState, formData: FormData): Promise<ShareFormState> {
  const user = await authed(tripId);
  if (!user) return { ok: false, error: "Trip not found." };
  const r = await revokeShare(user, tripId, String(formData.get("shareId") ?? ""));
  if (!r.ok) return { ok: false, error: r.error };
  refresh();
  return { ok: true, message: "Link turned off. Anyone who opens it now sees “not available”." };
}
