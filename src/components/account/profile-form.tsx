"use client";

import { useActionState } from "react";
import { Button, Field, Input, Radio } from "@/components/ui";
import { updateProfileAction } from "@/app/account/actions";
import { errorProps, FormResult, type AccountFormState } from "./form-result";

export function ProfileForm({ fullName, phone, units }: { fullName: string; phone: string; units: "imperial" | "metric" }) {
  const [state, action, pending] = useActionState<AccountFormState, FormData>(updateProfileAction, undefined);
  return (
    <form action={action} className="space-y-5" noValidate>
      <Field label="Full name" htmlFor="profile-name" error={state?.fieldErrors?.fullName} required>
        <Input id="profile-name" name="fullName" autoComplete="name" required maxLength={120} defaultValue={fullName} {...errorProps("profile-name", state, "fullName")} />
      </Field>
      <Field
        label="Mobile phone"
        htmlFor="profile-phone"
        hint="Optional. Used only for your own check-in reminders and notices (text message). Include your country code."
        error={state?.fieldErrors?.phone}
      >
        <Input id="profile-phone" name="phone" type="tel" autoComplete="tel" inputMode="tel" maxLength={32} defaultValue={phone} placeholder="+1 555 555 0123" {...errorProps("profile-phone", state, "phone", true)} />
      </Field>
      <fieldset className="space-y-2">
        <legend className="font-semibold">Units</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          <Radio name="units" value="imperial" label="Imperial" description="Miles and feet" defaultChecked={units === "imperial"} />
          <Radio name="units" value="metric" label="Metric" description="Kilometres and metres" defaultChecked={units === "metric"} />
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
