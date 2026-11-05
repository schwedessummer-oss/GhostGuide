import { Alert } from "@/components/ui";

export type AccountFormState = { ok?: boolean; message?: string; error?: string; fieldErrors?: Record<string, string> } | undefined;

/** Polite live region announcing a form's outcome. */
export function FormResult({ state }: { state: AccountFormState }) {
  return (
    <div aria-live="polite" role="status">
      {state?.error ? <Alert tone="red">{state.error}</Alert> : null}
      {state?.ok && state.message ? <Alert tone="forest">{state.message}</Alert> : null}
    </div>
  );
}

/** Props wiring an input to its error message for screen readers. */
export function errorProps(id: string, state: AccountFormState, field: string, hint = false) {
  const err = state?.fieldErrors?.[field];
  const describedBy = [hint ? `${id}-hint` : null, err ? `${id}-error` : null].filter(Boolean).join(" ");
  return { "aria-invalid": err ? (true as const) : undefined, "aria-describedby": describedBy || undefined };
}
