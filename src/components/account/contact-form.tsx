"use client";

import { useActionState, useEffect, useRef, useState, type ChangeEvent } from "react";
import { Button, Field, Input } from "@/components/ui";
import { createContactAction, deleteContactAction, updateContactAction } from "@/app/account/emergency-contacts/actions";
import { normalizePhone } from "@/domain/notification-messages";
import { echoed, echoedChecked, FormResult, type AccountFormState } from "./form-result";

export interface ContactFormValues {
  id?: string;
  name: string;
  phone: string;
  email: string;
  relationship: string;
  hasConsent: boolean;
}

/** The details a consent attestation is about, as sent in the hidden `consentFor` field. */
const detailsKey = (phone: string, email: string) => JSON.stringify([phone, email]);
/** Same details after normalization (so "+1 555 555 0123" equals "+15555550123"). */
const sameDetails = (a: string, b: string) => {
  try {
    const [p1, e1] = JSON.parse(a) as string[];
    const [p2, e2] = JSON.parse(b) as string[];
    const p = (x: string) => normalizePhone(x) ?? x.trim();
    return p(p1) === p(p2) && e1.trim().toLowerCase() === e2.trim().toLowerCase();
  } catch {
    return false;
  }
};

function describedBy(...ids: (string | false | undefined)[]) {
  return ids.filter(Boolean).join(" ") || undefined;
}

/**
 * Add / edit an emergency contact, including the explicit consent
 * attestation. Consent is about specific details: when the phone or email of
 * a consented contact is changed, the box clears and must be ticked again
 * (the server enforces the same rule via `consentFor`).
 */
