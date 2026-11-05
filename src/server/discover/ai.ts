import "server-only";
import type { SessionUser } from "@/server/auth";
import { isEnabled } from "@/server/flags";
import { checkRateLimit } from "@/server/rate-limit";
import { recordIntegrationEvent, type IntegrationEvent } from "@/server/integration-log";
import { log } from "@/server/log";
import {
  explainFacts,
  getLiveAiProvider,
  runGuarded,
  summarizeFacts,
  templateProvider,
  type AiOperation,
  type AiText,
  type ExplainInput,
  type SummarizeInput,
} from "@/integrations/ai";

/**
 * AI explanation use-cases. Output is untrusted display text: it is never
 * used for decisions. Every path falls back to the deterministic template:
 *  - feature flag `ai_explanations` off, or no live provider configured
 *  - per-user rate limit exceeded (anonymous visitors share a lower limit)
 *  - provider error, 8 s timeout, refusal, or guard rejection
 * Every call is recorded with recordIntegrationEvent (template = simulated).
 */
export const AI_USER_LIMIT_PER_HOUR = 20;
export const AI_ANON_LIMIT_PER_HOUR = 10;

async function record(ev: IntegrationEvent) {
  try {
    await recordIntegrationEvent(ev);
  } catch (err) {
    log.warn("discover.ai.record_failed", { error: err instanceof Error ? err.message : String(err) });
  }
}

async function generate(
  operation: AiOperation,
  user: SessionUser | null,
  input: ExplainInput | SummarizeInput,
): Promise<AiText> {
  const isExplain = operation === "explainRecommendation";
  const template = isExplain
    ? await templateProvider.explainRecommendation(input as ExplainInput)
    : await templateProvider.summarizeItinerary(input as SummarizeInput);
  const base = { providerKind: "ai", operation, entityType: "trail", entityId: input.trailId } as const;

  let flagOn = false;
  try {
    flagOn = await isEnabled("ai_explanations");
  } catch {
    flagOn = false;
  }
  const live = flagOn ? getLiveAiProvider() : null;
  if (!live) {
    await record({ ...base, providerKey: template.provider, outcome: "simulated", ...(flagOn ? {} : { error: "ai_explanations flag off" }) });
    return template;
  }

  let allowed = false;
  try {
    const limit = await checkRateLimit(
      user ? `ai:explain:${user.id}` : "ai:explain:anon",
      user ? AI_USER_LIMIT_PER_HOUR : AI_ANON_LIMIT_PER_HOUR,
      3600,
    );
    allowed = limit.allowed;
  } catch (err) {
    log.warn("discover.ai.rate_limit_failed", { error: err instanceof Error ? err.message : String(err) });
  }
  if (!allowed) {
    await record({ ...base, providerKey: template.provider, outcome: "simulated", error: "rate limited; template used" });
    return template;
  }

  const facts = isExplain ? explainFacts(input as ExplainInput) : summarizeFacts(input as SummarizeInput);
  const result = await runGuarded({
    template,
    facts,
    call: (signal) =>
      isExplain ? live.explainRecommendation(input as ExplainInput, { signal }) : live.summarizeItinerary(input as SummarizeInput, { signal }),
  });
  await record({
    ...base,
    providerKey: live.key,
    outcome: result.outcome === "success" ? "success" : "failure",
    error: result.error,
    durationMs: result.durationMs,
  });
  if (result.outcome === "fallback") log.warn("discover.ai.fallback", { operation, error: result.error });
  return result.text;
}

export function explainSuggestion(user: SessionUser | null, input: ExplainInput): Promise<AiText> {
  return generate("explainRecommendation", user, input);
}

export function summarizeItineraryText(user: SessionUser | null, input: SummarizeInput): Promise<AiText> {
  return generate("summarizeItinerary", user, input);
}
