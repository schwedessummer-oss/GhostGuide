import Link from "next/link";
import clsx from "clsx";
import type { ComponentProps, ReactNode } from "react";

/*
 * Accessible UI primitives. Server-component safe (no hooks).
 * Touch targets: interactive controls are at least 44px tall.
 */

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "md" | "lg";

const buttonBase =
  "inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 text-center";
const buttonVariants: Record<Variant, string> = {
  primary: "bg-forest-700 text-white hover:bg-forest-800 active:bg-forest-900",
  secondary: "bg-surface text-forest-800 border border-forest-200 hover:bg-forest-50",
  ghost: "text-forest-800 hover:bg-forest-50",
  danger: "bg-red-ink text-white hover:brightness-110",
};
const buttonSizes: Record<Size, string> = {
  md: "min-h-11 px-4 py-2 text-[0.95rem]",
  lg: "min-h-13 px-6 py-3 text-base",
};

export function buttonClass(variant: Variant = "primary", size: Size = "md", className?: string) {
  return clsx(buttonBase, buttonVariants[variant], buttonSizes[size], className);
}

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<"button"> & { variant?: Variant; size?: Size }) {
  return <button className={buttonClass(variant, size, className)} {...props} />;
}

export function ButtonLink({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}

export function Container({ className, ...props }: ComponentProps<"div">) {
  return <div className={clsx("mx-auto w-full max-w-6xl px-4 sm:px-6", className)} {...props} />;
}

export function Card({ className, ...props }: ComponentProps<"section">) {
  return (
    <section
      className={clsx("rounded-[var(--radius-card)] border border-sand-200 bg-surface p-5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] sm:p-6", className)}
      {...props}
    />
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-3xl">
        {eyebrow ? <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-forest-700">{eyebrow}</p> : null}
        <h1 className="text-3xl font-bold text-ink sm:text-4xl">{title}</h1>
        {description ? <div className="mt-3 text-lg text-muted">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-3">{actions}</div> : null}
    </header>
  );
}

type Tone = "neutral" | "forest" | "amber" | "red" | "blue";
const toneClasses: Record<Tone, string> = {
  neutral: "bg-sand-100 text-ink border-sand-200",
  forest: "bg-forest-100 text-forest-900 border-forest-200",
  amber: "bg-amber-bg text-amber-ink border-[#f1d9b0]",
  red: "bg-red-bg text-red-ink border-[#f5c6c1]",
  blue: "bg-blue-bg text-blue-ink border-[#c9daf8]",
};

export function Badge({ tone = "neutral", className, ...props }: ComponentProps<"span"> & { tone?: Tone }) {
  return (
    <span
      className={clsx("inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-semibold", toneClasses[tone], className)}
      {...props}
    />
  );
}

/** Consistent label for anything simulated in demo mode. */
export function SimulatedBadge({ label = "Simulated" }: { label?: string }) {
  return (
    <Badge tone="amber" title="This is a simulated integration or demonstration data, not a live service.">
      {label}
    </Badge>
  );
}

export function Alert({
  tone = "blue",
  title,
  children,
  className,
  live,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  /** "polite" for status updates, "assertive" for urgent ones */
  live?: "polite" | "assertive";
}) {
  const role = live === "assertive" ? "alert" : live === "polite" ? "status" : undefined;
  return (
    <div role={role} aria-live={live} className={clsx("rounded-xl border p-4", toneClasses[tone], className)}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={clsx("text-[0.95rem]", title && "mt-1")}>{children}</div> : null}
    </div>
  );
}

export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-xl bg-sand-100 p-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-bold text-ink">{value}</dd>
      {hint ? <dd className="mt-0.5 text-xs text-muted">{hint}</dd> : null}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-sand-300 bg-surface p-8 text-center">
      <p className="text-lg font-semibold">{title}</p>
      {children ? <div className="mx-auto mt-2 max-w-prose text-muted">{children}</div> : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------
const inputClass =
  "block w-full min-h-11 rounded-xl border border-sand-300 bg-surface px-3 py-2 text-base text-ink placeholder:text-muted/70 focus:border-forest-600";

export function Field({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block font-semibold text-ink">
        {label}
        {required ? <span className="text-red-ink" aria-hidden> *</span> : null}
      </label>
      {hint ? (
        <p id={`${htmlFor}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-sm font-semibold text-red-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={clsx(inputClass, className)} {...props} />;
}

export function Select({ className, ...props }: ComponentProps<"select">) {
  return <select className={clsx(inputClass, "pr-8", className)} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={clsx(inputClass, "min-h-28", className)} {...props} />;
}

export function Checkbox({ label, className, ...props }: ComponentProps<"input"> & { label: ReactNode }) {
  return (
    <label className={clsx("flex min-h-11 cursor-pointer items-center gap-3 rounded-xl px-1", className)}>
      <input type="checkbox" className="size-5 accent-forest-700" {...props} />
      <span>{label}</span>
    </label>
  );
}

export function Radio({ label, description, className, ...props }: ComponentProps<"input"> & { label: ReactNode; description?: ReactNode }) {
  return (
    <label
      className={clsx(
        "flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-sand-200 bg-surface p-3 has-[:checked]:border-forest-600 has-[:checked]:bg-forest-50",
        className,
      )}
    >
      <input type="radio" className="mt-1 size-5 accent-forest-700" {...props} />
      <span>
        <span className="block font-semibold">{label}</span>
        {description ? <span className="block text-sm text-muted">{description}</span> : null}
      </span>
    </label>
  );
}