export function ContactForm({ values, consentStatement }: { values?: ContactFormValues; consentStatement: string }) {
  const editing = !!values?.id;
  const bound = editing ? updateContactAction.bind(null, values!.id!) : createContactAction;
  const [state, action, pending] = useActionState<AccountFormState, FormData>(bound, undefined);
  const idp = editing ? `contact-${values!.id!.slice(0, 8)}` : "contact-new";
  const consentRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  // Details the consent box was ticked for ("" = not ticked / not yet attested in this form).
  const [consentFor, setConsentFor] = useState(() => (values?.hasConsent ? detailsKey(values.phone, values.email) : ""));
  const [reconfirm, setReconfirm] = useState(false);
  const currentKey = () => detailsKey(phoneRef.current?.value ?? "", emailRef.current?.value ?? "");

  // Only an existing attestation can be "carried over" by a pre-ticked box; a
  // new contact (or one without consent on file) is attested when saved.
  const guardsConsent = editing && !!values?.hasConsent;
  const onDetailsChange = () => {
    const box = consentRef.current;
    if (guardsConsent && box?.checked && !sameDetails(currentKey(), consentFor)) {
      box.checked = false;
      setConsentFor("");
      setReconfirm(true);
    }
  };
  const onConsentChange = (e: ChangeEvent<HTMLInputElement>) => {
    setConsentFor(e.target.checked ? currentKey() : "");
    if (e.target.checked) setReconfirm(false);
  };

  const err = state?.fieldErrors ?? {};
  const reachHintId = `${idp}-reach-hint`;
  return (
    <form action={action} className="space-y-4" noValidate>
      <Field label="Name" htmlFor={`${idp}-name`} error={err.name} required>
        <Input
          id={`${idp}-name`}
          name="name"
          required
          maxLength={120}
          autoComplete="off"
          defaultValue={echoed(state, "name") ?? values?.name}
          aria-invalid={err.name ? true : undefined}
          aria-describedby={describedBy(err.name && `${idp}-name-error`)}
        />
      </Field>
      <div>
        <p id={reachHintId} className="mb-2 text-sm text-muted">
          A mobile number (with country code, e.g. +1 555 555 0123), an email address, or both.
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mobile phone" htmlFor={`${idp}-phone`} error={err.phone}>
            <Input
              ref={phoneRef}
              id={`${idp}-phone`}
              name="phone"
              type="tel"
              inputMode="tel"
              autoComplete="off"
              maxLength={32}
              defaultValue={echoed(state, "phone") ?? values?.phone}
              onChange={onDetailsChange}
              aria-invalid={err.phone ? true : undefined}
              aria-describedby={describedBy(reachHintId, err.phone && `${idp}-phone-error`)}
            />
          </Field>
          <Field label="Email" htmlFor={`${idp}-email`} error={err.email}>
            <Input
              ref={emailRef}
              id={`${idp}-email`}
              name="email"
              type="email"
              autoComplete="off"
              maxLength={254}
              defaultValue={echoed(state, "email") ?? values?.email}
              onChange={onDetailsChange}
              aria-invalid={err.email ? true : undefined}
              aria-describedby={describedBy(reachHintId, err.email && `${idp}-email-error`)}
            />
          </Field>
        </div>
      </div>
      <Field label="Relationship" htmlFor={`${idp}-rel`} hint="Optional, e.g. partner, friend, parent." error={err.relationship}>
        <Input
          id={`${idp}-rel`}
          name="relationship"
          maxLength={60}
          autoComplete="off"
          defaultValue={echoed(state, "relationship") ?? values?.relationship}
          aria-invalid={err.relationship ? true : undefined}
          aria-describedby={describedBy(`${idp}-rel-hint`, err.relationship && `${idp}-rel-error`)}
        />
      </Field>
      <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-sand-300 bg-sand-100 p-3">
        <input
          ref={consentRef}
          type="checkbox"
          name="consent"
          defaultChecked={echoedChecked(state, "consent") ?? values?.hasConsent ?? false}
          onChange={onConsentChange}
          aria-describedby={`${idp}-consent-note`}
          className="mt-1 size-5 shrink-0 accent-forest-700"
        />
        <span>
          <span className="block font-semibold">Consent</span>
          <span className="block text-[0.95rem]">{consentStatement}</span>
          <span id={`${idp}-consent-note`} className="mt-1 block text-sm text-muted">
            Required before this contact can be chosen for check-ins. If you change their phone or email, confirm again.
          </span>
        </span>
      </label>
      <input type="hidden" name="consentFor" value={consentFor} />
      <p aria-live="polite" className={reconfirm ? "text-sm font-semibold text-amber-ink" : "sr-only"}>
        {reconfirm ? "You changed their phone or email, so the consent box was cleared. Tick it again once they've agreed to notices at the new details." : ""}
      </p>
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
  // Focus follows the two-step confirmation: to the question when it opens
  // (not to "Yes, delete"), back to the trigger on "Keep contact".
  const triggerRef = useRef<HTMLButtonElement>(null);
  const questionRef = useRef<HTMLParagraphElement>(null);
  const toggled = useRef(false);
  useEffect(() => {
    if (!toggled.current) return;
    if (confirming) questionRef.current?.focus();
    else triggerRef.current?.focus();
  }, [confirming]);
  const toggle = (open: boolean) => {
    toggled.current = true;
    setConfirming(open);
  };
  const questionId = `delete-contact-${contactId.slice(0, 8)}`;
  return (
    <div className="space-y-2">
      {!confirming ? (
        <Button ref={triggerRef} type="button" variant="ghost" onClick={() => toggle(true)}>
          Delete {name}
        </Button>
      ) : (
        <form action={action} className="space-y-2 rounded-xl border border-red-ink/30 bg-red-bg p-3" aria-labelledby={questionId}>
          <p id={questionId} ref={questionRef} tabIndex={-1} className="font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-forest-600">
            Delete {name}?
          </p>
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
            <Button type="button" variant="ghost" onClick={() => toggle(false)}>
              Keep contact
            </Button>
          </div>
        </form>
      )}
      <FormResult state={state} />
    </div>
  );
}
