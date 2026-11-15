"use client";

import { useActionState } from "react";
import { Button, Field, Input, Radio } from "@/components/ui";
import { updateProfileAction } from "@/app/account/actions";
import { echoed, errorProps, FormResult, type AccountFormState } from "./form-result";

export function ProfileForm({ fullName, units }: { fullName: string; units: "imperial" | "metric" }) {
  const [state, action, pending] = useActionState<AccountFormState, FormData>(updateProfileAction, undefined);
  // After a rejected submit, keep what the customer typed (React resets forms to their defaults).
  const shownUnits = echoed(state, "units") ?? units;
  return (
    <form action={action} className="space-y-5" noValidate>
      <Field label="Full name" htmlFor="profile-name" error={state?.fieldErrors?.fullName} required>
        <Input id="profile-name" name="fullName" autoComplete="name" required maxLength={120} defaultValue={echoed(state, "fullName") ?? fullName} {...errorProps("profile-name", state, "fullName")} />
      </Field>
      <fieldset className="space-y-2">
        <legend className="font-semibold">Units</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <Radio name="units" value="imperial" label="Imperial" description="Miles and feet" defaultChecked={shownUnits === "imperial"} />
          <Radio name="units" value="metric" label="Metric" description="Kilometres and metres" defaultChecked={shownUnits === "metric"} />
        </div>
        {state?.fieldErrors?.units ? <p className="text-sm font-semibold text-red-ink">{state.fieldErrors.units}</p> : null}
      </fieldset>
      <FormResult state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save profile"}
      </Button>
    </form>
  );
}
