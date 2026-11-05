import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { closeDb, sql } from "@/server/db";
import type { AiProvider, AiText, ExplainInput } from "@/integrations/ai/types";
import { createCustomer } from "../../helpers/db";

/** A fake "live" provider whose output each test controls. */
const live = vi.hoisted(() => ({ text: "", calls: 0, fail: false }));
vi.mock("@/integrations/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/integrations/ai")>();
  const provider: AiProvider = {
    key: "fake-live",
    model: "fake-model",
    async explainRecommendation(): Promise<AiText> {
      live.calls++;
      if (live.fail) throw new Error("upstream 529 overloaded");
      return { text: live.text, provider: "fake-live", model: "fake-model", simulated: false };
    },
    async summarizeItinerary(): Promise<AiText> {
      live.calls++;
      return { text: live.text, provider: "fake-live", model: "fake-model", simulated: false };
    },
  };
  return { ...actual, getLiveAiProvider: () => provider };
});

afterAll(closeDb);
beforeEach(() => {
  live.text = "";
  live.calls = 0;
  live.fail = false;
});

function input(trailId: string): ExplainInput {
  return {
    trailId,
    trailName: "Lantern Creek Loop",
    isDemo: true,
    rank: 1,
    score: 73,
    breakdown: [{ factor: "Terrain match", points: 20, max: 20, detail: "Matches 2 of 2 preferred terrain types (forest, river)." }],
    reasons: ["Terrain you like: forest, river."],
    warnings: [],
    estimatedDurationMin: 64,
    estimatedFinishTime: "09:34",
    paceFactor: 1,
  };
}

async function events(entityId: string) {
  return sql()<{ providerKey: string; outcome: string; error: string | null }[]>`
    select provider_key, outcome, error from public.integration_events where entity_id = ${entityId} order by id`;
}

describe("AI explanations (untrusted, display-only)", () => {
  it("returns sanitized live text when it passes the guard, and records the call", async () => {
    const { explainSuggestion } = await import("@/server/discover/ai");
    const user = await createCustomer("ai");
    const id = randomUUID();
    live.text = "**Lantern Creek Loop** ranks first with 73 out of 100, mostly on terrain match. Times are estimates. See https://example.com";
    const out = await explainSuggestion(user, input(id));
    expect(out).toMatchObject({ simulated: false, provider: "fake-live" });
    expect(out.text).toBe("Lantern Creek Loop ranks first with 73 out of 100, mostly on terrain match. Times are estimates. See");
    expect(await events(id)).toEqual([{ providerKey: "fake-live", outcome: "success", error: null }]);
  });

  it("falls back to the template on invented numbers, banned claims or provider errors", async () => {
    const { explainSuggestion } = await import("@/server/discover/ai");
    const user = await createCustomer("ai");
    const id = randomUUID();
    live.text = "A 9 mile hike that is totally safe and open year-round.";
    const a = await explainSuggestion(user, input(id));
    expect(a.simulated).toBe(true);
    expect(a.text).toMatch(/score of 73 out of 100/);
    live.fail = true;
    const b = await explainSuggestion(user, input(id));
    expect(b.simulated).toBe(true);
    const ev = await events(id);
    expect(ev.map((e) => e.outcome)).toEqual(["failure", "failure"]);
    expect(ev[0].error).toMatch(/guard rejected/);
    expect(ev[1].error).toMatch(/529/);
  });

  it("uses the template when the ai_explanations flag is off", async () => {
    const { explainSuggestion } = await import("@/server/discover/ai");
    await sql()`update public.feature_flags set enabled = false where key = 'ai_explanations'`;
    try {
      const id = randomUUID();
      live.text = "Ranked first.";
      const out = await explainSuggestion(null, input(id));
      expect(out.simulated).toBe(true);
      expect(live.calls).toBe(0);
      expect(await events(id)).toEqual([{ providerKey: "demo-template", outcome: "simulated", error: "ai_explanations flag off" }]);
    } finally {
      await sql()`update public.feature_flags set enabled = true where key = 'ai_explanations'`;
    }
  });

  it("rate-limits live calls per user (20/hour) and then uses the template", async () => {
    const { explainSuggestion, AI_USER_LIMIT_PER_HOUR } = await import("@/server/discover/ai");
    const user = await createCustomer("ai-limit");
    const id = randomUUID();
    live.text = "Ranked first.";
    for (let i = 0; i < AI_USER_LIMIT_PER_HOUR; i++) expect((await explainSuggestion(user, input(id))).simulated).toBe(false);
    const over = await explainSuggestion(user, input(id));
    expect(over.simulated).toBe(true);
    expect(live.calls).toBe(AI_USER_LIMIT_PER_HOUR);
    const ev = await events(id);
    expect(ev.at(-1)).toEqual({ providerKey: "demo-template", outcome: "simulated", error: "rate limited; template used" });
  });
});
