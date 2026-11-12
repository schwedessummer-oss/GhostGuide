"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from "react";
import clsx from "clsx";
import { X } from "lucide-react";
import { ACTIVITIES, type Activity } from "@/domain/catalog";
import { climbMToInput, climbUnit, inputToClimbM, inputToKm, kmToInput, lengthUnit, type Units } from "@/lib/units";
import {
  FILTER_DIFFICULTIES,
  FILTER_FEATURES,
  FILTER_ROUTE_TYPES,
  clearedFilters,
  type ExploreFilters,
  type FilterDifficulty,
  type FilterFeature,
  type FilterRouteType,
} from "./url-state";
import { DIFFICULTY_META, FEATURE_LABEL, ROUTE_FORM_LABEL } from "./format";

const ACTIVITY_LABEL: Record<Activity, string> = {
  hiking: "Hiking",
  walking: "Walking",
  running: "Trail running",
  biking: "Biking",
  horse_riding: "Horse riding",
};
const DURATION_OPTIONS = [60, 120, 180, 240, 300, 360, 480, 600];

/** Number field text: "" when unset. */
const asText = (n: number | null) => (n === null ? "" : String(n));
function parseInput(s: string): number | null | "invalid" {
  const t = s.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : "invalid";
}

interface Draft {
  difficulty: FilterDifficulty[];
  routeType: FilterRouteType[];
  features: FilterFeature[];
  activity: Activity | null;
  minLength: string;
  maxLength: string;
  maxClimb: string;
  maxDurationMin: number | null;
  dogFriendly: boolean;
  familyFriendly: boolean;
  parking: boolean;
  toilets: boolean;
  camping: boolean;
  fee: ExploreFilters["fee"];
  permit: ExploreFilters["permit"];
}

function toDraft(f: ExploreFilters, units: Units): Draft {
  return {
    difficulty: [...f.difficulty],
    routeType: [...f.routeType],
    features: [...f.features],
    activity: f.activity,
    minLength: asText(f.minDistanceKm === null ? null : kmToInput(f.minDistanceKm, units)),
    maxLength: asText(f.maxDistanceKm === null ? null : kmToInput(f.maxDistanceKm, units)),
    maxClimb: asText(f.maxGainM === null ? null : climbMToInput(f.maxGainM, units)),
    maxDurationMin: f.maxDurationMin,
    dogFriendly: f.dogFriendly,
    familyFriendly: f.familyFriendly,
    parking: f.parking,
    toilets: f.toilets,
    camping: f.camping,
    fee: f.fee,
    permit: f.permit,
  };
}

const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

const chip =
  "inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-full border border-sand-300 bg-surface px-4 text-[0.95rem] font-medium text-ink transition-colors select-none hover:border-forest-500 has-[:checked]:border-forest-700 has-[:checked]:bg-forest-700 has-[:checked]:text-white has-[:focus-visible]:outline-3 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-forest-500";

function Section({ legend, hint, children }: { legend: string; hint?: string; children: ReactNode }) {
  return (
    <fieldset className="border-t border-sand-200 py-5 first:border-t-0 first:pt-1">
      <legend className="float-left mb-3 w-full font-semibold text-ink">
        {legend}
        {hint ? <span className="mt-0.5 block text-sm font-normal text-muted">{hint}</span> : null}
      </legend>
      <div className="clear-left">{children}</div>
    </fieldset>
  );
}

function ChipCheck({ label, checked, onChange, dot }: { label: string; checked: boolean; onChange: () => void; dot?: string }) {
  return (
    <label className={chip}>
      <input type="checkbox" className="sr-only" checked={checked} onChange={onChange} />
      {dot ? <span aria-hidden className="size-2.5 rounded-full ring-2 ring-white/70" style={{ background: dot }} /> : null}
      {label}
    </label>
  );
}

function ChipRadio({ name, label, checked, onChange }: { name: string; label: string; checked: boolean; onChange: () => void }) {
  return (
    <label className={chip}>
      <input type="radio" name={name} className="sr-only" checked={checked} onChange={onChange} />
      {label}
    </label>
  );
}

const fieldInput =
  "block w-full min-h-11 rounded-xl border border-sand-300 bg-surface px-3 py-2 text-base text-ink placeholder:text-muted/70 focus:border-forest-600 aria-[invalid=true]:border-red-ink";

/**
 * Filter sheet (a modal <dialog>: focus is trapped, Esc closes, focus returns
 * to the Filters button). Edits a draft; nothing changes until "Show trails".
 */
