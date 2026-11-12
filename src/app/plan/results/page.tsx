import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { cache } from "react";
import { Ban, Lightbulb, Pencil, Share2 } from "lucide-react";
import { Alert, ButtonLink, Card, Container, PageHeader, SimulatedBadge } from "@/components/ui";
import { PlanForm } from "@/components/discover/plan-form";
import { SuggestionCard } from "@/components/discover/suggestion-card";
import { ReturnToCard } from "@/components/discover/focus-helpers";
import { clock12 } from "@/components/discover/format";
import { getCurrentUser } from "@/server/auth";
import { getLaunchRegion, getTrailBySlug } from "@/server/catalog/trails";
import { planTrip, type PlanSuggestion } from "@/server/discover/plan";
import { explainSuggestion } from "@/server/discover/ai";
import { parsePlanQuery, toPlanQuery, toRawParams, validatePlanTiming, type RawParams } from "@/server/discover/preferences";
import { templateProvider } from "@/integrations/ai/template";
import type { ExplainInput } from "@/integrations/ai/types";
import { formatDate } from "@/lib/format";
import { localDateInZone } from "@/lib/time";
import { formatDuration } from "@/domain/geo";
import { showDemoFixtures } from "@/config/env";
import { monthName } from "@/domain/recommendation";

/** Stable key for the request's search params (React `cache` compares arguments by identity). */
function queryKey(raw: RawParams): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(raw)) for (const x of v === undefined ? [] : Array.isArray(v) ? v : [v]) q.append(k, x);
  return q.toString();
}

/**
 * Parse, validate and plan once per request: shared by generateMetadata
 * (the document title reflects the outcome) and the page.
 */
const loadResults = cache(async (key: string) => {
  const raw = toRawParams(new URLSearchParams(key));
  const parsed = parsePlanQuery(raw);
  const region = await getLaunchRegion();
  const now = new Date();
  const today = localDateInZone(now, region.timezone);
  const timingErrors = parsed.ok ? validatePlanTiming(parsed.prefs, now, region.timezone) : {};
  const errors = !parsed.ok ? parsed.errors : Object.keys(timingErrors).length ? timingErrors : null;
  const plan = parsed.ok && !errors ? await planTrip(parsed.prefs, { now, focusSlug: parsed.trailSlug }) : null;
  return { raw, parsed, today, errors, plan };
});

export async function generateMetadata({ searchParams }: PageProps<"/plan/results">): Promise<Metadata> {
  if (!showDemoFixtures()) return { title: "Explore trails", robots: { index: false } };
  const { parsed, errors, plan } = await loadResults(queryKey((await searchParams) as RawParams));
  const title = !parsed.ok && !parsed.hasInput ? "Plan your hike" : errors ? "Error: Check your answers" : plan?.noMatch ? "No matching trails" : "Your hike suggestions";
  return { title, robots: { index: false } };
}

/** Live AI is used for the top suggestions only; the rest use the template. */
const LIVE_AI_SUGGESTIONS = 3;

const SAVE_ERRORS: Record<string, string> = {
  excluded: "We didn't save this trip: it no longer fits your answers (we re-check everything on the server).",
  date: "We didn't save this trip: that date or start time has passed. Choose a new date.",
  not_found: "We didn't save this trip: that trail isn't available any more.",
  invalid: "We didn't save this trip: some answers were invalid. Please review them.",
  rate_limited: "You've saved a lot of trips in the last hour. Please try again later.",
};

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

function explainInput(s: PlanSuggestion): ExplainInput {
  return {
    trailId: s.trail.id,
    trailName: s.trail.name,
    isDemo: s.trail.isDemo,
    rank: s.rank,
    score: s.result.score,
    breakdown: s.result.breakdown,
    reasons: s.result.reasons,
    warnings: s.result.warnings,
    estimatedDurationMin: s.result.estimatedDurationMin,
    estimatedFinishTime: s.result.estimatedFinishTime,
    paceFactor: s.result.paceFactor,
  };
}

