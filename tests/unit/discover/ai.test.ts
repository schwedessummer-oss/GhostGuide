import { describe, expect, it, vi } from "vitest";
import { guardAiText, sanitizeAiText } from "@/integrations/ai/guard";
import { explainFacts, summarizeFacts } from "@/integrations/ai/facts";
import { templateExplanation, templateProvider, templateSummary } from "@/integrations/ai/template";
import { runGuarded } from "@/integrations/ai/guarded";
import { ANTHROPIC_VERSION, buildMessagesRequest, createAnthropicProvider, SYSTEM_PROMPT } from "@/integrations/ai/anthropic";
import type { AiText, ExplainInput, SummarizeInput } from "@/integrations/ai/types";
import { recommendTrails } from "@/domain/recommendation";
import { candidate, ctx, prefs } from "./fixtures";

const ranked = recommendTrails(
  prefs(),
  [
    candidate(
      { name: "Old Signal Summit" },
      { closures: [{ severity: "partial", reason: "Upper switchbacks closed", startsAt: new Date("2026-11-01T00:00:00Z"), endsAt: null }] },
    ),
  ],
  ctx,
).ranked[0];

const explainInput: ExplainInput = {
  trailName: "Old Signal Summit",
  isDemo: true,
  rank: 1,
  score: ranked.score,
  breakdown: ranked.breakdown,
  reasons: ranked.reasons,
  warnings: ranked.warnings,
  estimatedDurationMin: ranked.estimatedDurationMin,
  estimatedFinishTime: ranked.estimatedFinishTime,
  paceFactor: ranked.paceFactor,
};

const summarizeInput: SummarizeInput = {
  trailName: "Hollow Pine Ridge",
  isDemo: true,
  plannedDate: "2026-11-14",
  startTime: "08:30",
  estimatedFinishTime: "11:20",
  estimatedDurationMin: 170,
  turnaroundBy: "10:25",
  stops: [
    { name: "Hollow Pine", etaOffsetMin: 30 },
    { name: "Ridge Viewpoint", etaOffsetMin: 85 },
  ],
  reminders: { hydrationEveryMin: 30, paceCheckEveryMin: 45 },
};

const live = (text: string): AiText => ({ text, provider: "anthropic", model: "test-model", simulated: false });

