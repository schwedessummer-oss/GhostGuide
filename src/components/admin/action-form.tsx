"use client";

import { startTransition, useActionState, useRef, type FormEvent, type ReactNode } from "react";
import clsx from "clsx";
import { Button } from "@/components/ui";
import { useAdminFlash } from "./flash";

/**
 * Client wrapper for admin server actions (useActionState). Shows the
 * result next to the form: success (with warnings) or the error and any
 * field errors. Inside the admin layout a success is also announced by the
 * layout-level live region (./flash), which survives the refresh even when
 * the form itself is no longer rendered. Fields are server-rendered children.
 */
export type AdminFormState =
  | { ok: true; message: string; warnings?: string[]; data?: unknown }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> }
  | undefined;

function SuccessBox({ state, compact }: { state: Extract<AdminFormState, { ok: true }>; compact?: boolean }) {
  return (
    <div className={clsx("rounded-xl border border-forest-200 bg-forest-50 text-forest-900", compact ? "px-3 py-2 text-sm" : "p-3")}>
      <p className="font-semibold">
        <span aria-hidden>✓ </span>
        {state.message}
      </p>
      {state.warnings?.length ? (
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-ink">
          {state.warnings.map((w) => (
            <li key={w}>
              <span className="font-semibold">Warning:</span> {w}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function ErrorBox({ state, compact }: { state: Extract<AdminFormState, { ok: false }>; compact?: boolean }) {
  // Field errors are plain-language messages; internal field keys are never shown.
  const extra = state.fieldErrors ? Object.values(state.fieldErrors).flat() : [];
  const others = [...new Set(extra)].filter((m) => m !== state.error);
  return (
    <div className={clsx("rounded-xl border border-[#f5c6c1] bg-red-bg text-red-ink", compact ? "px-3 py-2 text-sm" : "p-3")}>
      <p className="font-semibold">
        <span aria-hidden>! </span>
        {state.error}
      </p>
      {others.length ? (
        <ul className="mt-1 list-disc pl-5 text-sm">
          {others.map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Result of the last submission. `announceSuccess=false` shows a success
 * visually but leaves announcing it to the layout-level live region (so it
 * is not read twice); errors are always announced here.
 */
export function FormResult({ state, compact, announceSuccess = true }: { state: AdminFormState; compact?: boolean; announceSuccess?: boolean }) {
  const success = state?.ok ? <SuccessBox state={state} compact={compact} /> : null;
  const error = state && !state.ok ? <ErrorBox state={state} compact={compact} /> : null;
  if (announceSuccess) {
    return (
      <div aria-live="polite" role="status" className={clsx(!state && "sr-only")}>
        {success ?? error}
      </div>
    );
  }
  return (
    <>
      {success}
      <div aria-live="polite" role="status" className={clsx(!error && "sr-only")}>
        {error}
      </div>
    </>
  );
}

export function ActionForm<S extends AdminFormState>({
  action,
  submitLabel,
  pendingLabel = "Saving…",
  variant = "primary",
  children,
  className,
  compact,
  inline,
  disabled,
}: {
  action: (state: S | undefined, formData: FormData) => Promise<S | undefined>;
  submitLabel: ReactNode;
  pendingLabel?: string;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  children?: ReactNode;
  className?: string;
  compact?: boolean;
  /** lay fields and button out in a row on wider screens */
  inline?: boolean;
  disabled?: boolean;
}) {
  const flash = useAdminFlash();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, formAction, pending] = useActionState<S | undefined, FormData>(async (prev, fd) => {
    const result = await action(prev, fd);
    // Clear the fields only after a successful action. (React's automatic
    // reset for <form action> would also wipe what staff typed when the
    // server rejects a field, forcing them to start over.)
    if (result?.ok) formRef.current?.reset();
    // Hand the confirmation to the persistent layout region: this form may
    // not be rendered any more once the refreshed page commits. An error is
    // shown by this form, and clears an older confirmation so the two never
    // contradict each other.
    if (result) flash?.(result.ok ? { message: result.message, warnings: result.warnings } : null);
    return result;
  }, undefined);
  // Submit via onSubmit (not the action prop) so React does not auto-reset
  // the form; include the clicked submit button's name/value.
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter as HTMLElement | null;
    const fd = new FormData(event.currentTarget, submitter);
    startTransition(() => formAction(fd));
  }
  return (
    <form ref={formRef} onSubmit={submit} className={clsx("space-y-3", className)} aria-busy={pending}>
      <div className={clsx(inline ? "flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end" : "space-y-3")}>
        {children}
        <div>
          <Button type="submit" variant={variant} disabled={pending || disabled} className={compact ? "min-h-11 px-3 text-sm" : undefined}>
            {pending ? pendingLabel : submitLabel}
          </Button>
        </div>
      </div>
      <FormResult state={state} compact={compact} announceSuccess={!flash} />
    </form>
  );
}
