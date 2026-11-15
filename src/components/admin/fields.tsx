import clsx from "clsx";
import type { ComponentProps, ReactNode } from "react";

/*
 * Compact, labeled form fields for admin forms (server-component safe).
 * Every input has a visible <label>; ids must be unique on the page, so
 * callers derive them from the record id (e.g. `tk-${id}-status`).
 */
const control =
  "block w-full min-h-11 rounded-xl border border-sand-300 bg-surface px-3 py-2 text-base text-ink placeholder:text-muted/70 focus:border-forest-600";

function Label({ id, label, required, hint }: { id: string; label: ReactNode; required?: boolean; hint?: ReactNode }) {
  return (
    <>
      <label htmlFor={id} className="block text-sm font-semibold text-ink">
        {label}
        {required ? (
          <span className="text-red-ink" aria-hidden>
            {" "}
            *
          </span>
        ) : null}
      </label>
      {hint ? (
        <p id={`${id}-hint`} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </>
  );
}

export function TextField({
  id,
  label,
  hint,
  className,
  ...props
}: ComponentProps<"input"> & { id: string; label: ReactNode; hint?: ReactNode }) {
  return (
    <div className={clsx("space-y-1", className)}>
      <Label id={id} label={label} required={props.required} hint={hint} />
      <input id={id} aria-describedby={hint ? `${id}-hint` : undefined} className={control} {...props} />
    </div>
  );
}

export function TextAreaField({
  id,
  label,
  hint,
  className,
  ...props
}: ComponentProps<"textarea"> & { id: string; label: ReactNode; hint?: ReactNode }) {
  return (
    <div className={clsx("space-y-1", className)}>
      <Label id={id} label={label} required={props.required} hint={hint} />
      <textarea id={id} aria-describedby={hint ? `${id}-hint` : undefined} className={clsx(control, "min-h-28")} {...props} />
    </div>
  );
}

export function SelectField({
  id,
  label,
  hint,
  options,
  className,
  placeholder,
  ...props
}: ComponentProps<"select"> & {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  options: readonly (string | { value: string; label: string })[];
  placeholder?: string;
}) {
  return (
    <div className={clsx("space-y-1", className)}>
      <Label id={id} label={label} required={props.required} hint={hint} />
      <select id={id} aria-describedby={hint ? `${id}-hint` : undefined} className={clsx(control, "pr-8")} {...props}>
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((o) => {
          const v = typeof o === "string" ? o : o.value;
          const l = typeof o === "string" ? o.replace(/_/g, " ") : o.label;
          return (
            <option key={v} value={v}>
              {l}
            </option>
          );
        })}
      </select>
    </div>
  );
}

/** The whole ≥44px row is the tap target (the label wraps the checkbox). */
export function CheckField({ id, label, className, ...props }: ComponentProps<"input"> & { id: string; label: ReactNode }) {
  return (
    <label htmlFor={id} className={clsx("flex min-h-11 cursor-pointer items-center gap-3", className)}>
      <input id={id} type="checkbox" className="size-5 shrink-0 accent-forest-700" {...props} />
      <span>{label}</span>
    </label>
  );
}

export function Hidden({ name, value }: { name: string; value: string | number }) {
  return <input type="hidden" name={name} value={value} />;
}
