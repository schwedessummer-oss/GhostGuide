import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import type { PricingRule, PricingRuleKind } from "@/domain/pricing";
import type { JsonValue, Tx } from "@/server/db";
import { assertCan, auditInStaffTx, blankAsNull, fail, guarded, isUuid, isoDate, notBlank, ok, requiredText, staffTx, zodFail, type ActionResult } from "./common";

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
  description: string;
  kind: string;
  providerKey: string;
  priceCents: number;
  pricingUnit: "per_booking" | "per_person";
  requiresCustomerConfirmation: boolean;
  dailyCapacity: number | null;
  regionId: string | null;
  regionName: string | null;
  active: boolean;
}
export interface PricingRegion {
  id: string;
  name: string;
}
export interface PricingRuleRow extends PricingRule {
  trailName: string | null;
  updatedAt: Date;
}

export async function getPricingData(
  user: SessionUser,
): Promise<{ rules: PricingRuleRow[]; trails: PricingTrail[]; addons: PricingAddon[]; regionIds: string[]; regions: PricingRegion[] }> {
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
      tx<PricingAddon[]>`
        select a.id, a.code, a.name, a.description, a.kind, a.provider_key, a.price_cents, a.pricing_unit, a.requires_customer_confirmation,
               a.daily_capacity, a.region_id, rg.name as region_name, a.active
        from public.addons a left join public.regions rg on rg.id = a.region_id
        order by a.active desc, a.name`,
      tx<PricingRegion[]>`select id, name from public.regions order by name`,
    ]);
    return { rules, trails, addons, regionIds: regions.map((r) => r.id), regions };
  });
}