describe("sanitizeAiText", () => {
  it("strips markdown, URLs and HTML and collapses whitespace", () => {
    const out = sanitizeAiText("## Why\n**Great** pick! See [details](https://evil.example.com/x) or www.example.org.\n- item <script>alert(1)</script> `code`");
    expect(out).not.toMatch(/[#*`<>[\]]/);
    expect(out).not.toMatch(/https?:|www\.|example/);
    expect(out).toMatch(/Great pick! See details or/);
  });

  it("caps length at 120 words, preferring a sentence boundary", () => {
    const long = Array.from({ length: 60 }, (_, i) => `Sentence number word${i} is here.`).join(" ");
    const out = sanitizeAiText(long);
    expect(out.split(" ").length).toBeLessThanOrEqual(120);
    expect(out.length).toBeLessThanOrEqual(900);
    expect(out.endsWith(".")).toBe(true);
  });
});

describe("guardAiText", () => {
  const facts = explainFacts(explainInput);

  it("accepts text that only uses numbers from the facts", () => {
    expect(guardAiText(`It scored ${explainInput.score} out of 100 and should finish around ${explainInput.estimatedFinishTime}.`, facts)).toEqual({ ok: true });
  });

  it("rejects invented numbers, distances and times", () => {
    expect(guardAiText("It is 7.5 miles long.", facts)).toMatchObject({ ok: false, reason: expect.stringMatching(/number 7.5/) });
    expect(guardAiText("You will finish by 16:20.", facts)).toMatchObject({ ok: false, reason: expect.stringMatching(/time 16:20/) });
    expect(guardAiText(`Score ${explainInput.score + 7} out of 100.`, facts).ok).toBe(false);
  });

  it("rejects banned claims about safety, status, permits, rescue, weather and wildlife", () => {
    for (const bad of [
      "This trail is safe for everyone.",
      "A guaranteed great day.",
      "The trail is open today.",
      "No permit is needed.",
      "There are no closures.",
      "Rescue is nearby if needed.",
      "The weather looks great.",
      "Watch for bears near the creek.",
      "Rich in local history.",
      "It is wheelchair friendly.",
      "Get back before sunset.",
    ]) {
      expect(guardAiText(bad, facts).ok, bad).toBe(false);
    }
  });

  it("the deterministic templates always pass the guard against their own facts", () => {
    expect(guardAiText(sanitizeAiText(templateExplanation(explainInput)), facts)).toEqual({ ok: true });
    expect(guardAiText(sanitizeAiText(templateSummary(summarizeInput)), summarizeFacts(summarizeInput))).toEqual({ ok: true });
  });

  it("templates are built only from the breakdown/itinerary and stay short", async () => {
    const t = await templateProvider.explainRecommendation(explainInput);
    expect(t.simulated).toBe(true);
    expect(t.provider).toBe("demo-template");
    expect(t.text).toContain(`${explainInput.score} out of 100`);
    expect(t.text).toMatch(/loses 10 points for closures/);
    expect(t.text.split(/\s+/).length).toBeLessThanOrEqual(120);
    const s = await templateProvider.summarizeItinerary(summarizeInput);
    expect(s.text).toMatch(/Turn around by 10:25/);
    expect(s.text).toMatch(/not medical advice/);
  });
});

describe("itinerary summary with a partial closure", () => {
  const reason = "Upper switchbacks closed for (fictional) trail maintenance. Turn around at the Signal Tower.";
  const closed = { ...summarizeInput, partialClosures: [reason] };

  it("tells the hiker to follow the closure instead of continuing to the far end", async () => {
    const s = await templateProvider.summarizeItinerary(closed);
    expect(s.text).toMatch(/partial closure on your date: follow the closure notice in your itinerary, even if that means turning around before the far end/);
    expect(s.text).toMatch(/Turn around by 10:25 at the latest, or earlier where the closure requires it\./);
    expect(s.text).toMatch(/estimated full-route finish/);
    expect(s.text).not.toMatch(/even if you have not reached the far end/);
    // unchanged without a closure
    expect((await templateProvider.summarizeItinerary(summarizeInput)).text).toMatch(/Turn around by 10:25 even if you have not reached the far end/);
  });

  it("gives the live model the closure as a fact, and the template still passes the guard", () => {
    expect(summarizeFacts(closed)).toContain(reason);
    expect(guardAiText(sanitizeAiText(templateSummary(closed)), summarizeFacts(closed))).toEqual({ ok: true });
  });
});

describe("runGuarded (fallback behaviour)", () => {
  const template: AiText = { text: "Template text.", provider: "demo-template", simulated: true };
  const facts = explainFacts(explainInput);

  it("returns sanitized live text when it passes the guard", async () => {
    const r = await runGuarded({ template, facts, call: async () => live(`**Ranked** first with ${explainInput.score} out of 100.`) });
    expect(r.outcome).toBe("success");
    expect(r.text).toMatchObject({ provider: "anthropic", simulated: false, text: `Ranked first with ${explainInput.score} out of 100.` });
  });

  it("falls back to the template on invented numbers or banned claims", async () => {
    const a = await runGuarded({ template, facts, call: async () => live("It is a 12 mile hike.") });
    expect(a.outcome).toBe("fallback");
    expect(a.text).toBe(template);
    expect(a.error).toMatch(/guard rejected/);
    const b = await runGuarded({ template, facts, call: async () => live("Completely safe and open.") });
    expect(b.text).toBe(template);
  });

  it("falls back on provider errors and on timeout", async () => {
    const err = await runGuarded({ template, facts, call: async () => { throw new Error("Anthropic API error 529 (overloaded_error)"); } });
    expect(err).toMatchObject({ outcome: "fallback", error: expect.stringMatching(/529/) });
    let aborted = false;
    const slow = await runGuarded({
      template,
      facts,
      timeoutMs: 30,
      call: (signal) =>
        new Promise<AiText>((resolve) => {
          signal.addEventListener("abort", () => (aborted = true));
          setTimeout(() => resolve(live("late")), 200);
        }),
    });
    expect(slow).toMatchObject({ outcome: "fallback", error: expect.stringMatching(/timed out/) });
    expect(aborted).toBe(true);
  });
});

describe("Anthropic provider (raw Messages API)", () => {
  it("sends the documented request shape server-side and parses text blocks", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      Response.json({ content: [{ type: "thinking", thinking: "" }, { type: "text", text: "Ranked first." }], stop_reason: "end_turn", model: "claude-sonnet-5-5" }),
    );
    const provider = createAnthropicProvider({ apiKey: "sk-test", model: "claude-sonnet-5-5", fetchImpl });
    const out = await provider.explainRecommendation(explainInput);
    expect(out).toEqual({ text: "Ranked first.", provider: "anthropic", model: "claude-sonnet-5-5", simulated: false });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    const headers = init!.headers as Record<string, string>;
    expect(headers["x-api-key"]).toBe("sk-test");
    expect(headers["anthropic-version"]).toBe(ANTHROPIC_VERSION);
    const body = JSON.parse(String(init!.body));
    expect(body.model).toBe("claude-sonnet-5-5");
    expect(body.system).toBe(SYSTEM_PROMPT);
    expect(body).not.toHaveProperty("temperature");
    expect(body.messages[0].content).toContain(explainFacts(explainInput));
    expect(SYSTEM_PROMPT).toMatch(/Do not add any facts about trail conditions, route geometry, access, closures, permits, safety, wildlife, history or weather/);
  });

  it("treats refusals, truncation and HTTP errors as failures", async () => {
    const mk = (body: unknown, status = 200) =>
      createAnthropicProvider({ apiKey: "k", model: "m", fetchImpl: (async () => Response.json(body, { status })) as unknown as typeof fetch });
    await expect(mk({ content: [], stop_reason: "refusal" }).explainRecommendation(explainInput)).rejects.toThrow(/refusal/);
    await expect(mk({ content: [{ type: "text", text: "partial" }], stop_reason: "max_tokens" }).explainRecommendation(explainInput)).rejects.toThrow(/stop_reason/);
    await expect(mk({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, 429).summarizeItinerary(summarizeInput)).rejects.toThrow(/429 \(rate_limit_error\)/);
  });

  it("only requests low effort on models that support it", () => {
    expect(buildMessagesRequest("claude-sonnet-5-5", "x")).toHaveProperty("output_config", { effort: "low" });
    expect(buildMessagesRequest("claude-haiku-4-5", "x")).not.toHaveProperty("output_config");
  });
});
