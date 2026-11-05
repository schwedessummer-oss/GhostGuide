"use client";

import { useActionState } from "react";
import { Alert, Button } from "@/components/ui";
import { redeliverWebhookAction, simulatePaymentAction, type DemoActionState } from "./actions";

export function DemoPaymentControls({ sessionId, open, canRedeliver }: { sessionId: string; open: boolean; canRedeliver: boolean }) {
  const [payState, payAction, paying] = useActionState<DemoActionState, FormData>(simulatePaymentAction.bind(null, sessionId), undefined);
  const [redeliverState, redeliverAction, redelivering] = useActionState<DemoActionState, FormData>(
    redeliverWebhookAction.bind(null, sessionId),
    undefined,
  );
  return (
    <div className="space-y-6">
      {open ? (
        <form action={payAction} className="space-y-3">
          <p className="text-sm text-muted">Choose what the simulated payment provider should do. Nothing is charged in any case.</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <Button type="submit" name="outcome" value="paid" size="lg" disabled={paying}>
              Simulate successful payment
            </Button>
            <Button type="submit" name="outcome" value="declined" size="lg" variant="secondary" disabled={paying}>
              Simulate declined payment
            </Button>
            <Button type="submit" name="outcome" value="cancelled" size="lg" variant="ghost" disabled={paying}>
              Cancel and return
            </Button>
          </div>
          <div aria-live="polite">
            {paying ? <p className="text-sm text-muted">Sending the simulated provider event…</p> : null}
            {payState?.error ? (
              <Alert tone="red" live="assertive">
                {payState.error}
              </Alert>
            ) : null}
          </div>
        </form>
      ) : null}

      <form action={redeliverAction} className="space-y-3 rounded-xl border border-dashed border-sand-300 p-4">
        <p className="font-semibold">Testing: duplicate webhook delivery</p>
        <p className="text-sm text-muted">
          Real payment providers sometimes deliver the same event more than once. Re-send the last event to see that Ghost Guide processes it only
          once.
        </p>
        <Button type="submit" variant="secondary" disabled={!canRedeliver || redelivering}>
          {redelivering ? "Re-delivering…" : "Re-deliver last webhook"}
        </Button>
        {!canRedeliver ? <p className="text-sm text-muted">Available after a payment outcome has been sent.</p> : null}
        <div aria-live="polite">
          {redeliverState?.message ? <Alert tone="forest">{redeliverState.message}</Alert> : null}
          {redeliverState?.error ? <Alert tone="red">{redeliverState.error}</Alert> : null}
        </div>
      </form>
    </div>
  );
}
