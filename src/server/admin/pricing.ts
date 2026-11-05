import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import type { PricingRule, PricingRuleKind } from "@/domain/pricing";
import type { JsonValue } from "@/server/db";
import { assertCan, auditInStaffTx, fail, guarded, isUuid, isoDate, ok, requiredText, staffTx, zodFail, type ActionResult } from "./common";

/**
 * Transparent, rule-based pricing (no ML / dynamic pricing — deferred).
 * Rules feed src/domain/pricing.ts quotePrice, used identically by the
 * customer quote, checkout and this admin preview.
 */
export const RULE_KINDS = ["weekend_pct", "holiday_pct", "high_demand_pct", "group_discount_pct", "flat_fee"] as const satisfies readonly PricingRuleKind[];

export interface PricingTrail {
  id: string;
  name: string;
  status: string;
  regionId: string;
  basePriceCents: number;
  currency: string;
  dailyCapacity: number;
  isDemo: boolean;
}
export interface PricingAddon {
  id: string;
  code: string;
  name: string;
  kind: string;
  priceCents: number;
  pricingUnit: "per_booking" | "per_person";
  active: boolean;
}
export interface PricingRuleRow extends PricingRule {
  trailName: string | null;
  updatedAt: Date;
}

export async function getPricingData(user: SessionUser): Promise<{ rules: PricingRuleRow[]; trails: PricingTrail[]; addons: PricingAddon[]; regionIds: string[] }> {
  assertCan(user, "pricing.manage");
  return staffTx(user, async (tx) => {
    const [rules, trails, addons, regions] = await Promise.all([
      tx<PricingRuleRow[]>`
        select r.id, r.name, r.kind, r.value, r.params, r.region_id, r.trail_id, r.active, r.priority,
               to_char(r.effective_from, 'YYYY-MM-DD') as effective_from, to_char(r.effective_to, 'YYYY-MM-DD') as effective_to,
               t.name as trail_name, r.updated_at
        from public.pricing_rules r left join public.trails t on t.id = r.trail_id
        order by r.active desc, r.priority, r.name`,
      tx<PricingTrail[]>`
        select id, name, status, region_id, base_price_cents, currency, daily_capacity, is_demo
        from public.trails where status <> 'archived' order by name`,
      tx<PricingAddon[]>`select id, code, name, kind, price_cents, pricing_unit, active from public.addons order by name`,
      tx<{ id: string }[]>`select id from public.regions order by name`,
    ]);
    return { rules, trails, addons, regionIds: regions.map((r) => r.id) };
  });
}

const ruleSchema = z
  .object({
    name: requiredText(3, 120, "Name"),
    kind: z.enum(RULE_KINDS),
    value: z.coerce.number().refine(Number.isFinite, "Enter a number"),
    threshold: z.union([z.coerce.number().min(0.05).max(1), z.literal("")]).transform((v) => (v === "" ? null : v)),
    minParty: z.union([z.coerce.number().int().min(2).max(12), z.literal("")]).transform((v) => (v === "" ? null : v)),
    dates: z
      .string()
      .trim()
      .max(2000)
      .transform((v) => (v ? v.split(/[\s,]+/).filter(Boolean) : []))
      .pipe(z.array(isoDate).max(100)),
    scope: z.enum(["region", "trail", "global"]),
    regionId: z.union([z.uuid(), z.literal("")]).transform((v) => (v === "" ? null : v)),
    trailId: z.union([z.uuid(), z.literal("")]).transform((v) => (v === "" ? null : v)),
    priority: z.coerce.number().int().min(0).max(10_000),
    effectiveFrom: z.union([isoDate, z.literal("")]).transform((v) => (v === "" ? null : v)),
    effectiveTo: z.union([isoDate, z.literal("")]).transform((v) => (v === "" ? null : v)),
    active: z.boolean(),
  })
  .superRefine((r, ctx) => {
    if (r.kind === "flat_fee") {
      if (Math.abs(r.value) > 100_000 || !Number.isInteger(r.value)) ctx.addIssue({ code: "custom", path: ["value"], message: "Flat fees are whole cents between −100000 and 100000." });
    } else if (r.value < -90 || r.value > 200) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Percentages must be between −90 and 200." });
    }
    if (r.kind === "group_discount_pct" && r.value > 0) ctx.addIssue({ code: "custom", path: ["value"], message: "A group discount should be negative (e.g. −10)." });
    if (r.kind === "high_demand_pct" && r.threshold === null) ctx.addIssue({ code: "custom", path: ["threshold"], message: "High-demand rules need an occupancy threshold (0.05–1)." });
    if (r.kind === "group_discount_pct" && r.minParty === null) ctx.addIssue({ code: "custom", path: ["minParty"], message: "Group discounts need a minimum party size." });
    if (r.kind === "holiday_pct" && r.dates.length === 0) ctx.addIssue({ code: "custom", path: ["dates"], message: "Holiday rules need at least one date." });
    if (r.scope === "trail" && !r.trailId) ctx.addIssue({ code: "custom", path: ["trailId"], message: "Choose the trail this rule applies to." });
    if (r.scope === "region" && !r.regionId) ctx.addIssue({ code: "custom", path: ["regionId"], message: "Choose the region." });
    if (r.effectiveFrom && r.effectiveTo && r.effectiveTo < r.effectiveFrom) ctx.addIssue({ code: "custom", path: ["effectiveTo"], message: "The end date is before the start date." });
  });
