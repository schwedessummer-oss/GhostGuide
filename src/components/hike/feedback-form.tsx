"use client";

import { useActionState } from "react";
import { Star } from "lucide-react";
import { Alert, Button, Field, Textarea } from "@/components/ui";
import type { FeedbackFormState } from "@/app/trips/[id]/complete/actions";

/** Rating (1–5), comments and issue checkboxes after a hike. */
export function FeedbackForm({
  action,
  issues,
  initial,
}: {
  action: (prev: FeedbackFormState, formData: FormData) => Promise<FeedbackFormState>;
  issues: readonly { value: string; label: string }[];
  initial: { rating: number; comments: string | null; issues: string[] } | null;
}) {
  const [state, formAction, pending] = useActionState<FeedbackFormState, FormData>(action, undefined);
  if (state?.ok) {
    return (
      <Alert tone="forest" live="polite" title="Thank you!">
        Your feedback helps us improve routes, stories and the app for everyone.
      </Alert>
    );
  }
  return (
    <form action={formAction} className="space-y-5">
      <fieldset>
        <legend className="font-semibold">How was your hike with Ghost Guide?</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <label
              key={n}
              className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center gap-1 rounded-xl border border-sand-300 px-3 has-[:checked]:border-forest-600 has-[:checked]:bg-forest-50 has-[:focus-visible]:outline has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-forest-500"
            >
              <input type="radio" name="rating" value={n} defaultChecked={initial?.rating === n} required className="sr-only" />
              <Star aria-hidden className="size-4" />
              <span>
                {n}
                <span className="sr-only"> {n === 1 ? "star (poor)" : n === 5 ? "stars (excellent)" : "stars"}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-1 text-sm text-muted">1 = poor, 5 = excellent</p>
      </fieldset>

      <fieldset>
        <legend className="font-semibold">Anything go wrong? (optional)</legend>
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          {issues.map((i) => (
            <label key={i.value} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-1">
              <input type="checkbox" name="issues" value={i.value} defaultChecked={initial?.issues.includes(i.value)} className="size-5 shrink-0 accent-forest-700" />
              <span>{i.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <Field label="Comments (optional)" htmlFor="comments" hint="Please don't include anyone's contact details or medical information.">
        <Textarea id="comments" name="comments" maxLength={4000} defaultValue={initial?.comments ?? ""} />
      </Field>

      <div aria-live="assertive">{state?.error ? <Alert tone="red">{state.error}</Alert> : null}</div>
      <Button type="submit" size="lg" disabled={pending}>
        {pending ? "Sending…" : initial ? "Update feedback" : "Send feedback"}
      </Button>
    </form>
  );
}
