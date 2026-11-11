import "server-only";
/**
 * Anthropic Messages API adapter (raw fetch; no SDK installed). Server-side
 * only: the API key never reaches the browser. The model is asked to explain
 * or summarize ONLY the facts we computed; its output is still treated as
 * untrusted and passes through sanitizeAiText + guardAiText by the caller.
 */
import { explainFacts, summarizeFacts } from "./facts";
import type { AiCallOptions, AiProvider, AiText, ExplainInput, SummarizeInput } from "./types";

export const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2026-10-21";

export const SYSTEM_PROMPT = [
  "You write short, plain-text explanations for a hiking-trip planning website.",
  "Only explain or summarize the approved facts and computed scores provided in the user message.",
  "Do not add any facts about trail conditions, route geometry, access, closures, permits, safety, wildlife, history or weather.",
  "Do not say a trail is safe, open, guaranteed or permit-free. Do not mention emergencies or rescue.",
  "Do not introduce any number, time or distance that is not in the facts; avoid converting units.",
  "Times and durations are estimates; say so.",
  "Write plain text only: no markdown, lists, links or headings. At most 120 words.",
].join(" ");

export interface AnthropicConfig {
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  url?: string;
}

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  stop_reason?: string | null;
  model?: string;
}

/** Models that reject `output_config.effort` (older generations). */
function supportsEffort(model: string): boolean {
  return !/claude-3|haiku-4|sonnet-4-5|opus-4-5|opus-4-1|opus-4-0|sonnet-4-0/.test(model);
}

export function buildMessagesRequest(model: string, userContent: string) {
  return {
    model,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    ...(supportsEffort(model) ? { output_config: { effort: "low" } } : {}),
    messages: [{ role: "user", content: userContent }],
  };
}

export class AnthropicError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AnthropicError";
  }
}

export function createAnthropicProvider(cfg: AnthropicConfig): AiProvider {
  const doFetch = cfg.fetchImpl ?? fetch;

  async function complete(userContent: string, opts?: AiCallOptions): Promise<AiText> {
    const res = await doFetch(cfg.url ?? ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(buildMessagesRequest(cfg.model, userContent)),
      signal: opts?.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      let errType = "unknown_error";
      try {
        const body = (await res.json()) as { error?: { type?: string } };
        errType = body.error?.type ?? errType;
      } catch {
        // ignore unparsable error bodies
      }
      throw new AnthropicError(`Anthropic API error ${res.status} (${errType})`, res.status);
    }
    const body = (await res.json()) as MessagesResponse;
    if (body.stop_reason === "refusal") throw new AnthropicError("Model declined the request (refusal)");
    if (body.stop_reason !== "end_turn") throw new AnthropicError(`Unexpected stop_reason: ${body.stop_reason ?? "none"}`);
    const text = (body.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text)
      .join(" ")
      .trim();
    if (!text) throw new AnthropicError("Empty response");
    return { text, provider: "anthropic", model: body.model ?? cfg.model, simulated: false };
  }

  return {
    key: "anthropic",
    model: cfg.model,
    explainRecommendation(input: ExplainInput, opts?: AiCallOptions) {
      return complete(
        `Facts (computed by the planner; do not add others):\n${explainFacts(input)}\n\nIn at most 120 words of plain text, explain to the hiker why this trail received this rank and score, mentioning the strongest factors and that times are estimates.`,
        opts,
      );
    },
    summarizeItinerary(input: SummarizeInput, opts?: AiCallOptions) {
      return complete(
        `Facts (computed by the planner; do not add others):\n${summarizeFacts(input)}\n\nIn at most 120 words of plain text, summarize this hiking itinerary for the hiker, noting that times are estimates and reminders are general. If a partial closure is listed, tell the hiker to follow it even if that means turning around early; never suggest continuing past it.`,
        opts,
      );
    },
  };
}