const ruleSchema = z
  .object({
    name: requiredText(3, 120, "Name"),
    kind: z.enum(RULE_KINDS),
    value: notBlank(z.coerce.number("Enter a number.").refine(Number.isFinite, "Enter a number."), "Enter the rule value."),
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

/** Dollars → cents. Blank is an error, never $0 (Number("") is 0). */
const centsFromDollars = notBlank(
  z.coerce.number("Enter a price in dollars, e.g. 12.50.").min(0, "Price cannot be negative.").max(10_000, "Price looks too high."),
  "Enter a price (0 for free).",
).transform((v) => Math.round(v * 100));

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

// ---------------------------------------------------------------------------
// Add-on configuration (admin only: pricing.manage; the addons table is
// admin-write in RLS, see 20261105009000_security_hardening.sql)
// ---------------------------------------------------------------------------

/** Kinds with a partner adapter and an addon_<kind> feature flag. */
export const ADDON_KINDS = ["gear_locker", "shuttle", "meal_pack", "satellite_device"] as const;
export const ADDON_UNITS = ["per_booking", "per_person"] as const;
/** Only simulated ("demo") partner adapters exist (src/integrations/partners). */
export const ADDON_PROVIDER_KEY = "demo";

const trimmed = (v: unknown) => (v === null || v === undefined ? "" : typeof v === "string" ? v.trim() : v);

/** Empty = no daily limit (NULL). The empty check comes before number coercion (Number("") is 0). */
export const addonCapacitySchema = blankAsNull(
  z.coerce
    .number("Enter a whole number, or leave it empty for no daily limit.")
    .int("Enter a whole number, or leave it empty for no daily limit.")
    .min(1, "Daily capacity must be at least 1 (leave it empty for no daily limit).")
    .max(10_000, "Daily capacity can be at most 10000."),
);

const addonFieldsSchema = z.object({
  name: requiredText(3, 120, "Name"),
  description: z.preprocess(trimmed, z.string().max(1000, "Keep the description under 1000 characters.")),
  price: centsFromDollars,
  pricingUnit: z.enum(ADDON_UNITS, "Choose per booking or per person."),
  dailyCapacity: addonCapacitySchema,
  requiresCustomerConfirmation: z.boolean(),
  regionId: z.preprocess(trimmed, z.union([z.literal("").transform(() => null), z.uuid("Choose a region.")])),
  active: z.boolean(),
});
const addonCreateSchema = addonFieldsSchema.extend({
  code: z.preprocess(
    (v) => (typeof v === "string" ? v.trim().toLowerCase() : v),
    z.string("Enter a code.").regex(/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/, "Use 3–60 lowercase letters, digits and hyphens for the code (e.g. meal-pack)."),
  ),
  kind: z.enum(ADDON_KINDS, "Choose the add-on type."),
});
export type AddonInput = z.input<typeof addonFieldsSchema>;
export type AddonCreateInput = z.input<typeof addonCreateSchema>;
type AddonFields = z.output<typeof addonFieldsSchema>;

/**
 * Product rules for add-ons (honesty & safety): a shuttle always needs the
 * customer to confirm pickup location, price and time before any paid ride
 * is requested; a satellite device rental must not read as an SOS service.
 */
export function addonRuleCheck(kind: string, d: Pick<AddonFields, "requiresCustomerConfirmation" | "description">): { error?: string; warnings: string[] } {
  const warnings: string[] = [];
  if (kind === "shuttle" && !d.requiresCustomerConfirmation) {
    return { error: "Shuttle add-ons must require customer confirmation: customers confirm the pickup location, price and time before any ride is requested.", warnings };
  }
  if (kind === "satellite_device" && !/(does not|doesn['’]t|not) provide (an? )?SOS/i.test(d.description)) {
    warnings.push("Say in the description that Ghost Guide does not provide SOS service (the device's own service applies).");
  }
  return { warnings };
}

async function addonRegionExists(tx: Tx, regionId: string | null): Promise<boolean> {
  if (!regionId) return true;
  const [r] = await tx<{ id: string }[]>`select id from public.regions where id = ${regionId}`;
  return !!r;
}

async function addonFlagWarning(tx: Tx, kind: string, active: boolean): Promise<string[]> {
  if (!active) return [];
  const [f] = await tx<{ enabled: boolean }[]>`select enabled from public.feature_flags where key = ${`addon_${kind}`}`;
  return f?.enabled ? [] : [`Customers will not see it until the feature flag addon_${kind} is turned on (Feature flags).`];
}

const addonAuditView = (d: AddonFields) => ({
  name: d.name,
  priceCents: d.price,
  pricingUnit: d.pricingUnit,
  dailyCapacity: d.dailyCapacity,
  requiresCustomerConfirmation: d.requiresCustomerConfirmation,
  regionId: d.regionId,
  active: d.active,
});

/** Create an add-on (admin; audited). The partner adapter is the simulated "demo" one. */
export async function createAddon(user: SessionUser, input: AddonCreateInput): Promise<ActionResult<{ id: string }>> {
  assertCan(user, "pricing.manage");
  const p = addonCreateSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const d = p.data;
  const rules = addonRuleCheck(d.kind, d);
  if (rules.error) return fail(rules.error);
  return guarded(() =>
    staffTx(user, async (tx) => {
      if (!(await addonRegionExists(tx, d.regionId))) return fail("Choose a region.");
      const [dup] = await tx<{ id: string }[]>`select id from public.addons where code = ${d.code}`;
      if (dup) return fail(`The code “${d.code}” is already used by another add-on.`);
      const [row] = await tx<{ id: string }[]>`
        insert into public.addons (code, name, description, kind, provider_key, price_cents, pricing_unit, requires_customer_confirmation, daily_capacity, active, region_id)
        values (${d.code}, ${d.name}, ${d.description}, ${d.kind}, ${ADDON_PROVIDER_KEY}, ${d.price}, ${d.pricingUnit}, ${d.requiresCustomerConfirmation},
                ${d.dailyCapacity}, ${d.active}, ${d.regionId})
        returning id`;
      await auditInStaffTx(tx, user, "pricing.addon_created", "addon", row.id, { code: d.code, kind: d.kind, providerKey: ADDON_PROVIDER_KEY, ...addonAuditView(d) });
      return ok(`Add-on “${d.name}” created. Partner fulfillment is simulated in this deployment.`, {
        data: { id: row.id },
        warnings: [...rules.warnings, ...(await addonFlagWarning(tx, d.kind, d.active))],
      });
    }),
  );
}

/** Edit an add-on's configuration and price (admin; audited with before/after). Code and kind are fixed after creation. */
export async function updateAddon(user: SessionUser, addonId: string, input: AddonInput): Promise<ActionResult> {
  assertCan(user, "pricing.manage");
  if (!isUuid(addonId)) return fail("Add-on not found.");
  const p = addonFieldsSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const d = p.data;
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [before] = await tx<
        {
          kind: string;
          name: string;
          priceCents: number;
          pricingUnit: string;
          dailyCapacity: number | null;
          requiresCustomerConfirmation: boolean;
          regionId: string | null;
          active: boolean;
          description: string;
        }[]
      >`
        select kind, name, price_cents, pricing_unit, daily_capacity, requires_customer_confirmation, region_id, active, description
        from public.addons where id = ${addonId} for update`;
      if (!before) return fail("Add-on not found.");
      const rules = addonRuleCheck(before.kind, d);
      if (rules.error) return fail(rules.error);
      if (!(await addonRegionExists(tx, d.regionId))) return fail("Choose a region.");
      await tx`
        update public.addons set name = ${d.name}, description = ${d.description}, price_cents = ${d.price}, pricing_unit = ${d.pricingUnit},
          daily_capacity = ${d.dailyCapacity}, requires_customer_confirmation = ${d.requiresCustomerConfirmation}, region_id = ${d.regionId}, active = ${d.active}
        where id = ${addonId}`;
      const { kind, description, ...beforeView } = before;
      await auditInStaffTx(tx, user, "pricing.addon_updated", "addon", addonId, {
        kind,
        before: beforeView,
        after: addonAuditView(d),
        descriptionChanged: description !== d.description,
      });
      const warnings = [...rules.warnings, ...(await addonFlagWarning(tx, kind, d.active))];
      if (before.priceCents !== d.price || before.pricingUnit !== d.pricingUnit) warnings.push("Existing bookings keep the add-on price they were charged.");
      return ok(`${d.name} saved.`, { warnings });
    }),
  );
}
