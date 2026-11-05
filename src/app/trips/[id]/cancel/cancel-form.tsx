"use client";

import { useActionState } from "react";
import { Alert, Button } from "@/components/ui";
import { cancelTripAction, type CancelFormState } from "./actions";

export function CancelForm({ tripId, buttonLabel, acknowledgement }: { tripId: string; buttonLabel: string; acknowledgement: string }) {
  const [state, action, pending] = useActionState<CancelFormState, FormData>(cancelTripAction.bind(null, tripId), undefined);
  return (
    <form action={action} className="space-y-4">
      <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-sand-300 p-3">
        <input type="checkbox" name="acknowledge" required className="mt-1 size-5 accent-forest-700" />
        <span>{acknowledgement}</span>
      </label>
      <div aria-live="assertive">{state?.error ? <Alert tone="red">{state.error}</Alert> : null}</div>
      <Button type="submit" variant="danger" size="lg" disabled={pending}>
        {pending ? "Cancelling…" : buttonLabel}
      </Button>
    </form>
  );
}
