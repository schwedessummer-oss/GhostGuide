"use client";

import { useActionState } from "react";
import { Button, Field, Input, Select } from "@/components/ui";
import type { PermitFormState } from "@/app/trips/[id]/prepare/actions";

const LABELS: Record<string, string> = {
  not_started: "Not started",
  applied: "Applied — waiting",
  obtained: "Obtained",
  denied: "Denied",
  not_required: "Not required for my group",
};

/** Track your own permit status (you apply on the official site; Ghost Guide never applies for you). */
export function PermitStatusForm({
  action,
  permitRequirementId,
  status,
  confirmationRef,
}: {
  action: (prev: PermitFormState, formData: FormData) => Promise<PermitFormState>;
  permitRequirementId: string;
  status: string;
  confirmationRef: string | null;
}) {
  const [state, formAction, pending] = useActionState<PermitFormState, FormData>(action, undefined);
  const id = permitRequirementId.slice(0, 8);
  return (
    <form action={formAction} className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <input type="hidden" name="permitRequirementId" value={permitRequirementId} />
      <Field label="My permit status" htmlFor={`permit-status-${id}`}>
        <Select id={`permit-status-${id}`} name="status" defaultValue={status}>
          {Object.entries(LABELS).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Confirmation number (optional)" htmlFor={`permit-ref-${id}`}>
        <Input id={`permit-ref-${id}`} name="confirmationRef" defaultValue={confirmationRef ?? ""} maxLength={120} autoComplete="off" />
      </Field>
      <Button type="submit" variant="secondary" disabled={pending}>
        {pending ? "Saving…" : "Save"}
      </Button>
      <p aria-live="polite" className="text-sm sm:col-span-3">
        {state?.error ? <span className="font-semibold text-red-ink">{state.error}</span> : state?.message}
      </p>
    </form>
  );
}
