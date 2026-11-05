import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, Card, SimulatedBadge } from "@/components/ui";
import { AdminHeader, KeyValue, Restricted, Section, StatusBadge, When, money } from "@/components/admin/admin-ui";
import { DataTable } from "@/components/admin/data-table";
import { ActionForm } from "@/components/admin/action-form";
import { CheckField, TextAreaField, TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import { getBookingDetail, type BookingDetail } from "@/server/admin/bookings";
import { formatDate } from "@/lib/format";
import { cancelBookingAction, refundBookingAction } from "../actions";

export const metadata: Metadata = { title: "Booking" };

const CANCELLABLE = ["pending_payment", "confirmed", "cancellation_requested", "needs_attention"];

export default async function BookingDetailPage({ params }: PageProps<"/admin/bookings/[id]">) {
  const { id } = await params;
  const user = await requirePermission("bookings.view", `/admin/bookings/${id}`);
  const d = await getBookingDetail(user, id);
  if (!d) notFound();
  const b = d.booking;
  const lines = Array.isArray(b.priceBreakdown?.lines) ? b.priceBreakdown.lines : [];
  const simulated = b.paymentProvider === "demo";
  const paid = (d.payments ?? []).filter((p) => ["succeeded", "partially_refunded", "refunded"].includes(p.status)).reduce((s, p) => s + p.amountCents, 0);
  const refundable = Math.max(0, paid - b.refundedCents);

  return (
    <>
      <p className="mb-3">
        <Link href="/admin/bookings" className="inline-flex min-h-11 items-center font-semibold text-forest-800 hover:underline">
          ← Bookings
        </Link>
      </p>
      <AdminHeader
        title={`${b.trailName} · ${formatDate(b.hikeDate)}`}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={b.status} />
            <span>Booking {b.id.slice(0, 8)}</span>
            {b.receiptNumber ? <span>· Receipt {b.receiptNumber}</span> : null}
            {simulated ? <SimulatedBadge label="Simulated payment" /> : null}
          </span>
        }
      />

      {d.hints.length ? (
        <Alert tone="amber" title="Reconciliation hints" className="mb-6">
          <ul className="list-disc space-y-1 pl-5">
            {d.hints.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <Card>
        <KeyValue
          items={[
            ["Customer", b.customerEmail ?? "—"],
            ["Party size", b.partySize],
            ["Hike date", formatDate(b.hikeDate)],
            ["Created", <When key="c" at={b.createdAt} />],
            ["Hold expires", b.holdExpiresAt ? <When key="h" at={b.holdExpiresAt} /> : "—"],
            ["Paid", b.paidAt ? <When key="p" at={b.paidAt} /> : "Not paid"],
            ["Cancelled", b.cancelledAt ? <When key="x" at={b.cancelledAt} /> : "—"],
            ["Cancellation reason", b.cancellationReason ?? "—"],
            ["Payment provider", b.paymentProvider],
            ["Checkout session", <span key="s" className="break-all font-mono text-xs">{b.checkoutSessionId ?? "—"}</span>],
          ]}
        />
      </Card>

      <Section id="price" title="Price breakdown" description="Stored at checkout; later pricing changes do not alter it.">
        <Card>
          {lines.length ? (
            <table className="w-full text-sm">
              <caption className="sr-only">Price lines</caption>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i} className="border-b border-sand-200 last:border-0">
                    <th scope="row" className="py-2 text-left font-normal">
                      {l.label ?? l.kind}
                    </th>
                    <td className="py-2 text-right">{money(l.amountCents ?? 0, b.currency)}</td>
                  </tr>
                ))}
                <tr>
                  <th scope="row" className="py-2 text-left font-bold">
                    Total
                  </th>
                  <td className="py-2 text-right font-bold">{money(b.totalCents, b.currency)}</td>
                </tr>
              </tbody>
            </table>
          ) : (
            <p>
              Subtotal {money(b.subtotalCents, b.currency)} + add-ons {money(b.addonsCents, b.currency)} = <strong>{money(b.totalCents, b.currency)}</strong>
            </p>
          )}
          {typeof b.priceBreakdown?.occupancy === "number" ? <p className="mt-2 text-xs text-muted">Occupancy at quote time: {Math.round(b.priceBreakdown.occupancy * 100)}%</p> : null}
        </Card>
      </Section>

      <Section id="addons" title="Add-ons and partner fulfillment" description="Each partner's status is tracked separately from the booking status.">
        <DataTable<BookingDetail["fulfillments"][number]>
          caption="Fulfillments"
          captionHidden
          rows={d.fulfillments}
          rowKey={(f) => f.id}
          empty="No add-ons on this booking."
          columns={[
            { header: "Partner", cell: (f) => <span>{f.providerKind.replace(/_/g, " ")} <span className="text-muted">({f.providerKey})</span></span> },
            { header: "Status", cell: (f) => <StatusBadge status={f.status} /> },
            { header: "Attempts", cell: (f) => f.attempts },
            { header: "Last error", cell: (f) => f.lastError ?? "—" },
            { header: "Updated", cell: (f) => <When at={f.updatedAt} /> },
          ]}
        />
        {can(user.roles, "fulfillment.manage") && d.fulfillments.some((f) => ["failed", "needs_attention"].includes(f.status)) ? (
          <p className="mt-2">
            <Link className="font-semibold underline" href="/admin/fulfillment">
              Retry or resolve in the fulfillment queue →
            </Link>
          </p>
        ) : null}
      </Section>

      <Section id="payments" title="Payments and refunds">
        {d.payments === null ? (
          <Restricted>payments and refunds are visible to operators and admins.</Restricted>
        ) : (
          <div className="space-y-4">
            <DataTable<NonNullable<BookingDetail["payments"]>[number]>
              caption="Payments"
              rows={d.payments}
              rowKey={(p) => p.id}
              empty="No payments recorded."
              columns={[
                { header: "Amount", cell: (p) => money(p.amountCents, p.currency) },
                { header: "Status", cell: (p) => <StatusBadge status={p.status} /> },
                { header: "Provider", cell: (p) => <span className="break-all">{p.provider} · {p.providerPaymentId}</span> },
                { header: "Created", cell: (p) => <When at={p.createdAt} /> },
              ]}
            />
            <DataTable<NonNullable<BookingDetail["refunds"]>[number]>
              caption="Refunds"
              rows={d.refunds ?? []}
              rowKey={(r) => r.id}
              empty="No refunds."
              columns={[
                { header: "Amount", cell: (r) => money(r.amountCents, b.currency) },
                { header: "Status", cell: (r) => <StatusBadge status={r.status} /> },
                { header: "Reason", cell: (r) => r.reason },
                { header: "Error", cell: (r) => r.lastError ?? "—" },
                { header: "Requested", cell: (r) => <When at={r.createdAt} /> },
              ]}
            />
          </div>
        )}
      </Section>

      <Section id="webhooks" title="Payment webhook events" description="Matched by booking id or checkout session id in the event payload.">
        {d.webhookEvents === null ? (
          <Restricted>webhook events are visible to operators and admins.</Restricted>
        ) : (
          <DataTable<NonNullable<BookingDetail["webhookEvents"]>[number]>
            caption="Webhook events"
            captionHidden
            rows={d.webhookEvents}
            rowKey={(w) => w.id}
            empty="No webhook events reference this booking."
            columns={[
              { header: "Type", cell: (w) => w.type },
              { header: "Status", cell: (w) => <StatusBadge status={w.status} /> },
              { header: "Event", cell: (w) => <span className="break-all font-mono text-xs">{w.provider} · {w.eventId}</span> },
              { header: "Attempts", cell: (w) => w.attempts },
              { header: "Error", cell: (w) => w.error ?? "—" },
              { header: "Received", cell: (w) => <When at={w.receivedAt} /> },
            ]}
          />
        )}
      </Section>

      {can(user.roles, "bookings.cancel") || can(user.roles, "bookings.refund") ? (
        <Section id="actions" title="Staff actions" description="Cancellations and refunds are recorded in the audit log and are safe to retry (no double refunds).">
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {can(user.roles, "bookings.cancel") && CANCELLABLE.includes(b.status) ? (
              <Card>
                <h3 className="mb-1 font-semibold">Cancel booking</h3>
                <p className="mb-3 text-sm text-muted">Business cancellation (e.g. closure or partner issue): refunds everything still refundable, regardless of the customer policy.</p>
                <ActionForm action={cancelBookingAction.bind(null, b.id)} submitLabel="Cancel booking" variant="danger" pendingLabel="Cancelling…">
                  <TextAreaField id="cx-reason" name="reason" label="Reason (shared with the customer)" required minLength={3} maxLength={500} />
                  <CheckField id="cx-confirm" name="confirm" required label="I understand this cancels the booking and requests a refund." />
                </ActionForm>
              </Card>
            ) : null}
            {can(user.roles, "bookings.refund") && refundable > 0 ? (
              <Card>
                <h3 className="mb-1 font-semibold">Refund an amount</h3>
                <p className="mb-3 text-sm text-muted">
                  Captured {money(paid, b.currency)}; already refunded {money(b.refundedCents, b.currency)}. {simulated ? "Simulated provider: no real money moves." : ""}
                </p>
                <ActionForm action={refundBookingAction.bind(null, b.id)} submitLabel="Issue refund" variant="secondary" pendingLabel="Requesting refund…">
                  <TextField id="rf-amount" name="amount" label={`Amount (${b.currency.toUpperCase()})`} type="number" step="0.01" min="0.01" max={(refundable / 100).toFixed(2)} required />
                  <TextAreaField id="rf-reason" name="reason" label="Reason" required minLength={3} maxLength={500} />
                  <CheckField id="rf-confirm" name="confirm" required label="I confirm this refund amount." />
                </ActionForm>
              </Card>
            ) : null}
          </div>
        </Section>
      ) : null}
    </>
  );
}
