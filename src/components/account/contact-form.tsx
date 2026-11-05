"use client";

import { useActionState, useState } from "react";
import { Button, Field, Input } from "@/components/ui";
import { createContactAction, deleteContactAction, updateContactAction } from "@/app/account/emergency-contacts/actions";
import { errorProps, FormResult, type AccountFormState } from "./form-result";

export interface ContactFormValues {
  id?: string;
  name: string;
  phone: string;
  email: string;
  relationship: string;
  hasConsent: boolean;
}

/** Add / edit an emergency contact, including the explicit consent attestation. */
export function ContactForm({ values, consentStatement }: { values?: ContactFormValues; consentStatement: string }) {
  const editing = !!values?.id;
  const bound = editing ? updateContactAction.bind(null, values!.id!) : createContactAction;
  const [state, action, pending] = useActionState<AccountFormState, FormData>(bound, undefined);
  const idp = editing ? `contact-${values!.id!.slice(0, 8)}` : "contact-new";
  return (
    <form action={action} className="space-y-4" noValidate>
      <Field label="Name" htmlFor={`${idp}-name`} error={state?.fieldErrors?.name} required>
        <Input id={`${idp}-name`} name="name" required maxLength={120} autoComplete="off" defaultValue={values?.name} {...errorProps(`${idp}-name`, state, "name")} />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Mobile phone" htmlFor={`${idp}-phone`} hint="With country code, e.g. +1 555 555 0123." error={state?.fieldErrors?.phone}>
          <Input id={`${idp}-phone`} name="phone" type="tel" inputMode="tel" autoComplete="off" maxLength={32} defaultValue={values?.phone} {...errorProps(`${idp}-phone`, state, "phone", true)} />
        </Field>
        <Field label="Email" htmlFor={`${idp}-email`} hint="Phone, email or both." error={state?.fieldErrors?.email}>
          <Input id={`${idp}-email`} name="email" type="email" autoComplete="off" maxLength={254} defaultValue={values?.email} {...errorProps(`${idp}-email`, state, "email", true)} />
        </Field>
      </div>
      <Field label="Relationship" htmlFor={`${idp}-rel`} hint="Optional, e.g. partner, friend, parent." error={state?.fieldErrors?.relationship}>
        <Input id={`${idp}-rel`} name="relationship" maxLength={60} autoComplete="off" defaultValue={values?.relationship} {...errorProps(`${idp}-rel`, state, "relationship", true)} />
      </Field>
      <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-sand-300 bg-sand-100 p-3">
        <input type="checkbox" name="consent" defaultChecked={values?.hasConsent ?? false} className="mt-1 size-5 shrink-0 accent-forest-700" />
        <span>
          <span className="block font-semibold">Consent</span>
          <span className="block text-[0.95rem]">{consentStatement}</span>
          <span className="mt-1 block text-sm text-muted">Required before this contact can be chosen for check-ins. If you change their phone or email, confirm again.</span>
        </span>
      </label>
      <FormResult state={state} />
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : editing ? "Save contact" : "Add contact"}
      </Button>
    </form>
  );
}

/** Two-step delete with a clear warning when the contact is used by an upcoming check-in. */
export function DeleteContactForm({ contactId, name, usedByOpenCheckin }: { contactId: string; name: string; usedByOpenCheckin: boolean }) {
  const [state, action, pending] = useActionState<AccountFormState, FormData>(deleteContactAction.bind(null, contactId), undefined);
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="space-y-2">
      {!confirming ? (
        <Button type="button" variant="ghost" onClick={() => setConfirming(true)}>
          Delete {name}
        </Button>
      ) : (
        <form action={action} className="space-y-2 rounded-xl border border-red-ink/30 bg-red-bg p-3">
          <p className="font-semibold">Delete {name}?</p>
          {usedByOpenCheckin ? (
            <p className="text-[0.95rem]">
              {name} is the contact for an upcoming or active check-in. If you delete them, nobody will be notified for that trip until you choose another contact.
            </p>
          ) : null}
          <input type="hidden" name="confirmDelete" value="yes" />
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" variant="danger" disabled={pending}>
              {pending ? "Deleting…" : "Yes, delete"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setConfirming(false)}>
              Keep contact
            </Button>
          </div>
        </form>
      )}
      <FormResult state={state} />
    </div>
  );
}