export type PricingRuleInput = z.input<typeof ruleSchema>;

function ruleParams(r: z.output<typeof ruleSchema>): Record<string, JsonValue> {
  if (r.kind === "high_demand_pct") return { threshold: r.threshold };
  if (r.kind === "group_discount_pct") return { minParty: r.minParty };
  if (r.kind === "holiday_pct") return { dates: r.dates };
  return {};
}

export async function savePricingRule(user: SessionUser, ruleId: string | null, input: PricingRuleInput): Promise<ActionResult<{ id: string }>> {
  assertCan(user, "pricing.manage");
  if (ruleId !== null && !isUuid(ruleId)) return fail("Pricing rule not found.");
  const p = ruleSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const d = p.data;
  const regionId = d.scope === "region" ? d.regionId : null;
  const trailId = d.scope === "trail" ? d.trailId : null;
  const params = ruleParams(d);
  return guarded(() =>
    staffTx(user, async (tx) => {
      if (ruleId === null) {
        const [row] = await tx<{ id: string }[]>`
          insert into public.pricing_rules (name, kind, value, params, region_id, trail_id, active, priority, effective_from, effective_to, created_by)
          values (${d.name}, ${d.kind}, ${d.value}, ${tx.json(params)}, ${regionId}, ${trailId}, ${d.active}, ${d.priority},
                  ${d.effectiveFrom}::date, ${d.effectiveTo}::date, ${user.id})
          returning id`;
        await auditInStaffTx(tx, user, "pricing.rule_created", "pricing_rule", row.id, { name: d.name, kind: d.kind, value: d.value, params, regionId, trailId, active: d.active });
        return ok("Pricing rule created. It applies to new quotes immediately.", { data: { id: row.id } });
      }
      const [before] = await tx<{ name: string; kind: string; value: number; params: unknown; active: boolean; priority: number }[]>`
        select name, kind, value, params, active, priority from public.pricing_rules where id = ${ruleId} for update`;
      if (!before) return fail("Pricing rule not found.");
      await tx`
        update public.pricing_rules set name = ${d.name}, kind = ${d.kind}, value = ${d.value}, params = ${tx.json(params)},
          region_id = ${regionId}, trail_id = ${trailId}, active = ${d.active}, priority = ${d.priority},
          effective_from = ${d.effectiveFrom}::date, effective_to = ${d.effectiveTo}::date
        where id = ${ruleId}`;
      await auditInStaffTx(tx, user, "pricing.rule_updated", "pricing_rule", ruleId, {
        before,
        after: { name: d.name, kind: d.kind, value: d.value, params, active: d.active, priority: d.priority },
      });
      return ok("Pricing rule saved. Existing bookings keep the price they were quoted.", { data: { id: ruleId } });
    }),
  );
}

export async function deletePricingRule(user: SessionUser, ruleId: string): Promise<ActionResult> {
  assertCan(user, "pricing.manage");
  if (!isUuid(ruleId)) return fail("Pricing rule not found.");
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [row] = await tx<{ name: string; kind: string; value: number }[]>`delete from public.pricing_rules where id = ${ruleId} returning name, kind, value`;
      if (!row) return fail("Pricing rule not found.");
      await auditInStaffTx(tx, user, "pricing.rule_deleted", "pricing_rule", ruleId, { ...row });
      return ok(`Deleted “${row.name}”.`);
    }),
  );
}

const centsFromDollars = z.coerce
  .number()
  .min(0, "Price cannot be negative")
  .max(10_000, "Price looks too high")
  .transform((v) => Math.round(v * 100));

export async function updateTrailBasePrice(user: SessionUser, trailId: string, dollars: unknown): Promise<ActionResult> {
  assertCan(user, "pricing.manage");
  if (!isUuid(trailId)) return fail("Trail not found.");
  const p = centsFromDollars.safeParse(dollars);
  if (!p.success) return zodFail(p.error);
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [before] = await tx<{ basePriceCents: number; name: string }[]>`select base_price_cents, name from public.trails where id = ${trailId} for update`;
      if (!before) return fail("Trail not found.");
      await tx`update public.trails set base_price_cents = ${p.data} where id = ${trailId}`;
      await auditInStaffTx(tx, user, "pricing.base_price_updated", "trail", trailId, { from: before.basePriceCents, to: p.data });
      return ok(`${before.name}: base price per person saved.`);
    }),
  );
}

export async function updateAddonPricing(user: SessionUser, addonId: string, input: { dollars: unknown; active: boolean }): Promise<ActionResult> {
  assertCan(user, "pricing.manage");
  if (!isUuid(addonId)) return fail("Add-on not found.");
  const p = centsFromDollars.safeParse(input.dollars);
  if (!p.success) return zodFail(p.error);
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [before] = await tx<{ priceCents: number; active: boolean; name: string }[]>`select price_cents, active, name from public.addons where id = ${addonId} for update`;
      if (!before) return fail("Add-on not found.");
      await tx`update public.addons set price_cents = ${p.data}, active = ${input.active === true} where id = ${addonId}`;
      await auditInStaffTx(tx, user, "pricing.addon_updated", "addon", addonId, { from: { priceCents: before.priceCents, active: before.active }, to: { priceCents: p.data, active: input.active === true } });
      return ok(`${before.name} saved.`);
    }),
  );
}
