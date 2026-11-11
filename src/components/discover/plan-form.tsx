import type { ReactNode } from "react";
import { Alert, Button, Checkbox, Field, Input, Radio } from "@/components/ui";
import { TERRAIN_OPTIONS } from "@/domain/types";
import { ACCESS_NEED_LABEL, ACCESS_NEEDS, EQUIPMENT_LABEL, EQUIPMENT_OPTIONS } from "@/domain/recommendation";
import type { PlanErrors, PlanField, RawParams } from "@/server/discover/preferences";
import { humanize } from "./format";
import { FocusOnMount } from "./focus-helpers";

/** id of the error summary: focused on load so the errors are announced first. */
export const PLAN_ERRORS_ID = "plan-errors";

/**
 * Personalization questionnaire. A plain GET form (works without
 * JavaScript); answers travel in the results URL so results are shareable
 * and reloadable without saving anything. Validated server-side with zod.
 */
const EXPERIENCE: { value: string; label: string; description: string }[] = [
  { value: "new", label: "New to hiking", description: "A few short walks on trails so far." },
  { value: "some", label: "Some experience", description: "A handful of day hikes." },
  { value: "regular", label: "Regular hiker", description: "Day hikes most months, some with big climbs." },
  { value: "expert", label: "Very experienced", description: "Long or remote days and navigation are familiar." },
];
const FITNESS: { value: string; label: string; description: string }[] = [
  { value: "low", label: "Building up", description: "Short or flat walks feel right today." },
  { value: "moderate", label: "Moderate", description: "Comfortable with a few hours and some hills." },
  { value: "high", label: "High", description: "Long days and steady climbing are fine." },
];
const PACE: { value: string; label: string; description: string }[] = [
  { value: "leisurely", label: "Leisurely", description: "Lots of pauses, photos and listening." },
  { value: "steady", label: "Steady", description: "A comfortable, even pace." },
  { value: "brisk", label: "Brisk", description: "Moving efficiently with short breaks." },
];

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

const ERROR_LABEL: Record<PlanField, string> = {
  experience: "Hiking experience",
  fitness: "Fitness",
  terrain: "Preferred terrain",
  pace: "Pace",
  hours: "Available time",
  minMi: "Minimum distance",
  maxMi: "Maximum distance",
  maxGainFt: "Maximum elevation gain",
  date: "Date",
  start: "Start time",
  needs: "Accessibility needs",
  party: "Group size",
  gear: "Equipment",
  dog: "Dog",
  trail: "Trail",
};

/** Anchor id of the first focusable control for each field (for the error summary). */
const FIELD_ANCHOR: Record<PlanField, string> = {
  experience: "experience-new",
  fitness: "fitness-low",
  terrain: "terrain-group",
  pace: "pace-leisurely",
  hours: "hours",
  minMi: "minMi",
  maxMi: "maxMi",
  maxGainFt: "maxGainFt",
  date: "date",
  start: "start",
  needs: "needs-group",
  party: "party",
  gear: "gear-group",
  dog: "dog",
  trail: "plan-form",
};

function Section({ title, description, children, step }: { title: string; description?: string; children: ReactNode; step: number }) {
  return (
    <section className="rounded-[var(--radius-card)] border border-sand-200 bg-surface p-5 sm:p-6" aria-labelledby={`step-${step}`}>
      <div className="mb-5 flex items-start gap-3">
        <span aria-hidden className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-forest-700 font-bold text-white">
          {step}
        </span>
        <div>
          <h2 id={`step-${step}`} className="text-xl font-bold">
            {title}
          </h2>
          {description ? <p className="text-muted">{description}</p> : null}
        </div>
      </div>
      <div className="space-y-6">{children}</div>
    </section>
  );
}

