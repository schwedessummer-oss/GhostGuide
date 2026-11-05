"use client";

import Link from "next/link";
import { useActionState } from "react";
import { Alert, Button, Field, Input, Select } from "@/components/ui";
import { REMINDER_OFFSET_CHOICES } from "@/domain/checkin";
import { setupCheckinAction, type CheckinFormState } from "./actions";
import { CHECKIN_EXPLANATION, GRACE_CHOICES, minutesLabel } from "./copy";

export interface SetupContactOption {
  id: string;
  name: string;
  relationship: string | null;
  reach: string;
}

export interface SetupFormProps {
  tripId: string;
  mode: "create" | "update";
  contacts: SetupContactOption[];
  /** contacts saved without consent (cannot be selected) */
  contactsNeedingConsent: string[];
  selectedContactId: string | null;
  expectedReturnLocal: string;
  /** e.g. "PST" */
  tzAbbrev: string;
  graceMinutes: number;
  reminderOffsetsMin: number[];
}

/** Opt-in / update form for trip check-ins. All values are re-validated on the server. */
export function CheckinSetupForm(props: SetupFormProps) {
  const [state, action, pending] = useActionState<CheckinFormState, FormData>(setupCheckinAction.bind(null, props.tripId), undefined);
  const idp = `checkin-${props.mode}-${props.tripId.slice(0, 8)}`;
  const graceChoices = (GRACE_CHOICES as readonly number[]).includes(props.graceMinutes)
    ? [...GRACE_CHOICES]
    : [...GRACE_CHOICES, props.graceMinutes].sort((a, b) => a - b);
  const reminderChoices = [...new Set([...REMINDER_OFFSET_CHOICES, ...props.reminderOffsetsMin])].sort((a, b) => b - a);
  const addContactHref = `/account/emergency-contacts?trip=${props.tripId}`;

  if (!props.contacts.length) {
    return (
      <div className="space-y-3">
        <Alert tone="amber" title="Add an emergency contact first">
          Check-ins need someone who has agreed to receive a notice if we don&apos;t hear from you.
          {props.contactsNeedingConsent.length ? (
            <> You have {props.contactsNeedingConsent.length === 1 ? "a contact" : "contacts"} saved without consent ({props.contactsNeedingConsent.join(", ")}) — confirm their consent to use them.</>
          ) : null}
        </Alert>
        <Link href={addContactHref} className="inline-flex min-h-11 items-center font-semibold text-forest-800 underline">
          Add or update an emergency contact
        </Link>
      </div>
    );
  }

  return (
    <form action={action} className="space-y-5" aria-describedby={`${idp}-explain`}>
      <fieldset className="space-y-2">
        <legend className="font-semibold text-ink">Who should we notify?</legend>
        <p className="text-sm text-muted">Only contacts who agreed to receive notices can be chosen.</p>
        {props.contacts.map((c, i) => (
          <label
            key={c.id}
            className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-sand-200 bg-surface p-3 has-[:checked]:border-forest-600 has-[:checked]:bg-forest-50"
          >
            <input
              type="radio"
              name="contactId"
              value={c.id}
              required
              defaultChecked={props.selectedContactId ? props.selectedContactId === c.id : i === 0}
              className="mt-1 size-5 accent-forest-700"
            />
            <span>
              <span className="block font-semibold">
                {c.name}
                {c.relationship ? <span className="font-normal text-muted"> · {c.relationship}</span> : null}
              </span>
              <span className="block text-sm text-muted">{c.reach}</span>
            </span>
          </label>
        ))}
        <Link href={addContactHref} className="inline-flex min-h-11 items-center text-sm font-semibold text-forest-800 underline">
          Add a different contact
        </Link>
      </fieldset>

      <Field label={`Expected return (${props.tzAbbrev || "region time"})`} htmlFor={`${idp}-return`} hint="When you expect to be back at the trailhead. Times are in the trail's local time zone." required>
        <Input id={`${idp}-return`} name="expectedReturn" type="datetime-local" required defaultValue={props.expectedReturnLocal} aria-describedby={`${idp}-return-hint`} />
      </Field>

      <Field label="Grace period" htmlFor={`${idp}-grace`} hint="Extra time after your expected return before we send your contact a notice." required>
        <Select id={`${idp}-grace`} name="graceMinutes" defaultValue={String(props.graceMinutes)} aria-describedby={`${idp}-grace-hint`}>
          {graceChoices.map((g) => (
            <option key={g} value={g}>
              {minutesLabel(g)}
            </option>
          ))}
        </Select>
      </Field>

      <fieldset className="space-y-1">
        <legend className="font-semibold text-ink">Remind me before my expected return</legend>
        <p className="text-sm text-muted">Reminders go to your phone number or email on file. They&apos;re general reminders, not advice.</p>
        <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-3">
          {reminderChoices.map((o) => (
            <label key={o} className="flex min-h-11 cursor-pointer items-center gap-3 px-1">
              <input type="checkbox" name="reminders" value={o} defaultChecked={props.reminderOffsetsMin.includes(o)} className="size-5 accent-forest-700" />
              <span>{o < 60 ? `${o} min` : minutesLabel(o)} before</span>
            </label>
          ))}
        </div>
      </fieldset>

      <div id={`${idp}-explain`} className="rounded-xl border border-sand-200 bg-sand-100 p-4 text-[0.95rem]">
        <p className="font-semibold">How check-ins work</p>
        <p className="mt-1">{CHECKIN_EXPLANATION}</p>
        <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3">
          <input type="checkbox" name="understand" required className="mt-1 size-5 accent-forest-700" />
          <span>I understand. Ghost Guide only sends a notice to my contact; it does not monitor me or contact emergency services.</span>
        </label>
      </div>

      <div aria-live="polite" role="status">
        {state?.error ? <Alert tone="red">{state.error}</Alert> : null}
        {state?.ok && state.message ? <Alert tone="forest">{state.message}</Alert> : null}
      </div>

      <Button type="submit" size="lg" disabled={pending} className="w-full sm:w-auto">
        {pending ? "Saving…" : props.mode === "update" ? "Save check-in details" : "Turn on check-ins"}
      </Button>
    </form>
  );
}
