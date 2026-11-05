/**
 * Deterministic "demo" AI provider: template text built ONLY from the
 * scoring breakdown / itinerary that were already computed. No model is
 * involved (simulated: true). It is also the fallback for every live failure,
 * so its output must always pass guardAiText against its own facts.
 */
import { formatDuration } from "@/domain/geo";
import { addMinutesToClock } from "@/lib/time";
import type { AiProvider, AiText, ExplainInput, SummarizeInput } from "./types";

export const TEMPLATE_PROVIDER_KEY = "demo-template";

const lowerFirst = (s: string) => (s ? s[0].toLowerCase() + s.slice(1) : s);
const stripPeriod = (s: string) => s.replace(/[.\s]+$/, "");

export function templateExplanation(input: ExplainInput): string {
  const positive = input.breakdown.filter((f) => f.max > 0 && !f.neutral);
  const strongest = [...positive].sort((a, b) => b.points / b.max - a.points / a.max || a.factor.localeCompare(b.factor)).slice(0, 2);
  const weakest = [...positive].sort((a, b) => a.points / a.max - b.points / b.max || a.factor.localeCompare(b.factor))[0];
  const penalty = input.breakdown.find((f) => f.max === 0 && f.points < 0);

  const parts = [
    `${input.trailName} is suggestion ${input.rank} with a score of ${input.score} out of 100 from the checks above.`,
    strongest.length
      ? `It scores best on ${strongest.map((f) => `${lowerFirst(f.factor)} (${f.points} of ${f.max}: ${lowerFirst(stripPeriod(f.detail))})`).join(" and ")}.`
      : "",
    weakest && !strongest.includes(weakest) ? `Its weakest factor is ${lowerFirst(weakest.factor)} (${weakest.points} of ${weakest.max}).` : "",
    penalty ? `It loses ${Math.abs(penalty.points)} points for closures or advisories on your date.` : "",
    `At your pace it should take about ${formatDuration(input.estimatedDurationMin)}, finishing around ${input.estimatedFinishTime}. That is an estimate, not a promise.`,
    input.warnings.length === 1
      ? "Review the note listed with this suggestion before you decide."
      : input.warnings.length
        ? `Review the ${input.warnings.length} notes listed with this suggestion before you decide.`
        : "",
  ];
  return parts.filter(Boolean).join(" ");
}

export function templateSummary(input: SummarizeInput): string {
  const named = input.stops.slice(0, 3).map((s) => `${s.name} (around ${addMinutesToClock(input.startTime, s.etaOffsetMin)})`);
  const parts = [
    `Start ${input.trailName} at ${input.startTime} on ${input.plannedDate}.`,
    input.stops.length ? `Your ${input.stops.length} planned stop${input.stops.length === 1 ? "" : "s"} include ${named.join(", ")}.` : "",
    `The estimated finish is around ${input.estimatedFinishTime}, about ${formatDuration(input.estimatedDurationMin)} in total. Treat every time here as an estimate.`,
    input.turnaroundBy ? `Turn around by ${input.turnaroundBy} even if you have not reached the far end.` : "",
    `Expect a drink reminder every ${input.reminders.hydrationEveryMin} minutes and a pace check every ${input.reminders.paceCheckEveryMin} minutes; these are general prompts, not medical advice.`,
  ];
  return parts.filter(Boolean).join(" ");
}

export const templateProvider: AiProvider = {
  key: TEMPLATE_PROVIDER_KEY,
  async explainRecommendation(input: ExplainInput): Promise<AiText> {
    return { text: templateExplanation(input), provider: TEMPLATE_PROVIDER_KEY, simulated: true };
  },
  async summarizeItinerary(input: SummarizeInput): Promise<AiText> {
    return { text: templateSummary(input), provider: TEMPLATE_PROVIDER_KEY, simulated: true };
  },
};
