"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { getCurrentUser } from "@/server/auth";
import { checkRateLimit } from "@/server/rate-limit";
import { parsePlanQuery, resultsPath } from "@/server/discover/preferences";
import { saveTrip, SaveTripError, type SaveTripErrorCode } from "@/server/discover/save-trip";

/**
 * "Save this trip" (progressively enhanced form; works without JS).
 * Only the questionnaire answers (the results URL query) and the trail id
 * are accepted — any client-side score is ignored; saveTrip re-runs the
 * deterministic recommendation server-side.
 */
const formSchema = z.object({
  q: z.string().max(4000),
  trailId: z.uuid(),
});

function withSaveError(path: string, code: SaveTripErrorCode | "rate_limited", trailId: string): string {
  return `${path}&saveError=${code}&saveTrail=${encodeURIComponent(trailId)}#trail-${encodeURIComponent(trailId)}`;
}

export async function saveTripAction(formData: FormData): Promise<void> {
  const parsedForm = formSchema.safeParse({ q: formData.get("q"), trailId: formData.get("trailId") });
  if (!parsedForm.success) redirect("/plan");
  const { q, trailId } = parsedForm.data;

  const plan = parsePlanQuery(new URLSearchParams(q));
  if (!plan.ok) redirect("/plan");
  // Canonical, same-site path rebuilt from validated answers (never echo raw input into redirects).
  const back = resultsPath(plan.prefs, plan.trailSlug);

  const user = await getCurrentUser();
  // Come back to the chosen card (trailId is a validated uuid), not the top of a long page.
  if (!user) redirect(`/login?next=${encodeURIComponent(`${back}#trail-${trailId}`)}`);

  const limit = await checkRateLimit(`trips:save:${user.id}`, 30, 3600);
  if (!limit.allowed) redirect(withSaveError(back, "rate_limited", trailId));

  let tripId: string | null = null;
  let failure: SaveTripErrorCode | null = null;
  try {
    tripId = (await saveTrip(user, plan.prefs, trailId)).tripId;
  } catch (err) {
    if (!(err instanceof SaveTripError)) throw err;
    failure = err.code;
  }
  if (failure || !tripId) redirect(withSaveError(back, failure ?? "invalid", trailId));
  redirect(`/trips/${tripId}`);
}
