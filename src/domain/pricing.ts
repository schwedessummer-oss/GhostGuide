/**
 * Transparent, rule-based pricing (no ML). Pure and deterministic so the
 * customer quote, the checkout amount and the admin preview always agree.
 *
 *  base     = trail base price per person × party size
 *  adjust   = each applicable percentage rule × base (non-compounding),
 *             applied in priority order; flat fees added as-is
 *  addons   = per-person or per-booking add-on prices
 *  total    = max(0, base + adjustments) + addons
 */
export type PricingRuleKind = "weekend_pct" | "holiday_pct" | "high_demand_pct" | "group_discount_pct" | "flat_fee";

export interface PricingRule {
  id: string;
  name: string;
  kind: PricingRuleKind;
  value: number;
  params: { threshold?: number; minParty?: number; dates?: string[] };
  regionId: string | null;
  trailId: string | null;
  active: boolean;
  priority: number;
  effectiveFrom: string | null; // YYYY-MM-DD
  effectiveTo: string | null; // YYYY-MM-DD
}

export interface AddonSelection {
  code: string;
  name: string;
  priceCents: number;
  pricingUnit: "per_booking" | "per_person";
}

export interface QuoteInput {
  basePriceCents: number;
  partySize: number;
  hikeDate: string; // YYYY-MM-DD (region-local calendar date)
  /** share of daily capacity already booked or held, 0..1, excluding this booking */
  occupancy: number;
  regionId: string;
  trailId: string;
  rules: PricingRule[];
  addons: AddonSelection[];
  currency: string;
}

export interface QuoteLine {
  kind: "base" | "adjustment" | "addon";
  label: string;
  amountCents: number;
  ruleId?: string;
  addonCode?: string;
  quantity?: number;
}

export interface Quote {
  currency: string;
  lines: QuoteLine[];
  baseCents: number;
  adjustmentsCents: number;
  subtotalCents: number;
  addonsCents: number;
  totalCents: number;
  /** version tag so stored breakdowns can be interpreted later */
  pricingVersion: 1;
}

export function isWeekend(date: string): boolean {
  const d = new Date(`${date}T12:00:00Z`).getUTCDay();
  return d === 0 || d === 6;
}

function ruleInScope(rule: PricingRule, input: QuoteInput): boolean {
  if (!rule.active) return false;
  if (rule.trailId && rule.trailId !== input.trailId) return false;
  if (rule.regionId && rule.regionId !== input.regionId) return false;
  if (rule.effectiveFrom && input.hikeDate < rule.effectiveFrom) return false;
  if (rule.effectiveTo && input.hikeDate > rule.effectiveTo) return false;
  return true;
}

export function ruleApplies(rule: PricingRule, input: QuoteInput): boolean {
  if (!ruleInScope(rule, input)) return false;
  switch (rule.kind) {
    case "weekend_pct":
      return isWeekend(input.hikeDate);
    case "holiday_pct":
      return (rule.params.dates ?? []).includes(input.hikeDate);
    case "high_demand_pct":
      return input.occupancy >= (rule.params.threshold ?? 0.75);
    case "group_discount_pct":
      return input.partySize >= (rule.params.minParty ?? 4);
    case "flat_fee":
      return true;
  }
}

export function quotePrice(input: QuoteInput): Quote {
  if (!Number.isInteger(input.partySize) || input.partySize < 1 || input.partySize > 12) throw new Error("partySize must be 1–12");
  if (input.basePriceCents < 0) throw new Error("basePriceCents must be >= 0");
  const lines: QuoteLine[] = [];
  const baseCents = input.basePriceCents * input.partySize;
  lines.push({ kind: "base", label: `Self-guided experience × ${input.partySize}`, amountCents: baseCents, quantity: input.partySize });

  let adjustmentsCents = 0;
  const applicable = input.rules.filter((r) => ruleApplies(r, input)).sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  for (const rule of applicable) {
    const amount = rule.kind === "flat_fee" ? Math.round(rule.value) : Math.round((baseCents * rule.value) / 100);
    if (amount === 0) continue;
    adjustmentsCents += amount;
    const pct = rule.kind === "flat_fee" ? "" : ` (${rule.value > 0 ? "+" : ""}${rule.value}%)`;
    lines.push({ kind: "adjustment", label: `${rule.name}${pct}`, amountCents: amount, ruleId: rule.id });
  }
  // Discounts can never make the experience negative.
  const subtotalCents = Math.max(0, baseCents + adjustmentsCents);
  adjustmentsCents = subtotalCents - baseCents;

  let addonsCents = 0;
  for (const a of input.addons) {
    const quantity = a.pricingUnit === "per_person" ? input.partySize : 1;
    const amount = a.priceCents * quantity;
    addonsCents += amount;
    lines.push({ kind: "addon", label: quantity > 1 ? `${a.name} × ${quantity}` : a.name, amountCents: amount, addonCode: a.code, quantity });
  }
  return {
    currency: input.currency,
    lines,
    baseCents,
    adjustmentsCents,
    subtotalCents,
    addonsCents,
    totalCents: subtotalCents + addonsCents,
    pricingVersion: 1,
  };
}
