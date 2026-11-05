"use client";

import { useActionState, type ReactNode } from "react";
import clsx from "clsx";
import { Button } from "@/components/ui";

/**
 * Client wrapper for admin server actions (useActionState). Shows the
 * result in an aria-live region: success (with warnings) or the error and
 * any field errors. Fields are server-rendered children.
 */
export type AdminFormState =
  | { ok: true; message: string; warnings?: string[]; data?: unknown }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> }
  | undefined;


export function FormResult({ state, compact }: { state: AdminFormState; compact?: boolean }) {
  return (
    <div aria-live="polite" role="status" className={clsx(!state && "sr-only")}>
      {state?.ok ? (
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
      ) : state && !state.ok ? (
        <div className={clsx("rounded-xl border border-[#f5c6c1] bg-red-bg text-red-ink", compact ? "px-3 py-2 text-sm" : "p-3")}>
          <p className="font-semibold">
            <span aria-hidden>! </span>
            {state.error}
          </p>
          {state.fieldErrors && Object.keys(state.fieldErrors).length > 1 ? (
            <ul className="mt-1 list-disc pl-5 text-sm">
              {Object.entries(state.fieldErrors).map(([k, v]) => (
                <li key={k}>
                  {k}: {v.join(" ")}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
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
  const [state, formAction, pending] = useActionState<S | undefined, FormData>(action, undefined);
  return (
    <form action={formAction} className={clsx("space-y-3", className)} aria-busy={pending}>
      <div className={clsx(inline ? "flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end" : "space-y-3")}>
        {children}
        <div>
          <Button type="submit" variant={variant} disabled={pending || disabled} className={compact ? "min-h-11 px-3 text-sm" : undefined}>
            {pending ? pendingLabel : submitLabel}
          </Button>
        </div>
      </div>
      <FormResult state={state} compact={compact} />
    </form>
  );
}
