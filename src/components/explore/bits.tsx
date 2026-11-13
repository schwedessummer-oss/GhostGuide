import clsx from "clsx";
import { Binoculars, Droplets, Flame, House, LoaderCircle, Mountain, Sprout, Waves, type LucideIcon } from "lucide-react";
import type { Difficulty, DifficultySource, TrailFeature } from "@/domain/catalog";
import { DIFFICULTY_META, FEATURE_LABEL, difficultyEstimateNote, difficultyText, topFeatures } from "./format";

/*
 * Small presentational pieces shared by the Explore list, preview card and
 * other trail summaries. No hooks: usable from server and client components.
 */

const TONE_CLASS = {
  neutral: "bg-sand-100 text-ink border-sand-200",
  forest: "bg-forest-100 text-forest-900 border-forest-200",
  amber: "bg-amber-bg text-amber-ink border-[#f1d9b0]",
  red: "bg-red-bg text-red-ink border-[#f5c6c1]",
  blue: "bg-blue-bg text-blue-ink border-[#c9daf8]",
} as const;

/**
 * "Hard · estimated": the estimate is stated in words, never by color alone.
 * `climbKnown` false (no elevation data): an estimate rests on distance only,
 * which the badge says ("from distance only").
 */
export function TrailDifficulty({
  difficulty,
  source,
  climbKnown = true,
  className,
}: {
  difficulty: Difficulty;
  source: DifficultySource | null;
  climbKnown?: boolean;
  className?: string;
}) {
  const meta = DIFFICULTY_META[difficulty] ?? DIFFICULTY_META.unknown;
  const { label, estimated } = difficultyText(difficulty, source);
  const note = difficultyEstimateNote(difficulty, source, climbKnown);
  return (
    <span
      className={clsx("inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold whitespace-nowrap", TONE_CLASS[meta.tone], className)}
      title={note ?? undefined}
    >
      <span aria-hidden className="size-2 rounded-full" style={{ background: meta.color }} />
      {label}
      {estimated ? <span className="font-normal opacity-80">{climbKnown ? "· estimated" : "· estimated from distance only"}</span> : null}
    </span>
  );
}

const FEATURE_ICON: Record<TrailFeature, LucideIcon> = {
  waterfall: Droplets,
  lake: Waves,
  viewpoint: Binoculars,
  peak: Mountain,
  cave: Mountain,
  spring: Sprout,
  shelter: House,
  picnic_site: Flame,
};

/** Up to `max` feature icons; the names are available to screen readers and as tooltips. */
export function FeatureIcons({ features, max = 3, className }: { features: readonly TrailFeature[]; max?: number; className?: string }) {
  const shown = topFeatures(features, max);
  if (!shown.length) return null;
  return (
    <ul aria-label="Features near the route" className={clsx("flex items-center gap-1.5", className)}>
      {shown.map((f) => {
        const Icon = FEATURE_ICON[f];
        return (
          <li key={f} title={FEATURE_LABEL[f]} className="inline-flex size-7 items-center justify-center rounded-full bg-sand-100 text-forest-800">
            <Icon aria-hidden className="size-4" />
            <span className="sr-only">{FEATURE_LABEL[f]}</span>
          </li>
        );
      })}
    </ul>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <LoaderCircle aria-hidden className={clsx("size-4 shrink-0 motion-safe:animate-spin", className)} />;
}