export function FiltersDialog({
  open,
  filters,
  units,
  onApply,
  onClose,
}: {
  open: boolean;
  filters: ExploreFilters;
  units: Units;
  onApply: (f: ExploreFilters) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [draft, setDraft] = useState<Draft>(() => toDraft(filters, units));

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const minLength = parseInput(draft.minLength);
  const maxLength = parseInput(draft.maxLength);
  const maxClimb = parseInput(draft.maxClimb);
  const rangeError = typeof minLength === "number" && typeof maxLength === "number" && minLength > maxLength;
  const invalid = minLength === "invalid" || maxLength === "invalid" || maxClimb === "invalid" || rangeError;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (invalid) return;
    const clampKm = (v: number) => Math.min(500, inputToKm(v, units));
    onApply({
      ...filters,
      difficulty: draft.difficulty,
      routeType: draft.routeType,
      features: draft.features,
      activity: draft.activity,
      minDistanceKm: typeof minLength === "number" ? clampKm(minLength) : null,
      maxDistanceKm: typeof maxLength === "number" ? clampKm(maxLength) : null,
      maxGainM: typeof maxClimb === "number" ? Math.min(10_000, inputToClimbM(maxClimb, units)) : null,
      maxDurationMin: draft.maxDurationMin,
      dogFriendly: draft.dogFriendly,
      familyFriendly: draft.familyFriendly,
      parking: draft.parking,
      toilets: draft.toilets,
      camping: draft.camping,
      fee: draft.fee,
      permit: draft.permit,
    });
  };

  const lu = lengthUnit(units);
  const cu = climbUnit(units);

  return (
    <dialog
      ref={ref}
      aria-labelledby={`${id}-title`}
      onClose={onClose}
      onCancel={onClose}
      className="m-0 mt-auto max-h-[92dvh] w-full max-w-none overflow-hidden rounded-t-2xl bg-surface p-0 text-ink shadow-2xl backdrop:bg-forest-950/40 sm:m-auto sm:max-h-[85dvh] sm:max-w-xl sm:rounded-2xl"
    >
      <form onSubmit={submit} className="flex max-h-[92dvh] flex-col sm:max-h-[85dvh]" noValidate>
        <div className="flex items-center justify-between gap-3 border-b border-sand-200 px-5 py-3">
          <h2 id={`${id}-title`} className="text-lg font-bold">
            Filters
          </h2>
          <button type="button" onClick={onClose} className="-mr-2 inline-flex size-11 items-center justify-center rounded-full hover:bg-sand-100">
            <X aria-hidden className="size-5" />
            <span className="sr-only">Close filters</span>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto overscroll-contain px-5">
          <Section legend="Difficulty" hint="Where no rating is mapped, difficulty is estimated from distance and climb.">
            <div className="flex flex-wrap gap-2">
              {FILTER_DIFFICULTIES.map((d) => (
                <ChipCheck key={d} label={DIFFICULTY_META[d].label} dot={DIFFICULTY_META[d].color} checked={draft.difficulty.includes(d)} onChange={() => set("difficulty", toggle(draft.difficulty, d))} />
              ))}
            </div>
          </Section>

          <Section legend={`Length (${lu}, whole hike)`} hint="Out-and-back trails count the walk back too.">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${id}-min`} className="mb-1 block text-sm font-medium text-muted">
                  Shortest
                </label>
                <input
                  id={`${id}-min`}
                  inputMode="decimal"
                  className={fieldInput}
                  placeholder="Any"
                  value={draft.minLength}
                  aria-invalid={minLength === "invalid" || rangeError}
                  aria-describedby={rangeError ? `${id}-range` : undefined}
                  onChange={(e) => set("minLength", e.target.value)}
                />
              </div>
              <div>
                <label htmlFor={`${id}-max`} className="mb-1 block text-sm font-medium text-muted">
                  Longest
                </label>
                <input
                  id={`${id}-max`}
                  inputMode="decimal"
                  className={fieldInput}
                  placeholder="Any"
                  value={draft.maxLength}
                  aria-invalid={maxLength === "invalid" || rangeError}
                  onChange={(e) => set("maxLength", e.target.value)}
                />
              </div>
            </div>
            {rangeError ? (
              <p id={`${id}-range`} className="mt-2 text-sm font-semibold text-red-ink">
                The shortest length must not be more than the longest.
              </p>
            ) : minLength === "invalid" || maxLength === "invalid" ? (
              <p className="mt-2 text-sm font-semibold text-red-ink">Enter a number of {lu === "mi" ? "miles" : "kilometres"}.</p>
            ) : null}
          </Section>

          <Section legend="Climb and time">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor={`${id}-climb`} className="mb-1 block text-sm font-medium text-muted">
                  Most climb ({cu})
                </label>
                <input
                  id={`${id}-climb`}
                  inputMode="numeric"
                  className={fieldInput}
                  placeholder="Any"
                  value={draft.maxClimb}
                  aria-invalid={maxClimb === "invalid"}
                  onChange={(e) => set("maxClimb", e.target.value)}
                />
              </div>
              <div>
                <label htmlFor={`${id}-time`} className="mb-1 block text-sm font-medium text-muted">
                  Longest time
                </label>
                <select
                  id={`${id}-time`}
                  className={clsx(fieldInput, "pr-8")}
                  value={draft.maxDurationMin === null ? "" : String(draft.maxDurationMin)}
                  onChange={(e) => set("maxDurationMin", e.target.value ? Number(e.target.value) : null)}
                >
                  <option value="">Any</option>
                  {[...new Set([...DURATION_OPTIONS, ...(draft.maxDurationMin !== null ? [draft.maxDurationMin] : [])])]
                    .sort((a, b) => a - b)
                    .map((m) => (
                      <option key={m} value={m}>
                        {m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`}
                      </option>
                    ))}
                </select>
              </div>
            </div>
            {maxClimb === "invalid" ? <p className="mt-2 text-sm font-semibold text-red-ink">Enter the climb as a number of {cu === "ft" ? "feet" : "metres"}.</p> : null}
            <p className="mt-2 text-sm text-muted">Trails with no climb or time estimate are left out when these are set.</p>
          </Section>

          <Section legend="Route type">
            <div className="flex flex-wrap gap-2">
              {FILTER_ROUTE_TYPES.map((r) => (
                <ChipCheck key={r} label={ROUTE_FORM_LABEL[r]} checked={draft.routeType.includes(r)} onChange={() => set("routeType", toggle(draft.routeType, r))} />
              ))}
            </div>
          </Section>

          <Section legend="Features near the route">
            <div className="flex flex-wrap gap-2">
              {FILTER_FEATURES.map((f) => (
                <ChipCheck key={f} label={FEATURE_LABEL[f]} checked={draft.features.includes(f)} onChange={() => set("features", toggle(draft.features, f))} />
              ))}
            </div>
          </Section>

          <Section legend="Good for and facilities" hint="Only trails where the mapped data says so. Many trails have no dog or facility data yet.">
            <div className="flex flex-wrap gap-2">
              <ChipCheck label="Dog friendly" checked={draft.dogFriendly} onChange={() => set("dogFriendly", !draft.dogFriendly)} />
              <ChipCheck label="Family friendly" checked={draft.familyFriendly} onChange={() => set("familyFriendly", !draft.familyFriendly)} />
              <ChipCheck label="Parking" checked={draft.parking} onChange={() => set("parking", !draft.parking)} />
              <ChipCheck label="Restrooms" checked={draft.toilets} onChange={() => set("toilets", !draft.toilets)} />
              <ChipCheck label="Camping" checked={draft.camping} onChange={() => set("camping", !draft.camping)} />
            </div>
          </Section>

          <Section legend="Fee" hint="Fees are often unmapped; “Free” means the data says no fee.">
            <div className="flex flex-wrap gap-2">
              <ChipRadio name={`${id}-fee`} label="Any" checked={draft.fee === null} onChange={() => set("fee", null)} />
              <ChipRadio name={`${id}-fee`} label="Free" checked={draft.fee === "free"} onChange={() => set("fee", "free")} />
              <ChipRadio name={`${id}-fee`} label="Paid" checked={draft.fee === "paid"} onChange={() => set("fee", "paid")} />
            </div>
          </Section>

          <Section legend="Permit">
            <div className="flex flex-wrap gap-2">
              <ChipRadio name={`${id}-permit`} label="Any" checked={draft.permit === null} onChange={() => set("permit", null)} />
              <ChipRadio name={`${id}-permit`} label="Not required" checked={draft.permit === "not_required"} onChange={() => set("permit", "not_required")} />
              <ChipRadio name={`${id}-permit`} label="Required" checked={draft.permit === "required"} onChange={() => set("permit", "required")} />
            </div>
          </Section>

          <Section legend="Activity">
            <label htmlFor={`${id}-activity`} className="sr-only">
              Activity
            </label>
            <select
              id={`${id}-activity`}
              className={clsx(fieldInput, "pr-8 sm:max-w-xs")}
              value={draft.activity ?? ""}
              onChange={(e) => set("activity", (e.target.value || null) as Activity | null)}
            >
              <option value="">Any activity</option>
              {ACTIVITIES.map((a) => (
                <option key={a} value={a}>
                  {ACTIVITY_LABEL[a]}
                </option>
              ))}
            </select>
          </Section>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-sand-200 bg-surface px-5 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            type="button"
            onClick={() => setDraft(toDraft(clearedFilters(filters), units))}
            className="inline-flex min-h-11 items-center rounded-xl px-3 font-semibold text-forest-800 underline-offset-2 hover:underline"
          >
            Reset
          </button>
          <button type="submit" disabled={invalid} className="inline-flex min-h-12 items-center justify-center rounded-xl bg-forest-700 px-6 font-semibold text-white hover:bg-forest-800 disabled:opacity-60">
            Show trails
          </button>
        </div>
      </form>
    </dialog>
  );
}
