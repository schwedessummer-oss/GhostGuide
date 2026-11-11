/**
 * Deterministic marketing-draft template (pure, no I/O, no AI).
 *
 * Composes copy ONLY from the facts it is given — each of which carries its
 * source label and retrieved/verified timestamps — plus an optional weather
 * snapshot. It never invents distances, access, closures, permits or safety
 * claims. Drafts always go through human review before publication.
 */
import type { FactKind } from "@/domain/types";
import type { ForecastPeriod } from "@/integrations/weather/types";
import { classifyWeatherFreshness } from "@/integrations/weather/freshness";

export const FACTS_STALE_DAYS = 90;

export interface MarketingFact {
  field: string;
  label: string;
  /** already formatted for display, e.g. "7.4 km (4.6 mi)" */
  value: string;
  kind: FactKind;
  sourceLabel: string;
  sourceUrl: string | null;
  retrievedAt: string | null; // ISO
  verifiedAt: string | null; // ISO
}

export interface MarketingWeather {
  provider: string;
  simulated: boolean;
  fetchedAt: string; // ISO
  sourceUrl: string | null;
  periods: ForecastPeriod[];
}

export interface MarketingTemplateInput {
  trailName: string;
  regionName: string;
  isDemo: boolean;
  channel: "newsletter" | "social" | "web";
  facts: MarketingFact[];
  weather: MarketingWeather | null;
  now: Date;
}

export interface MarketingSourceRef {
  label: string;
  url: string | null;
  retrievedAt: string | null;
  /** when staff last checked the facts from this source (see `verifiedKind`) */
  verifiedAt: string | null;
  /**
   * true only when every fact from this source has provenance kind
   * 'verified'; otherwise the check is described as "reviewed". Drafts
   * saved before this field existed are treated as "reviewed".
   */
  verifiedKind?: boolean;
}

export interface MarketingDraftContent {
  title: string;
  body: string;
  sources: MarketingSourceRef[];
  /** the OLDEST verification timestamp among the facts used */
  factsAsOf: string | null;
  warnings: string[];
}

const day = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 10) : "unknown date");
const stamp = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;

export interface FactFreshness {
  status: "fresh" | "stale" | "unverified";
  ageDays: number | null;
}

export function classifyFactFreshness(verifiedAt: string | Date | null, now: Date): FactFreshness {
  if (!verifiedAt) return { status: "unverified", ageDays: null };
  const t = new Date(verifiedAt).getTime();
  if (Number.isNaN(t)) return { status: "unverified", ageDays: null };
  const ageDays = Math.floor((now.getTime() - t) / 86_400_000);
  return { status: ageDays > FACTS_STALE_DAYS ? "stale" : "fresh", ageDays };
}

const KIND_NOTE: Record<FactKind, string> = {
  verified: "verified",
  estimate: "estimate",
  operator_note: "operator note",
  demo: "demonstration data",
};

/**
 * The word for "a person checked this". Only provenance kind 'verified'
 * may be called verified; estimates, operator notes and demo data were
 * merely reviewed.
 */
export function checkedWord(kind: FactKind): "verified" | "reviewed" {
  return kind === "verified" ? "verified" : "reviewed";
}

function factLine(f: MarketingFact): string {
  const word = checkedWord(f.kind);
  const when = f.verifiedAt ? `${word} ${day(f.verifiedAt)}` : `not yet ${word}`;
  const retrieved = f.retrievedAt ? `, source retrieved ${day(f.retrievedAt)}` : "";
  return `- ${f.label}: ${f.value} (${KIND_NOTE[f.kind]}; ${f.sourceLabel}; ${when}${retrieved})`;
}

function weatherLines(w: MarketingWeather, max: number): string[] {
  const head = w.simulated
    ? `Weather outlook — SIMULATED demo data, not a real forecast (generated ${stamp(w.fetchedAt)}):`
    : `Weather outlook — ${w.provider === "nws" ? "U.S. National Weather Service" : w.provider} forecast fetched ${stamp(w.fetchedAt)}${w.sourceUrl ? ` (${w.sourceUrl})` : ""}:`;
  const lines = w.periods.slice(0, max).map((p) => {
    const precip = p.precipitationChancePct !== null ? `, ${p.precipitationChancePct}% chance of precipitation` : "";
    return `- ${p.name}: ${p.shortForecast}, ${p.temperature}°${p.temperatureUnit}${p.windSpeed ? `, wind ${p.windSpeed}` : ""}${precip}`;
  });
  return [head, ...lines, "Forecasts change — check the latest official forecast before you go."];
}

