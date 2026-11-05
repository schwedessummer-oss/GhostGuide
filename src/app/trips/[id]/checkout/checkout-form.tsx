"use client";

import { useActionState, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { Alert, Badge, Button, Field, Input, Select, SimulatedBadge } from "@/components/ui";
import { PriceBreakdown } from "@/components/commerce/price-breakdown";
import { formatMoney } from "@/lib/format";
import type { QuoteLine } from "@/domain/pricing";
import { startCheckoutAction, type CheckoutFormState } from "./actions";

export interface AddonOption {
  code: string;
  name: string;
  description: string;
  kind: string;
  priceCents: number;
  pricingUnit: "per_booking" | "per_person";
  requiresCustomerConfirmation: boolean;
  remaining: number | null;
}

export interface CheckoutFormProps {
  tripId: string;
  idempotencyKey: string;
  minDate: string;
  maxDate: string;
  initial: { date: string; partySize: number; addonCodes: string[]; pickup: string };
  addons: AddonOption[];
  pickupPoints: { key: string; label: string }[];
  quote: { lines: QuoteLine[]; totalCents: number; currency: string } | null;
  quoteError: string | null;
  availability: { capacity: number; remaining: number; blocked: boolean };
  holdMinutes: number;
  providerSimulated: boolean;
  demoMode: boolean;
  disabledReason: string | null;
}

const unitLabel = (a: AddonOption) => (a.pricingUnit === "per_person" ? "per person" : "per booking");

export function CheckoutForm(props: CheckoutFormProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [isUpdating, startTransition] = useTransition();
  const [date, setDate] = useState(props.initial.date);
  const [partySize, setPartySize] = useState(props.initial.partySize);
  const [addonCodes, setAddonCodes] = useState<string[]>(props.initial.addonCodes);
  const [pickup, setPickup] = useState(props.initial.pickup);
  const [state, formAction, submitting] = useActionState<CheckoutFormState, FormData>(startCheckoutAction.bind(null, props.tripId), undefined);
  const idempotencyKey = state?.newIdempotencyKey ?? props.idempotencyKey;

  // Re-price on the server whenever a choice changes (the server is the only source of prices).
  function update(next: Partial<{ date: string; partySize: number; addonCodes: string[]; pickup: string }>) {
    const v = { date, partySize, addonCodes, pickup, ...next };
    const qs = new URLSearchParams({ date: v.date, party: String(v.partySize) });
    if (v.addonCodes.length) qs.set("addons", v.addonCodes.join(","));
    if (v.pickup) qs.set("pickup", v.pickup);
    startTransition(() => router.replace(`${pathname}?${qs.toString()}`, { scroll: false }));
  }

  const shuttleSelected = props.addons.some((a) => a.kind === "shuttle" && addonCodes.includes(a.code));
  const soldOut = props.availability.blocked || props.availability.remaining < partySize;
  const cannotSubmit = !!props.disabledReason || !!props.quoteError || soldOut || submitting || isUpdating;

  return (
    <form action={formAction} className="grid gap-6 lg:grid-cols-5" noValidate>
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div className="space-y-6 lg:col-span-3">
        <fieldset className="space-y-5 rounded-[var(--radius-card)] border border-sand-200 bg-surface p-5 sm:p-6">
          <legend className="px-1 text-lg font-bold">Your hike</legend>
          <Field label="Hike date" htmlFor="hikeDate" required hint="Dates are in the trail's local time zone.">
            <Input
              id="hikeDate"
              name="hikeDate"
              type="date"
              required
              min={props.minDate}
              max={props.maxDate}
              value={date}
              aria-describedby="hikeDate-hint availability"
              onChange={(e) => {
                setDate(e.target.value);
                if (e.target.value) update({ date: e.target.value });
              }}
            />
          </Field>
          <p id="availability" className="text-sm" aria-live="polite">
            {props.availability.blocked ? (
              <Badge tone="red">Not available on this date</Badge>
            ) : props.availability.remaining <= 0 ? (
              <Badge tone="red">Fully booked on this date</Badge>
            ) : (
              <>
                <Badge tone={props.availability.remaining < 5 ? "amber" : "forest"}>
                  {props.availability.remaining} of {props.availability.capacity} spots left
                </Badge>{" "}
                <span className="text-muted">Spots are only held once you continue to payment.</span>
              </>
            )}
          </p>
          <Field label="Number of hikers" htmlFor="partySize" required>
            <Select
              id="partySize"
              name="partySize"
              value={partySize}
              onChange={(e) => {
                const n = Number(e.target.value);
                setPartySize(n);
                update({ partySize: n });
              }}
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n} {n === 1 ? "hiker" : "hikers"}
                </option>
              ))}
            </Select>
          </Field>
        </fieldset>

        {props.addons.length ? (
          <fieldset className="space-y-3 rounded-[var(--radius-card)] border border-sand-200 bg-surface p-5 sm:p-6">
            <legend className="px-1 text-lg font-bold">Optional add-ons</legend>
            <p className="text-sm text-muted">Provided by partners. Partner services in this demo are simulated.</p>
            {props.addons.map((a) => {
              const units = a.pricingUnit === "per_person" ? partySize : 1;
              const unavailable = a.remaining != null && a.remaining < units && !addonCodes.includes(a.code);
              const checked = addonCodes.includes(a.code);
              return (
                <div key={a.code} className="rounded-xl border border-sand-200 p-3 has-[:checked]:border-forest-600 has-[:checked]:bg-forest-50">
                  <label className="flex min-h-11 cursor-pointer items-start gap-3">
                    <input
                      type="checkbox"
                      name="addon"
                      value={a.code}
                      className="mt-1 size-5 accent-forest-700"
                      checked={checked}
                      disabled={unavailable}
                      aria-describedby={`addon-${a.code}-desc`}
                      onChange={(e) => {
                        const next = e.target.checked ? [...addonCodes, a.code] : addonCodes.filter((c) => c !== a.code);
                        setAddonCodes(next);
                        update({ addonCodes: next });
                      }}
                    />
                    <span className="flex-1">
                      <span className="flex flex-wrap items-baseline justify-between gap-2">
                        <span className="font-semibold">{a.name}</span>
                        <span className="tabular-nums">
                          {formatMoney(a.priceCents)} <span className="text-sm text-muted">{unitLabel(a)}</span>
                        </span>
                      </span>
                      <span id={`addon-${a.code}-desc`} className="block text-sm text-muted">
                        {a.description}
                        {a.kind === "satellite_device" ? " Ghost Guide does not provide SOS; the device's own service applies." : ""}
                        {unavailable ? " Sold out for this date." : a.remaining != null && a.remaining < 4 ? ` Only ${a.remaining} left.` : ""}
                      </span>
                    </span>
                  </label>
                  {a.kind === "shuttle" && checked ? (
                    <div className="mt-3 pl-8">
                      <Field label="Shuttle pickup point" htmlFor="shuttlePickup" hint="You'll confirm the exact pickup time and price before any ride is requested.">
                        <Select
                          id="shuttlePickup"
                          name="shuttlePickup"
                          value={pickup}
                          aria-describedby="shuttlePickup-hint"
                          onChange={(e) => {
                            setPickup(e.target.value);
                            update({ pickup: e.target.value });
                          }}
                        >
                          {props.pickupPoints.map((p) => (
                            <option key={p.key} value={p.key}>
                              {p.label}
                            </option>
                          ))}
                        </Select>
                      </Field>
                    </div>
                  ) : null}
                  {props.demoMode && checked ? (
                    <details className="mt-2 pl-8 text-sm">
                      <summary className="min-h-11 cursor-pointer content-center text-muted">Demo controls: simulate a partner failure</summary>
                      <label htmlFor={`simulate_${a.code}`} className="mt-1 block font-semibold">
                        Partner behaviour (demo only)
                      </label>
                      <Select id={`simulate_${a.code}`} name={`simulate_${a.code}`} defaultValue="">
                        <option value="">Normal</option>
                        <option value="fail_once">Fail once, then succeed on retry</option>
                        <option value="fail">Always fail (retries, then needs attention)</option>
                        <option value="reject">Partner rejects the request</option>
                      </Select>
                    </details>
                  ) : null}
                </div>
              );
            })}
            {shuttleSelected ? null : <input type="hidden" name="shuttlePickup" value="" />}
          </fieldset>
        ) : null}
      </div>

      <div className="lg:col-span-2">
        <section aria-labelledby="quote-heading" className="sticky top-4 space-y-4 rounded-[var(--radius-card)] border border-sand-200 bg-surface p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="quote-heading" className="text-lg font-bold">
              Price
            </h2>
            {props.providerSimulated ? <SimulatedBadge label="Simulated payment" /> : null}
          </div>
          <div aria-live="polite" aria-busy={isUpdating}>
            {isUpdating ? <p className="text-sm text-muted">Updating price…</p> : null}
            {props.quoteError ? (
              <Alert tone="amber">{props.quoteError}</Alert>
            ) : props.quote ? (
              <div className={isUpdating ? "opacity-60" : undefined}>
                <PriceBreakdown lines={props.quote.lines} totalCents={props.quote.totalCents} currency={props.quote.currency} caption="Price quote" />
              </div>
            ) : null}
          </div>
          <p className="text-sm text-muted">
            Prices come from published pricing rules (weekend, holiday, demand and group adjustments are listed line by line). The final amount is
            recalculated on our server when you continue.
          </p>
          <p className="text-sm text-muted">We hold your spots for {props.holdMinutes} minutes while you pay. Your booking is confirmed only once the payment provider confirms payment.</p>
          {state?.error ? (
            <Alert tone="red" live="assertive">
              {state.error}
            </Alert>
          ) : null}
          {props.disabledReason ? <Alert tone="amber">{props.disabledReason}</Alert> : null}
          <Button type="submit" size="lg" className="w-full" disabled={cannotSubmit} aria-disabled={cannotSubmit}>
            <Lock aria-hidden className="size-4" />
            {submitting ? "Starting secure checkout…" : "Continue to secure payment"}
          </Button>
          {props.providerSimulated ? (
            <p className="text-center text-xs text-muted">Demo mode: the next page is a simulated checkout. No real payment is taken.</p>
          ) : null}
        </section>
      </div>
    </form>
  );
}
