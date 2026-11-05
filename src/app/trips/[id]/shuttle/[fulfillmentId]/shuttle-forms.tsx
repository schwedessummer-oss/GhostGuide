"use client";

import { useActionState } from "react";
import { Alert, Button, Field, Select } from "@/components/ui";
import { confirmShuttleAction, requoteShuttleAction, type ShuttleFormState } from "./actions";

export function ConfirmShuttleForm({
  tripId,
  fulfillmentId,
  quotedPriceCents,
  pickupAt,
  summary,
}: {
  tripId: string;
  fulfillmentId: string;
  quotedPriceCents: number;
  pickupAt: string;
  summary: string;
}) {
  const [state, action, pending] = useActionState<ShuttleFormState, FormData>(confirmShuttleAction.bind(null, tripId, fulfillmentId), undefined);
  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="quotedPriceCents" value={quotedPriceCents} />
      <input type="hidden" name="pickupAt" value={pickupAt} />
      <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-sand-300 p-3 has-[:checked]:border-forest-600 has-[:checked]:bg-forest-50">
        <input type="checkbox" name="confirmPickup" required className="mt-1 size-5 accent-forest-700" aria-describedby="confirm-summary" />
        <span>
          <span className="font-semibold">I confirm the pickup location, pickup time and price.</span>
          <span id="confirm-summary" className="block text-sm text-muted">
            {summary}
          </span>
        </span>
      </label>
      <div aria-live="assertive">{state?.error ? <Alert tone="red">{state.error}</Alert> : null}</div>
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Sending to the shuttle partner…" : "Confirm and request ride"}
      </Button>
    </form>
  );
}

export function RequoteForm({
  tripId,
  fulfillmentId,
  pickupPoints,
  currentPickup,
  primary,
}: {
  tripId: string;
  fulfillmentId: string;
  pickupPoints: { key: string; label: string }[];
  currentPickup: string | null;
  primary: boolean;
}) {
  const [state, action, pending] = useActionState<ShuttleFormState, FormData>(requoteShuttleAction.bind(null, tripId, fulfillmentId), undefined);
  return (
    <form action={action} className="space-y-3">
      <Field label="Pickup point" htmlFor="pickup">
        <Select id="pickup" name="pickup" defaultValue={currentPickup ?? pickupPoints[0]?.key}>
          {pickupPoints.map((p) => (
            <option key={p.key} value={p.key}>
              {p.label}
            </option>
          ))}
        </Select>
      </Field>
      <Button type="submit" variant={primary ? "primary" : "secondary"} disabled={pending}>
        {pending ? "Requesting quote…" : "Request a new quote"}
      </Button>
      <div aria-live="polite">
        {state?.message ? <Alert tone="forest">{state.message}</Alert> : null}
        {state?.error ? <Alert tone="red">{state.error}</Alert> : null}
      </div>
    </form>
  );
}
