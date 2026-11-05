import { formatMoney } from "@/lib/format";
import type { QuoteLine } from "@/domain/pricing";

/** Transparent line-by-line price (base, rule adjustments, add-ons, total). */
export function PriceBreakdown({
  lines,
  totalCents,
  currency,
  refundedCents = 0,
  caption = "Price breakdown",
}: {
  lines: QuoteLine[];
  totalCents: number;
  currency: string;
  refundedCents?: number;
  caption?: string;
}) {
  return (
    <table className="w-full text-left text-[0.95rem]">
      <caption className="sr-only">{caption}</caption>
      <thead className="sr-only">
        <tr>
          <th scope="col">Item</th>
          <th scope="col">Amount</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-sand-200">
        {lines.map((l, i) => (
          <tr key={`${l.kind}-${l.ruleId ?? l.addonCode ?? i}`}>
            <th scope="row" className="py-2 pr-4 font-normal">
              {l.label}
              {l.kind === "adjustment" ? <span className="block text-xs text-muted">Pricing rule</span> : null}
              {l.kind === "addon" ? <span className="block text-xs text-muted">Add-on</span> : null}
            </th>
            <td className="py-2 text-right tabular-nums">{formatMoney(l.amountCents, currency)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr className="border-t-2 border-ink/80">
          <th scope="row" className="pt-3 font-bold">
            Total
          </th>
          <td className="pt-3 text-right text-lg font-bold tabular-nums">{formatMoney(totalCents, currency)}</td>
        </tr>
        {refundedCents > 0 ? (
          <tr>
            <th scope="row" className="pt-1 font-normal text-muted">
              Refunded
            </th>
            <td className="pt-1 text-right tabular-nums text-muted">−{formatMoney(refundedCents, currency)}</td>
          </tr>
        ) : null}
      </tfoot>
    </table>
  );
}