export default async function PlanResultsPage({ searchParams }: PageProps<"/plan/results">) {
  // Planning runs on the fictional demo region only (a development fixture).
  if (!showDemoFixtures()) redirect("/explore");
  const [{ raw, parsed, today, errors, plan: planned }, user] = await Promise.all([
    loadResults(queryKey((await searchParams) as RawParams)),
    getCurrentUser(),
  ]);

  if (!parsed.ok && !parsed.hasInput) {
    const trail = one(raw.trail);
    redirect(trail && /^[a-z0-9-]{1,80}$/.test(trail) ? `/plan?trail=${trail}` : "/plan");
  }
  if (!parsed.ok || errors || !planned) {
    const slug = one(raw.trail);
    const focus = slug && /^[a-z0-9-]{1,80}$/.test(slug) ? await getTrailBySlug(slug) : null;
    return (
      <Container className="max-w-4xl py-10">
        <PageHeader title="Check your answers" description="A few answers need another look before we can suggest trails." />
        <PlanForm values={raw} errors={errors ?? {}} today={today} focusTrail={focus ? { slug: focus.slug, name: focus.name } : null} />
      </Container>
    );
  }

  const { prefs, trailSlug } = parsed;
  const plan = planned;
  const query = toPlanQuery(prefs, trailSlug);
  const explanations = await Promise.all(
    plan.suggestions.map((s, i) =>
      i < LIVE_AI_SUGGESTIONS ? explainSuggestion(user, explainInput(s)) : templateProvider.explainRecommendation(explainInput(s)),
    ),
  );
  const saveErrorCode = one(raw.saveError);
  const saveErrorTrail = one(raw.saveTrail);
  const focusExcluded = plan.focus?.status === "excluded" ? plan.excluded.find((e) => e.trail.slug === plan.focus!.slug) : null;
  const focusRanked = plan.focus?.status === "ranked" ? plan.suggestions.find((s) => s.trail.slug === plan.focus!.slug) : null;

  const summary = [
    formatDate(prefs.plannedDate, { weekday: "short", month: "short", day: "numeric", year: "numeric" }),
    `start ${prefs.startTime} (${clock12(prefs.startTime)})`,
    `${prefs.availableHours} h available`,
    `${prefs.partySize} ${prefs.partySize === 1 ? "person" : "people"}`,
    `${prefs.pace} pace`,
    ...(prefs.bringingDog ? ["with a dog"] : []),
    ...(prefs.accessibilityNeeds.length ? [`${prefs.accessibilityNeeds.length} accessibility need${prefs.accessibilityNeeds.length > 1 ? "s" : ""}`] : []),
  ];

  return (
    <Container className="py-10">
      <PageHeader
        eyebrow={/demo/i.test(plan.region.name) ? `${plan.region.name} · fictional` : `${plan.region.name} · demo region (fictional)`}
        title={plan.noMatch ? "No trail fits all of your answers" : "Your hike suggestions"}
        description={<p>{summary.join(" · ")}</p>}
        actions={
          <ButtonLink href={`/plan?${query}`} variant="secondary">
            <Pencil aria-hidden className="size-4" /> Edit answers
          </ButtonLink>
        }
      />

      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        <Alert tone="amber" title="Demonstration results">
          These fictional trails show how Ghost Guide plans a hike. All times are estimates. Plan to be off the trail by{" "}
          <strong>{plan.latestFinishTime}</strong> in {monthName(prefs.plannedDate)}: {plan.latestFinishLabel} <SimulatedBadge label="Demo data" />
        </Alert>
        <Alert tone="blue" title="How suggestions work">
          <p>Fixed rules check every trail against your answers (no AI decides anything). Your pace factor is ×{plan.paceFactor.toFixed(2)}.</p>
          <p className="mt-2 flex items-start gap-2">
            <Share2 aria-hidden className="mt-1 size-4 shrink-0" /> Your answers are in this page&apos;s link, so you can bookmark or share it.
          </p>
        </Alert>
      </div>

      {saveErrorCode && SAVE_ERRORS[saveErrorCode] && !plan.suggestions.some((s) => s.trail.id === saveErrorTrail) ? (
        <Alert tone="red" live="assertive" className="mb-6">
          {SAVE_ERRORS[saveErrorCode]}
        </Alert>
      ) : null}

      {plan.focus ? (
        <div className="mb-6" role="status">
          {focusRanked ? (
            <Alert tone="forest" title={`${focusRanked.trail.name} fits your answers`}>
              It ranks #{focusRanked.rank} of {plan.suggestions.length}.{" "}
              <a href={`#trail-${focusRanked.trail.id}`} className="font-semibold underline">
                Jump to it
              </a>
            </Alert>
          ) : focusExcluded ? (
            <Alert tone="amber" title={`${focusExcluded.trail.name} doesn't fit your answers`}>
              <ul className="list-disc pl-5">
                {focusExcluded.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {plan.suggestions.length ? <p className="mt-2">Here are trails that do fit.</p> : null}
            </Alert>
          ) : (
            <Alert tone="amber">We couldn&apos;t find the trail you asked about, so here are suggestions from the whole catalog.</Alert>
          )}
        </div>
      ) : null}

      {plan.noMatch ? (
        <Card className="mb-8 border-amber-ink/30">
          <h2 className="flex items-center gap-2 text-xl font-bold">
            <Ban aria-hidden className="size-5 text-amber-ink" /> None of the {plan.excluded.length} trails in our catalog meets every constraint
          </h2>
          <p className="mt-2 text-muted">
            We only suggest routes from our catalog and never invent one. Below you can see which of your answers ruled out each trail.
          </p>
          {plan.relaxSuggestions.length ? (
            <div className="mt-5">
              <h3 className="flex items-center gap-2 font-bold">
                <Lightbulb aria-hidden className="size-5 text-forest-700" /> What you could change
              </h3>
              <ul className="mt-2 list-disc space-y-1.5 pl-5">
                {plan.relaxSuggestions.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="mt-5">
            <ButtonLink href={`/plan?${query}`}>
              <Pencil aria-hidden className="size-4" /> Adjust my answers
            </ButtonLink>
          </div>
        </Card>
      ) : (
        <section aria-labelledby="suggestions-heading" className="mb-10">
          <h2 id="suggestions-heading" className="sr-only">
            Ranked suggestions
          </h2>
          <ReturnToCard />
          <ol className="space-y-8">
            {plan.suggestions.map((s, i) => (
              <li key={s.trail.id}>
                <SuggestionCard
                  suggestion={s}
                  explanation={explanations[i]}
                  query={query}
                  signedIn={!!user}
                  highlighted={plan.focus?.slug === s.trail.slug}
                  saveError={saveErrorTrail === s.trail.id && saveErrorCode ? (SAVE_ERRORS[saveErrorCode] ?? null) : null}
                />
              </li>
            ))}
          </ol>
          {plan.relaxSuggestions.length ? (
            <Alert tone="blue" className="mt-6" title="Want more options?">
              <ul className="list-disc pl-5">
                {plan.relaxSuggestions.map((s) => (
                  <li key={s}>{s}</li>
                ))}
              </ul>
            </Alert>
          ) : null}
        </section>
      )}

      {plan.excluded.length ? (
        <section aria-labelledby="excluded-heading">
          <details className="rounded-[var(--radius-card)] border border-sand-200 bg-surface" open={plan.noMatch || undefined}>
            <summary className="flex min-h-12 cursor-pointer items-center px-5 font-bold">
              <h2 id="excluded-heading" className="text-lg">
                Trails we excluded ({plan.excluded.length}) and why
              </h2>
            </summary>
            <ul className="divide-y divide-sand-200 border-t border-sand-200">
              {plan.excluded.map((e) => (
                <li key={e.trail.id} className="p-5">
                  <p className="font-semibold">
                    <Link href={`/trails/${e.trail.slug}`} className="text-forest-800 underline-offset-2 hover:underline">
                      {e.trail.name}
                    </Link>
                    <span className="ml-2 text-sm font-normal text-muted">
                      {e.trail.difficulty} · catalog estimate {formatDuration(e.trail.estimatedDurationMin)}
                    </span>
                  </p>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[0.95rem] text-muted">
                    {e.reasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          </details>
        </section>
      ) : null}

      <p className="mt-10 text-sm text-muted">
        Ghost Guide is not an emergency service and does not monitor you continuously. Read{" "}
        <Link href="/how-it-works" className="font-semibold text-forest-800 underline">
          how it works and its limitations
        </Link>
        .
      </p>
    </Container>
  );
}
