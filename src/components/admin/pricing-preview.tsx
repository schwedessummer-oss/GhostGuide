"use client";

import { useId, useMemo, useState } from "react";
import { quotePrice, ruleApplies, type PricingRule } from "@/domain/pricing";

/**
 * Live price preview using the SAME pure quotePrice() that customer quotes
 * and checkout use. Updates as you type; nothing is saved.
 */
export interface PreviewTrail {
  id: string;
  name: string;
  regionId: string;
  basePriceCents: number;
  currency: string;
}
export interface PreviewAddon {
  code: string;
  name: string;
  priceCents: number;
  pricingUnit: "per_booking" | "per_person";
  active: boolean;
}

const money = (c: number, cur: string) => new Intl.NumberFormat("en-US", { style: "currency", currency: cur.toUpperCase() }).format(c / 100);

export function PricingPreview({ rules, trails, addons, today }: { rules: PricingRule[]; trails: PreviewTrail[]; addons: PreviewAddon[]; today: string }) {
  const id = useId();
  const [trailId, setTrailId] = useState(trails[0]?.id ?? "");
  const [date, setDate] = useState(today);
  const [party, setParty] = useState(2);
  const [occupancy, setOccupancy] = useState(40);
  const [selected, setSelected] = useState<string[]>([]);
  const trail = trails.find((t) => t.id === trailId);

  const result = useMemo(() => {
    if (!trail || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
    const input = {
      basePriceCents: trail.basePriceCents,
      partySize: Math.min(12, Math.max(1, Math.round(party) || 1)),
      hikeDate: date,
      occupancy: Math.min(1, Math.max(0, occupancy / 100)),
      regionId: trail.regionId,
      trailId: trail.id,
      rules,
      addons: addons.filter((a) => selected.includes(a.code)).map((a) => ({ code: a.code, name: a.name, priceCents: a.priceCents, pricingUnit: a.pricingUnit })),
      currency: trail.currency,
    };
    try {
      const quote = quotePrice(input);
      const notApplied = rules.filter((r) => r.active && !ruleApplies(r, input));
      return { quote, notApplied };
    } catch (e) {
      return { error: e instanceof Error ? e.message : "Invalid input" };
    }
  }, [trail, date, party, occupancy, selected, rules, addons]);

  const input = "block w-full min-h-11 rounded-xl border border-sand-300 bg-surface px-3 py-2";
  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div className="space-y-3">
        <div>
          <label htmlFor={`${id}-trail`} className="block text-sm font-semibold">Trail</label>
          <select id={`${id}-trail`} className={input} value={trailId} onChange={(e) => setTrailId(e.target.value)}>
            {trails.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} ({money(t.basePriceCents, t.currency)} / person)
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor={`${id}-date`} className="block text-sm font-semibold">Hike date</label>
            <input id={`${id}-date`} type="date" className={input} value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div>
            <label htmlFor={`${id}-party`} className="block text-sm font-semibold">Party size</label>
            <input id={`${id}-party`} type="number" min={1} max={12} className={input} value={party} onChange={(e) => setParty(Number(e.target.value))} />
          </div>
        </div>
        <div>
          <label htmlFor={`${id}-occ`} className="block text-sm font-semibold">
            Occupancy already booked/held: {occupancy}%
          </label>
          <input id={`${id}-occ`} type="range" min={0} max={100} step={5} className="h-11 w-full accent-forest-700" value={occupancy} onChange={(e) => setOccupancy(Number(e.target.value))} />
        </div>
        <fieldset>
          <legend className="text-sm font-semibold">Add-ons</legend>
          {addons.map((a) => (
            <label key={a.code} className="flex min-h-11 items-center gap-3">
              <input
                type="checkbox"
                className="size-5 accent-forest-700"
                checked={selected.includes(a.code)}
                onChange={(e) => setSelected((s) => (e.target.checked ? [...s, a.code] : s.filter((c) => c !== a.code)))}
              />
              <span>
                {a.name} — {money(a.priceCents, trail?.currency ?? "usd")} {a.pricingUnit === "per_person" ? "per person" : "per booking"}
                {!a.active ? " (inactive)" : ""}
              </span>
            </label>
          ))}
        </fieldset>
      </div>
      <div aria-live="polite" className="rounded-xl border border-sand-200 bg-sand-100 p-4">
        <h3 className="font-semibold">Quote preview</h3>
        {!result ? (
          <p className="text-muted">Choose a trail and date.</p>
        ) : "error" in result ? (
          <p className="text-red-ink">{result.error}</p>
        ) : (
          <>
            <table className="mt-2 w-full text-sm">
              <caption className="sr-only">Every line of the quote</caption>
              <tbody>
                {result.quote.lines.map((l, i) => (
                  <tr key={i} className="border-b border-sand-300 last:border-0">
                    <th scope="row" className="py-1.5 text-left font-normal">
                      {l.label} <span className="text-xs text-muted">({l.kind})</span>
                    </th>
                    <td className="py-1.5 text-right">{money(l.amountCents, result.quote.currency)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row" className="pt-2 text-left font-bold">Total</th>
                  <td className="pt-2 text-right font-bold">{money(result.quote.totalCents, result.quote.currency)}</td>
                </tr>
              </tbody>
            </table>
            {result.notApplied.length ? (
              <p className="mt-3 text-xs text-muted">Active rules not applying here: {result.notApplied.map((r) => r.name).join(", ")}.</p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
