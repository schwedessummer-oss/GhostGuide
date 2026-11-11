"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { CheckCircle2, Clock, Flag } from "lucide-react";
import { Alert, Button, Input } from "@/components/ui";
import { EXTEND_PRESETS_MIN } from "@/domain/checkin";
import { confirmOkAction, extendAction, finishAction, optOutAction, type CheckinFormState } from "./actions";

function Result({ state }: { state: CheckinFormState }) {
  if (state?.error) return <Alert tone="red">{state.error}</Alert>;
  if (state?.ok && state.message) return <Alert tone="forest">{state.message}</Alert>;
  return null;
}

/**
 * "I'm okay", "Extend my trip" and "Finish trip". Finishing asks for a
 * second confirmation so an accidental tap can't silently end check-ins
 * mid-hike.
 */
export function CheckinQuickActions({
  tripId,
  minExtendLocal,
  tzLabel,
  compact = false,
}: {
  tripId: string;
  /** datetime-local value for the "pick a time" input's minimum */
  minExtendLocal: string;
  /** DST-neutral zone name, e.g. "Pacific Time" */
  tzLabel: string;
  compact?: boolean;
}) {
  const [okState, okAction, okPending] = useActionState<CheckinFormState, FormData>(confirmOkAction.bind(null, tripId), undefined);
  const [extState, extAction, extPending] = useActionState<CheckinFormState, FormData>(extendAction.bind(null, tripId), undefined);
  const [finState, finAction, finPending] = useActionState<CheckinFormState, FormData>(finishAction.bind(null, tripId), undefined);
  const [confirmingFinish, setConfirmingFinish] = useState(false);
  const pickId = `extend-until-${tripId.slice(0, 8)}${compact ? "-c" : ""}`;
  const finishQuestionId = `finish-question-${tripId.slice(0, 8)}${compact ? "-c" : ""}`;
  // Keyboard / screen-reader users keep their place: the question gets focus
  // when the confirmation opens (not "Yes", so a double Enter can't finish the
  // trip by accident), and the trigger gets it back on "Not yet".
  const finishTriggerRef = useRef<HTMLButtonElement>(null);
  const finishQuestionRef = useRef<HTMLParagraphElement>(null);
  const finishToggled = useRef(false);
  useEffect(() => {
    if (!finishToggled.current) return;
    if (confirmingFinish) finishQuestionRef.current?.focus();
    else finishTriggerRef.current?.focus();
  }, [confirmingFinish]);
  const toggleFinish = (open: boolean) => {
    finishToggled.current = true;
    setConfirmingFinish(open);
  };

  return (
    <div className="space-y-4">
      <form action={okAction}>
        <Button type="submit" size="lg" className="w-full" disabled={okPending}>
          <CheckCircle2 aria-hidden className="size-5" />
          {okPending ? "Sending…" : "I'm okay"}
        </Button>
      </form>
      <div aria-live="polite" role="status">
        <Result state={okState} />
      </div>

      <div>
        <p className="flex items-center gap-2 font-semibold" id={`extend-label-${tripId.slice(0, 8)}${compact ? "-c" : ""}`}>
          <Clock aria-hidden className="size-4" /> Extend my trip
        </p>
        <form action={extAction} className="mt-2 grid grid-cols-3 gap-2" aria-labelledby={`extend-label-${tripId.slice(0, 8)}${compact ? "-c" : ""}`}>
          {EXTEND_PRESETS_MIN.map((m) => (
            <Button key={m} type="submit" name="minutes" value={String(m)} variant="secondary" disabled={extPending}>
              +{m < 60 ? `${m} min` : `${m / 60} h`}
            </Button>
          ))}
        </form>
        <details className="mt-2 rounded-xl border border-sand-200 p-3">
          <summary className="min-h-11 cursor-pointer content-center font-semibold text-forest-800">Pick a new return time</summary>
          <form action={extAction} className="mt-2 space-y-2">
            <label htmlFor={pickId} className="block text-sm font-semibold">
              New expected return ({tzLabel || "region time"})
            </label>
            <Input id={pickId} name="until" type="datetime-local" required min={minExtendLocal} />
            <Button type="submit" variant="secondary" disabled={extPending} className="w-full">
              {extPending ? "Saving…" : "Set new return time"}
            </Button>
          </form>
        </details>
        <div aria-live="polite" role="status" className="mt-2">
          <Result state={extState} />
        </div>
      </div>

      <div>
        {!confirmingFinish ? (
          <Button ref={finishTriggerRef} type="button" variant="secondary" className="w-full" onClick={() => toggleFinish(true)}>
            <Flag aria-hidden className="size-4" /> Finish trip
          </Button>
        ) : (
          <form action={finAction} className="space-y-2 rounded-xl border border-forest-200 bg-forest-50 p-3" aria-labelledby={finishQuestionId}>
            <p id={finishQuestionId} ref={finishQuestionRef} tabIndex={-1} className="font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-forest-600">
              Are you back from your hike?
            </p>
            <p className="text-sm">Finishing ends your hike and check-ins for this trip: no more reminders or notices will be sent.</p>
            <input type="hidden" name="confirmFinish" value="yes" />
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button type="submit" disabled={finPending} className="flex-1">
                {finPending ? "Finishing…" : "Yes, I'm back — finish trip"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => toggleFinish(false)} className="flex-1">
                Not yet
              </Button>
            </div>
          </form>
        )}
        <div aria-live="polite" role="status" className="mt-2">
          <Result state={finState} />
        </div>
      </div>
    </div>
  );
}

/** "Turn off check-ins" (only offered while awaiting, never while a notice is pending). */
export function CheckinOptOutForm({ tripId }: { tripId: string }) {
  const [state, action, pending] = useActionState<CheckinFormState, FormData>(optOutAction.bind(null, tripId), undefined);
  return (
    <form action={action} className="space-y-2">
      <p className="text-sm text-muted">Turning check-ins off cancels all reminders and notices for this trip. You can turn them on again later.</p>
      <Button type="submit" variant="ghost" disabled={pending}>
        {pending ? "Turning off…" : "Turn off check-ins for this trip"}
      </Button>
      <div aria-live="polite" role="status">
        <Result state={state} />
      </div>
    </form>
  );
}
