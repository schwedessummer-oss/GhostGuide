"use client";

import { useActionState } from "react";
import { Alert, Button } from "@/components/ui";
import { releaseCheckoutAction, type ReleaseFormState } from "./actions";

/** "Release these spots and change details" for a held, unpaid checkout. */
export function ReleaseCheckoutForm({ tripId, bookingId }: { tripId: string; bookingId: string }) {
  const [state, action, pending] = useActionState<ReleaseFormState, FormData>(releaseCheckoutAction.bind(null, tripId, bookingId), undefined);
  return (
    <form action={action} className="space-y-3">
      <Button type="submit" variant="secondary" size="lg" disabled={pending} aria-describedby="release-hint">
        {pending ? "Releasing…" : "Release these spots and change details"}
      </Button>
      <p id="release-hint" className="text-sm text-muted">
        Releasing cancels this unpaid checkout and frees the held spots. Nothing has been charged. You can then choose a new date, group size or
        add-ons.
      </p>
      <div aria-live="polite">
        {state?.error ? (
          <Alert tone="red" live="assertive">
            {state.error}
          </Alert>
        ) : null}
      </div>
    </form>
  );
}