export function composeMarketingDraft(input: MarketingTemplateInput): MarketingDraftContent {
  const warnings: string[] = [];
  const facts = input.facts.filter((f) => f.sourceLabel.trim() !== "" && f.value.trim() !== "");
  if (facts.length < input.facts.length) warnings.push("Some facts had no source and were left out.");
  if (facts.length === 0) warnings.push("No sourced facts are available for this trail; the draft contains no trail facts.");

  for (const f of facts) {
    const fr = classifyFactFreshness(f.verifiedAt ?? f.retrievedAt, input.now);
    const word = checkedWord(f.kind);
    if (fr.status === "stale") warnings.push(`${f.label} was last ${word} ${fr.ageDays} days ago (older than ${FACTS_STALE_DAYS} days). Check it again before publishing.`);
    if (fr.status === "unverified") warnings.push(`${f.label} has no ${word === "verified" ? "verification" : "review"} or retrieval date.`);
    if (f.kind === "estimate") warnings.push(`${f.label} is an estimate; keep the "estimate" wording.`);
  }
  if (input.isDemo) warnings.push("This is a DEMONSTRATION trail (fictional). Do not publish it as a real place.");
  if (input.weather) warnings.push(...classifyWeatherFreshness(input.weather, input.now).warnings);
  else warnings.push("No weather snapshot attached.");

  const demoNote = input.isDemo ? " (demonstration trail — fictional)" : "";
  const title = input.channel === "social" ? `${input.trailName}${demoNote}` : `Explore ${input.trailName}${demoNote} with Ghost Guide`;

  const body: string[] = [];
  if (input.channel === "social") {
    body.push(`Self-guided hike: ${input.trailName}, ${input.regionName}.${input.isDemo ? " Demonstration content — fictional trail." : ""}`);
    for (const f of facts.slice(0, 3)) body.push(factLine(f));
    if (input.weather) body.push(...weatherLines(input.weather, 2));
  } else {
    body.push(
      `${input.trailName} is a self-guided hike in ${input.regionName} with Ghost Guide's GPS-triggered audio companion.${input.isDemo ? " This is demonstration content: the trail is fictional." : ""}`,
    );
    if (facts.length) {
      body.push("", "Trail facts (with sources):");
      for (const f of facts) body.push(factLine(f));
    }
    if (input.weather) body.push("", ...weatherLines(input.weather, 4));
  }
  body.push("", "Conditions change. Check current trail conditions, closures and permit rules with the land manager before you go.");

  const sourceMap = new Map<string, MarketingSourceRef>();
  for (const f of facts) {
    const key = `${f.sourceLabel}|${f.sourceUrl ?? ""}`;
    const prev = sourceMap.get(key);
    const verifiedAt = [prev?.verifiedAt, f.verifiedAt].filter(Boolean).sort()[0] ?? null;
    const verifiedKind = (prev ? prev.verifiedKind === true : true) && f.kind === "verified";
    sourceMap.set(key, { label: f.sourceLabel, url: f.sourceUrl, retrievedAt: prev?.retrievedAt ?? f.retrievedAt, verifiedAt, verifiedKind });
  }
  if (input.weather) {
    sourceMap.set(`weather|${input.weather.sourceUrl ?? ""}`, {
      label: input.weather.simulated ? "Simulated weather (demo provider)" : "U.S. National Weather Service forecast",
      url: input.weather.sourceUrl,
      retrievedAt: input.weather.fetchedAt,
      verifiedAt: null,
      verifiedKind: false,
    });
  }
  const sources = [...sourceMap.values()];
  if (sources.length) {
    body.push("", "Sources:");
    for (const s of sources) {
      const when = [s.retrievedAt ? `retrieved ${day(s.retrievedAt)}` : null, s.verifiedAt ? `${s.verifiedKind ? "verified" : "reviewed"} ${day(s.verifiedAt)}` : null]
        .filter(Boolean)
        .join("; ");
      body.push(`- ${s.label}${s.url ? ` (${s.url})` : ""}${when ? `; ${when}` : "; no retrieval date recorded"}`);
    }
  }

  const verifiedTimes = facts.map((f) => f.verifiedAt ?? f.retrievedAt).filter((v): v is string => !!v).sort();
  return { title, body: body.join("\n"), sources, factsAsOf: verifiedTimes[0] ?? null, warnings: [...new Set(warnings)] };
}
