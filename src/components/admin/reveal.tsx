"use client";

import { useActionState, useId } from "react";
import { Button } from "@/components/ui";
import { FormResult, type AdminFormState } from "./action-form";

/*
 * "Break-glass" reveal of restricted data (emergency contacts, precise
 * location). The server action checks safety.sensitive, requires a reason
 * and writes an audit entry before returning anything.
 */
type Revealed =
  | {
      contacts?: { name: string; phone: string | null; email: string | null; relationship: string | null; consentConfirmedAt: string | Date | null }[];
      locations?: { hikeSessionId: string; lat: number; lng: number; accuracyM: number | null; recordedAt: string | Date }[];
      phone?: string | null;
    }
  | { lat: number; lng: number; accuracyM: number | null; recordedAt: string | Date; receivedAt?: string | Date }
  | null;

const fmt = (d: string | Date) => new Date(d).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
const age = (d: string | Date) => {
  const m = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  return m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

function Location({ lat, lng, accuracyM, recordedAt }: { lat: number; lng: number; accuracyM: number | null; recordedAt: string | Date }) {
  return (
    <p>
      <span className="font-mono">
        {lat.toFixed(5)}, {lng.toFixed(5)}
      </span>
      {accuracyM ? <span> (±{Math.round(accuracyM)} m)</span> : null}
      <span className="block text-sm text-muted">
        Recorded {fmt(recordedAt)} ({age(recordedAt)}). Last known position only — it may be out of date.
      </span>
    </p>
  );
}

function RevealedView({ data }: { data: Revealed }) {
  if (!data) return <p className="text-sm text-muted">Nothing recorded.</p>;
  if ("lat" in data) return <Location {...data} />;
  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-semibold">Customer phone</p>
        <p>{data.phone || "Not on file"}</p>
      </div>
      <div>
        <p className="text-sm font-semibold">Emergency contacts</p>
        {data.contacts?.length ? (
          <ul className="space-y-1">
            {data.contacts.map((c, i) => (
              <li key={i}>
                {c.name}
                {c.relationship ? ` (${c.relationship})` : ""} — {c.phone ?? "no phone"} · {c.email ?? "no email"} ·{" "}
                {c.consentConfirmedAt ? "consent attested" : "consent NOT attested"}
              </li>
            ))}
          </ul>
        ) : (
          <p>None</p>
        )}
      </div>
      <div>
        <p className="text-sm font-semibold">Last known locations (active hikes)</p>
        {data.locations?.length ? data.locations.map((l) => <Location key={l.hikeSessionId} {...l} />) : <p>No active hike with a location.</p>}
      </div>
    </div>
  );
}

export function RevealSensitive({
  action,
  buttonLabel,
  description,
}: {
  action: (state: AdminFormState, formData: FormData) => Promise<AdminFormState>;
  buttonLabel: string;
  description: string;
}) {
  const id = useId();
  const [state, formAction, pending] = useActionState<AdminFormState, FormData>(action, undefined);
  return (
    <div className="space-y-3">
      <form action={formAction} className="space-y-2">
        <p className="text-sm text-muted">{description}</p>
        <label htmlFor={`${id}-reason`} className="block text-sm font-semibold">
          Reason for access (recorded in the audit log)
        </label>
        <input
          id={`${id}-reason`}
          name="reason"
          required
          minLength={3}
          maxLength={300}
          className="block w-full min-h-11 rounded-xl border border-sand-300 bg-surface px-3 py-2"
          placeholder="e.g. Overdue check-in follow-up"
        />
        <Button type="submit" variant="secondary" disabled={pending}>
          {pending ? "Checking access…" : buttonLabel}
        </Button>
      </form>
      <FormResult state={state} compact />
      {state?.ok ? (
        <div className="rounded-xl border border-sand-300 bg-sand-100 p-3" aria-live="polite">
          <RevealedView data={(state.data ?? null) as Revealed} />
        </div>
      ) : null}
    </div>
  );
}
