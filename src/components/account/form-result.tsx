import { Alert } from "@/components/ui";

export type AccountFormState =
  | {
      ok?: boolean;
      message?: string;
      error?: string;
      fieldErrors?: Record<string, string>;
      /**
       * What the customer submitted, echoed back when the server rejects it:
       * React resets a form to its default values after every action, so the
       * forms use these as defaults to keep the customer's input.
       */
      values?: Record<string, string | boolean>;
    }
  | undefined;

/** A submitted text value to use as an input default after a rejected submit (undefined after success). */
export function echoed(state: AccountFormState, field: string): string | undefined {
  const v = state?.ok ? undefined : state?.values?.[field];
  return typeof v === "string" ? v : undefined;
}

/** A submitted checkbox state to use as its default after a rejected submit (undefined after success). */
export function echoedChecked(state: AccountFormState, field: string): boolean | undefined {
  const v = state?.ok ? undefined : state?.values?.[field];
  return typeof v === "boolean" ? v : undefined;
}

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
