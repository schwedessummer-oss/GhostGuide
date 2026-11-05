import "server-only";
import { env } from "@/config/env";
import { createAnthropicProvider } from "./anthropic";
import type { AiProvider } from "./types";

export { templateProvider, TEMPLATE_PROVIDER_KEY } from "./template";
export { explainFacts, summarizeFacts } from "./facts";
export { runGuarded, AI_TIMEOUT_MS } from "./guarded";
export type { AiProvider, AiText, ExplainInput, SummarizeInput, AiOperation } from "./types";

/**
 * The configured live AI provider, or null when AI is not configured
 * (AI_PROVIDER=demo or no API key) — callers then use the template.
 */
export function getLiveAiProvider(): AiProvider | null {
  const e = env();
  if (e.AI_PROVIDER === "anthropic" && e.ANTHROPIC_API_KEY) {
    return createAnthropicProvider({ apiKey: e.ANTHROPIC_API_KEY, model: e.AI_MODEL });
  }
  return null;
}
