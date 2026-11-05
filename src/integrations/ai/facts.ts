/**
 * Render the approved, deterministic facts handed to an AI model. The same
 * text is used to build the prompt AND to check the model's output, so the
 * guard can reject any number the model did not receive.
 */
import { formatDuration } from "@/domain/geo";
import { addMinutesToClock } from "@/lib/time";
import type { ExplainInput, SummarizeInput } from "./types";

export function explainFacts(input: ExplainInput): string {
  const lines = [
    `Trail: ${input.trailName}${input.isDemo ? " (demonstration trail, fictional)" : ""}`,
    `Rank among suggestions: ${input.rank}`,
    `Overall score: ${input.score} out of 100`,
    ...input.breakdown.map((f) => `Score factor "${f.factor}": ${f.points} of ${f.max} points. ${f.detail}`),
    ...input.reasons.map((r) => `Reason: ${r}`),
    `Number of notes to review: ${input.warnings.length}`,
    ...input.warnings.map((w) => `Note to review: ${w}`),
    `Estimated duration at this hiker's pace: ${input.estimatedDurationMin} minutes (${formatDuration(input.estimatedDurationMin)}), an estimate`,
    `Estimated finish time: ${input.estimatedFinishTime}, an estimate`,
    `Pace factor applied to the catalog estimate: ${input.paceFactor.toFixed(2)}`,
  ];
  return lines.join("\n");
}

export function summarizeFacts(input: SummarizeInput): string {
  const lines = [
    `Trail: ${input.trailName}${input.isDemo ? " (demonstration trail, fictional)" : ""}`,
    `Planned date: ${input.plannedDate}`,
    `Start time: ${input.startTime}`,
    `Estimated duration: ${input.estimatedDurationMin} minutes (${formatDuration(input.estimatedDurationMin)}), an estimate`,
    `Estimated finish time: ${input.estimatedFinishTime}, an estimate`,
    ...(input.turnaroundBy ? [`Turn around by: ${input.turnaroundBy}`] : []),
    `Number of stops: ${input.stops.length}`,
    ...input.stops.map(
      (s, i) => `Stop ${i + 1}: ${s.name}, about ${s.etaOffsetMin} minutes after the start, around ${addMinutesToClock(input.startTime, s.etaOffsetMin)} (estimate)`,
    ),
    `Hydration reminder every ${input.reminders.hydrationEveryMin} minutes (general reminder, not medical advice)`,
    `Pace check every ${input.reminders.paceCheckEveryMin} minutes`,
  ];
  return lines.join("\n");
}
