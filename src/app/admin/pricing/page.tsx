import type { Metadata } from "next";
import { Card } from "@/components/ui";
import { AdminHeader, DemoBadge, Section, StatusBadge, money } from "@/components/admin/admin-ui";
import { ActionForm } from "@/components/admin/action-form";
import { CheckField, SelectField, TextField } from "@/components/admin/fields";
import { PricingPreview } from "@/components/admin/pricing-preview";
import { requirePermission } from "@/server/auth";
import { getPricingData, RULE_KINDS, type PricingRuleRow, type PricingTrail } from "@/server/admin/pricing";
import { getLaunchRegion } from "@/server/catalog/trails";
import { localDateInZone } from "@/lib/time";
import { addonPriceAction, deleteRuleAction, saveRuleAction, trailPriceAction } from "./actions";

export const metadata: Metadata = { title: "Pricing" };

const KIND_HELP: Record<string, string> = {
  weekend_pct: "Saturdays and Sundays (percent of the base price)",
  holiday_pct: "Listed dates (percent)",
  high_demand_pct: "When occupancy ≥ threshold (percent)",
  group_discount_pct: "Parties of at least N (negative percent)",
  flat_fee: "Fixed amount in cents added to every booking",
};

function RuleFields({ idPrefix, r, trails, regionId }: { idPrefix: string; r?: PricingRuleRow; trails: PricingTrail[]; regionId: string }) {
  const scope = r ? (r.trailId ? "trail" : r.regionId ? "region" : "global") : "region";
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
      <TextField id={`${idPrefix}-name`} name="name" label="Name (shown on quotes)" required minLength={3} maxLength={120} defaultValue={r?.name ?? ""} className="sm:col-span-2 xl:col-span-1" />
      <SelectField id={`${idPrefix}-kind`} name="kind" label="Kind" options={RULE_KINDS.map((k) => ({ value: k, label: `${k.replace(/_/g, " ")} — ${KIND_HELP[k]}` }))} defaultValue={r?.kind ?? "weekend_pct"} />
      <TextField id={`${idPrefix}-value`} name="value" label="Value (% or cents for flat fee)" type="number" step="any" required defaultValue={r?.value ?? ""} />
      <TextField id={`${idPrefix}-thr`} name="threshold" label="High-demand threshold (0–1)" type="number" step="0.05" min="0.05" max="1" defaultValue={r?.params.threshold ?? ""} />
      <TextField id={`${idPrefix}-min`} name="minParty" label="Group minimum party" type="number" min="2" max="12" defaultValue={r?.params.minParty ?? ""} />
      <TextField id={`${idPrefix}-dates`} name="dates" label="Holiday dates" placeholder="2026-12-25, 2027-01-01" defaultValue={(r?.params.dates ?? []).join(", ")} />
      <SelectField
        id={`${idPrefix}-scope`}
        name="scope"
        label="Applies to"
        options={[
          { value: "region", label: "Launch region" },
          { value: "trail", label: "One trail" },
          { value: "global", label: "All regions" },
        ]}
        defaultValue={scope}
      />
      <input type="hidden" name="regionId" value={regionId} />
      <SelectField id={`${idPrefix}-trail`} name="trailId" label="Trail (when “One trail”)" options={trails.map((t) => ({ value: t.id, label: t.name }))} placeholder="—" defaultValue={r?.trailId ?? ""} />
      <TextField id={`${idPrefix}-prio`} name="priority" label="Priority (lower first)" type="number" min="0" max="10000" required defaultValue={r?.priority ?? 100} />
      <TextField id={`${idPrefix}-from`} name="effectiveFrom" label="Effective from" type="date" defaultValue={r?.effectiveFrom ?? ""} />
      <TextField id={`${idPrefix}-to`} name="effectiveTo" label="Effective to" type="date" defaultValue={r?.effectiveTo ?? ""} />
      <CheckField id={`${idPrefix}-active`} name="active" defaultChecked={r ? r.active : true} label="Active" />
    </div>
  );
}

function describeRule(r: PricingRuleRow) {
  const v = r.kind === "flat_fee" ? money(r.value) : `${r.value > 0 ? "+" : ""}${r.value}%`;
  const cond =
    r.kind === "weekend_pct"
      ? "on weekends"
      : r.kind === "holiday_pct"
        ? `on ${(r.params.dates ?? []).join(", ") || "no dates"}`
        : r.kind === "high_demand_pct"
          ? `when ≥ ${Math.round((r.params.threshold ?? 0.75) * 100)}% booked`
          : r.kind === "group_discount_pct"
            ? `for parties of ${r.params.minParty ?? 4}+`
            : "per booking";
  return `${v} ${cond}`;
}

