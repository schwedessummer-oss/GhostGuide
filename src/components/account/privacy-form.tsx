"use client";

import { useActionState } from "react";
import { Button, Field, Input } from "@/components/ui";
import { deleteLocationHistoryAction, updatePrivacyAction } from "@/app/account/actions";
import { errorProps, FormResult, type AccountFormState } from "./form-result";

export function PrivacyForm({ retentionDays, shareLocation }: { retentionDays: number; shareLocation: boolean }) {
  const [state, action, pending] = useActionState<AccountFormState, FormData>(updatePrivacyAction, undefined);
  return (
    <form action={action} className="space-y-5" noValidate>
      <Field
        label="Keep my precise location history for (days)"
        htmlFor="privacy-retention"
        hint="Between 1 and 365 days. Older points are deleted automatically every day."
        error={state?.fieldErrors?.locationRetentionDays}
        required
      >
        <Input
          id="privacy-retention"
          name="locationRetentionDays"
          type="number"
          inputMode="numeric"
          min={1}
          max={365}
          step={1}
          required
          defaultValue={retentionDays}
          className="max-w-40"
          {...errorProps("privacy-retention", state, "locationRetentionDays", true)}
        />
      </Field>
      <label className="flex min-h-11 cursor-pointer items-start gap-3" htmlFor="privacy-share">
        <input
          id="privacy-share"
          type="checkbox"
          name="shareLocationWithContacts"
          defaultChecked={shareLocation}
          className="mt-1 size-5 shrink-0 accent-forest-700"
          aria-describedby="privacy-share-hint"
        />
        <span>
          <span className="block font-semibold">Include my last reported location in check-in notices</span>
          <span id="privacy-share-hint" className="block text-sm text-muted">
            If we haven&apos;t heard from you, your contact&apos;s notice includes your last reported coordinates, when they were recorded and how accurate
            they were. If off, the notice says no location has been reported.
          </span>
        </span>
      </label>
      <FormResult state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save privacy settings"}
      </Button>
    </form>
  );
}

export function DeleteLocationHistoryForm({ hasData }: { hasData: boolean }) {
  const [state, action, pending] = useActionState<AccountFormState, FormData>(deleteLocationHistoryAction, undefined);
  return (
    <form action={action} className="space-y-3">
      <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-sand-300 p-3">
        <input type="checkbox" name="confirmDelete" required className="mt-1 size-5 shrink-0 accent-forest-700" />
        <span>
          I understand this permanently deletes all my stored location points and last-known locations. If I&apos;m on a hike with check-ins on, a notice
          to my contact will say no location has been reported until my phone sends a new one.
        </span>
      </label>
      <FormResult state={state} />
      <Button type="submit" variant="danger" disabled={pending || !hasData}>
        {pending ? "Deleting…" : hasData ? "Delete my location history now" : "No location history stored"}
      </Button>
    </form>
  );
}