function RadioGroup({
  name,
  legend,
  options,
  value,
  error,
}: {
  name: string;
  legend: string;
  options: { value: string; label: string; description: string }[];
  value: string;
  error?: string;
}) {
  return (
    <fieldset aria-describedby={error ? `${name}-error` : undefined}>
      <legend className="mb-2 font-semibold">
        {legend} <span className="text-red-ink" aria-hidden>*</span>
      </legend>
      <div className="grid gap-2 sm:grid-cols-2">
        {options.map((o) => (
          <Radio
            key={o.value}
            id={`${name}-${o.value}`}
            name={name}
            value={o.value}
            label={o.label}
            description={o.description}
            defaultChecked={value === o.value}
            required
            aria-invalid={error ? true : undefined}
          />
        ))}
      </div>
      {error ? (
        <p id={`${name}-error`} className="mt-1.5 text-sm font-semibold text-red-ink">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

function CheckboxGroup({
  name,
  legend,
  hint,
  options,
  values,
  error,
  columns = 2,
}: {
  name: string;
  legend: string;
  hint?: string;
  options: { value: string; label: string }[];
  values: string[];
  error?: string;
  columns?: 2 | 3;
}) {
  return (
    <fieldset id={`${name}-group`} tabIndex={-1} aria-describedby={[hint ? `${name}-hint` : "", error ? `${name}-error` : ""].filter(Boolean).join(" ") || undefined}>
      <legend className="font-semibold">{legend}</legend>
      {hint ? (
        <p id={`${name}-hint`} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      <div className={columns === 3 ? "mt-1 grid grid-cols-2 gap-x-3 sm:grid-cols-3" : "mt-1 grid gap-x-3 sm:grid-cols-2"}>
        {options.map((o) => (
          <Checkbox key={o.value} name={name} value={o.value} label={o.label} defaultChecked={values.includes(o.value)} />
        ))}
      </div>
      {error ? (
        <p id={`${name}-error`} className="mt-1.5 text-sm font-semibold text-red-ink">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function PlanForm({
  values,
  errors,
  today,
  focusTrail,
}: {
  values: RawParams;
  errors: PlanErrors;
  today: string;
  focusTrail?: { slug: string; name: string } | null;
}) {
  const errorEntries = Object.entries(errors) as [PlanField, string][];
  const err = (f: PlanField) => errors[f];
  const described = (f: PlanField, hint = false) => [hint ? `${f}-hint` : "", errors[f] ? `${f}-error` : ""].filter(Boolean).join(" ") || undefined;

  return (
    <form id="plan-form" method="get" action="/plan/results" className="space-y-6" noValidate>
      {errorEntries.length ? (
        <div id={PLAN_ERRORS_ID} tabIndex={-1} className="scroll-mt-6 rounded-xl outline-offset-4 focus:outline-2 focus:outline-red-ink">
          <Alert tone="red" live="assertive" title={`Please fix ${errorEntries.length} ${errorEntries.length === 1 ? "answer" : "answers"}`}>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {errorEntries.map(([field, message]) => (
                <li key={field}>
                  <a href={`#${FIELD_ANCHOR[field]}`} className="font-semibold underline">
                    {ERROR_LABEL[field]}
                  </a>
                  : {message}
                </li>
              ))}
            </ul>
          </Alert>
          <FocusOnMount targetId={PLAN_ERRORS_ID} />
        </div>
      ) : null}
      {focusTrail ? <input type="hidden" name="trail" value={focusTrail.slug} /> : null}

      <Section step={1} title="About you" description="We use this to suggest a sensible difficulty and to estimate your pace.">
        <RadioGroup name="experience" legend="Hiking experience" options={EXPERIENCE} value={first(values.experience)} error={err("experience")} />
        <RadioGroup name="fitness" legend="Fitness today" options={FITNESS} value={first(values.fitness)} error={err("fitness")} />
      </Section>

      <Section step={2} title="Your kind of hike">
        <CheckboxGroup
          name="terrain"
          legend="Preferred terrain"
          hint="Optional. Pick any that appeal to you."
          options={TERRAIN_OPTIONS.map((t) => ({ value: t, label: humanize(t) }))}
          values={list(values.terrain)}
          error={err("terrain")}
          columns={3}
        />
        <RadioGroup name="pace" legend="Preferred pace" options={PACE} value={first(values.pace)} error={err("pace")} />
        <div className="grid gap-5 sm:grid-cols-3">
          <Field label="Time available (hours)" htmlFor="hours" required hint="Including breaks. 1–14 h." error={err("hours")}>
            <Input
              id="hours"
              name="hours"
              type="number"
              inputMode="decimal"
              min={1}
              max={14}
              step={0.5}
              defaultValue={first(values.hours)}
              required
              aria-invalid={err("hours") ? true : undefined}
              aria-describedby={described("hours", true)}
            />
          </Field>
          <Field label="Shortest distance (miles)" htmlFor="minMi" hint="Optional." error={err("minMi")}>
            <Input id="minMi" name="minMi" type="number" inputMode="decimal" min={0} max={50} step={0.5} defaultValue={first(values.minMi)} aria-invalid={err("minMi") ? true : undefined} aria-describedby={described("minMi", true)} />
          </Field>
          <Field label="Longest distance (miles)" htmlFor="maxMi" hint="Optional. We allow 10% either way." error={err("maxMi")}>
            <Input id="maxMi" name="maxMi" type="number" inputMode="decimal" min={0.5} max={50} step={0.5} defaultValue={first(values.maxMi)} aria-invalid={err("maxMi") ? true : undefined} aria-describedby={described("maxMi", true)} />
          </Field>
        </div>
        <Field label="Most elevation gain (feet)" htmlFor="maxGainFt" hint="Optional. Total climbing over the whole hike." error={err("maxGainFt")}>
          <Input
            id="maxGainFt"
            name="maxGainFt"
            type="number"
            inputMode="numeric"
            min={0}
            max={13000}
            step={50}
            defaultValue={first(values.maxGainFt)}
            className="sm:max-w-xs"
            aria-invalid={err("maxGainFt") ? true : undefined}
            aria-describedby={described("maxGainFt", true)}
          />
        </Field>
      </Section>

      <Section step={3} title="When" description="Dates and times are in the region's local time.">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Date" htmlFor="date" required hint="Today or later." error={err("date")}>
            <Input id="date" name="date" type="date" min={today} defaultValue={first(values.date)} required aria-invalid={err("date") ? true : undefined} aria-describedby={described("date", true)} />
          </Field>
          <Field label="Start time" htmlFor="start" required hint="When you expect to leave the trailhead." error={err("start")}>
            <Input id="start" name="start" type="time" defaultValue={first(values.start)} required aria-invalid={err("start") ? true : undefined} aria-describedby={described("start", true)} />
          </Field>
        </div>
      </Section>

      <Section step={4} title="Your group & needs">
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Group size" htmlFor="party" required hint="1 to 12 people, including you." error={err("party")}>
            <Input id="party" name="party" type="number" inputMode="numeric" min={1} max={12} step={1} defaultValue={first(values.party)} required aria-invalid={err("party") ? true : undefined} aria-describedby={described("party", true)} />
          </Field>
          <div className="sm:pt-7">
            <Checkbox id="dog" name="dog" value="yes" label="We're bringing a dog" defaultChecked={first(values.dog) === "yes"} />
          </div>
        </div>
        <CheckboxGroup
          name="needs"
          legend="Accessibility needs"
          hint="We only suggest trails whose recorded features meet every need you select."
          options={ACCESS_NEEDS.map((n) => ({ value: n, label: ACCESS_NEED_LABEL[n] }))}
          values={list(values.needs)}
          error={err("needs")}
        />
        <CheckboxGroup
          name="gear"
          legend="Equipment you'll carry"
          hint="Optional. Used for gentle reminders, never to rule a trail in."
          options={EQUIPMENT_OPTIONS.map((e) => ({ value: e, label: EQUIPMENT_LABEL[e] }))}
          values={list(values.gear)}
          error={err("gear")}
        />
      </Section>

      <div className="flex flex-col gap-3 rounded-[var(--radius-card)] bg-forest-50 p-5 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted">
          Nothing is saved until you choose a trail. Suggestions come from fixed rules, not AI; your answers stay in the page link.
        </p>
        <Button type="submit" size="lg" className="shrink-0">
          See my suggestions
        </Button>
      </div>
    </form>
  );
}