export default async function PricingPage() {
  const user = await requirePermission("pricing.manage", "/admin/pricing");
  const [data, region] = await Promise.all([getPricingData(user), getLaunchRegion()]);
  const today = localDateInZone(new Date(), region.timezone);

  return (
    <>
      <AdminHeader
        title="Pricing"
        description="Transparent, rule-based pricing. Percentage rules apply to the base price and do not compound; every adjustment appears as its own line on the customer's quote. Machine-learned or opaque dynamic pricing is not used."
      />

      <Section id="preview" title="Live preview" description="Uses the same calculation as customer quotes and checkout. Nothing is saved.">
        <Card>
          <PricingPreview
            rules={data.rules.map((r) => ({ id: r.id, name: r.name, kind: r.kind, value: r.value, params: r.params, regionId: r.regionId, trailId: r.trailId, active: r.active, priority: r.priority, effectiveFrom: r.effectiveFrom, effectiveTo: r.effectiveTo }))}
            trails={[...data.trails]
              .sort((a, b) => Number(b.status === "published") - Number(a.status === "published") || a.name.localeCompare(b.name))
              .map((t) => ({ id: t.id, name: `${t.name}${t.status !== "published" ? ` (${t.status})` : ""}`, regionId: t.regionId, basePriceCents: t.basePriceCents, currency: t.currency }))}
            addons={data.addons.map((a) => ({ code: a.code, name: a.name, priceCents: a.priceCents, pricingUnit: a.pricingUnit, active: a.active }))}
            today={today}
          />
        </Card>
      </Section>

      <Section id="rules" title="Pricing rules" description="Changes apply to new quotes immediately. Existing bookings keep the price they were charged.">
        <ul className="space-y-3">
          {data.rules.map((r) => (
            <li key={r.id}>
              <details className="rounded-xl border border-sand-200 bg-surface">
                <summary className="flex min-h-12 cursor-pointer list-none flex-wrap items-center gap-2 p-4 [&::-webkit-details-marker]:hidden">
                  <span className="font-semibold">{r.name}</span>
                  <StatusBadge status={r.active ? "active" : "retired"} label={r.active ? "Active" : "Inactive"} />
                  <span className="text-sm text-muted">
                    {describeRule(r)} · {r.trailName ? `trail: ${r.trailName}` : r.regionId ? "region" : "all regions"} · priority {r.priority}
                    {r.effectiveFrom || r.effectiveTo ? ` · ${r.effectiveFrom ?? "…"} → ${r.effectiveTo ?? "…"}` : ""}
                  </span>
                </summary>
                <div className="space-y-4 border-t border-sand-200 p-4">
                  <ActionForm action={saveRuleAction.bind(null, r.id)} submitLabel="Save rule">
                    <RuleFields idPrefix={`rule-${r.id}`} r={r} trails={data.trails} regionId={r.regionId ?? data.regionIds[0] ?? ""} />
                  </ActionForm>
                  <ActionForm action={deleteRuleAction.bind(null, r.id)} submitLabel="Delete rule" variant="danger" compact>
                    <CheckField id={`rule-${r.id}-del`} name="confirm" required label="Delete permanently (deactivate instead to keep it for later)." />
                  </ActionForm>
                </div>
              </details>
            </li>
          ))}
        </ul>
        <Card className="mt-4">
          <h3 className="mb-3 font-semibold">Add a rule</h3>
          <ActionForm action={saveRuleAction.bind(null, null)} submitLabel="Create rule">
            <RuleFields idPrefix="rule-new" trails={data.trails} regionId={region.id} />
          </ActionForm>
        </Card>
      </Section>

      <Section id="base" title="Trail base prices" description="Price per person before rules.">
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {data.trails.map((t) => (
            <li key={t.id}>
              <Card className="p-4 sm:p-4">
                <p className="flex flex-wrap items-center gap-2 font-semibold">
                  {t.name} {t.isDemo ? <DemoBadge /> : null} <StatusBadge status={t.status} />
                </p>
                <ActionForm action={trailPriceAction.bind(null, t.id)} submitLabel="Save price" compact inline className="mt-2">
                  <TextField id={`tp-${t.id}`} name="price" label={`Base price (${t.currency.toUpperCase()})`} type="number" step="0.01" min="0" required defaultValue={(t.basePriceCents / 100).toFixed(2)} />
                </ActionForm>
              </Card>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="addons" title="Add-on prices" description="Partner add-ons are simulated in this deployment. Inactive add-ons are not offered to customers.">
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {data.addons.map((a) => (
            <li key={a.id}>
              <Card className="p-4 sm:p-4">
                <p className="font-semibold">{a.name}</p>
                <p className="text-sm text-muted">
                  {a.kind.replace(/_/g, " ")} · {a.pricingUnit === "per_person" ? "per person" : "per booking"}
                </p>
                <ActionForm action={addonPriceAction.bind(null, a.id)} submitLabel="Save add-on" compact inline className="mt-2">
                  <TextField id={`ap-${a.id}`} name="price" label="Price (USD)" type="number" step="0.01" min="0" required defaultValue={(a.priceCents / 100).toFixed(2)} />
                  <CheckField id={`ap-${a.id}-active`} name="active" defaultChecked={a.active} label="Offered" />
                </ActionForm>
              </Card>
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}
