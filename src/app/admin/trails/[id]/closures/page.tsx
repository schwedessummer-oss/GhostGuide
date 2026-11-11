import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Alert, Card } from "@/components/ui";
import { Section, StatusBadge, When } from "@/components/admin/admin-ui";
import { ActionForm } from "@/components/admin/action-form";
import { CheckField, SelectField, TextAreaField, TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { getAdminTrail, getTrailFactsView } from "@/server/admin/trails";
import { CLOSURE_SEVERITIES, listClosureImpacts, listClosures, type ClosureImpact, type ClosureRow } from "@/server/admin/closures";
import { utcToLocalInput } from "@/server/admin/common";
import { formatDate } from "@/lib/format";
import { createClosureAction, deleteClosureAction, endClosureAction, updateClosureAction } from "../../actions";

export const metadata: Metadata = { title: "Trail closures" };

const SEVERITY_HELP = "Closed: unavailable for recommendations and new bookings. Partial / advisory: shown to customers as a notice.";

function ClosureFields({ idPrefix, tz, sources, c }: { idPrefix: string; tz: string; sources: { value: string; label: string }[]; c?: ClosureRow }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <SelectField id={`${idPrefix}-sev`} name="severity" label="Severity" options={CLOSURE_SEVERITIES} defaultValue={c?.severity ?? "closed"} hint={SEVERITY_HELP} />
      <SelectField id={`${idPrefix}-src`} name="sourceId" label="Source" options={sources} placeholder="No source" defaultValue={c?.sourceId ?? ""} />
      <TextAreaField id={`${idPrefix}-reason`} name="reason" label="Reason (shown to customers)" required minLength={5} maxLength={1000} defaultValue={c?.reason ?? ""} className="sm:col-span-2" />
      <TextField id={`${idPrefix}-start`} name="startsAt" label={`Starts (${tz})`} type="datetime-local" defaultValue={c ? utcToLocalInput(c.startsAt, tz) : ""} hint="Leave empty to start now." />
      <TextField id={`${idPrefix}-end`} name="endsAt" label={`Ends (${tz})`} type="datetime-local" defaultValue={c ? utcToLocalInput(c.endsAt, tz) : ""} hint="Leave empty for an open-ended closure." />
    </div>
  );
}

function ClosureImpactNote({ impact }: { impact: ClosureImpact | undefined }) {
  if (!impact?.count) return <p className="mt-2 text-sm text-muted">No upcoming paid bookings fall on days this closure covers.</p>;
  const title = `${impact.count} upcoming paid ${impact.count === 1 ? "booking" : "bookings"} (${impact.hikers} ${impact.hikers === 1 ? "hiker" : "hikers"}) on closed days`;
  return (
    <div className="mt-3">
      <Alert tone="amber" title={title}>
        <p>They are not cancelled automatically. {impact.bookings ? "Open each booking to contact the customer, cancel or refund it." : "Ask an operator or admin to review them in Bookings."}</p>
      </Alert>
      {impact.bookings ? (
        <ul className="mt-2 divide-y divide-sand-200 rounded-xl border border-sand-200" aria-label="Bookings affected by this closure">
          {impact.bookings.map((b) => (
            <li key={b.id} className="flex flex-col gap-1 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <span className="text-sm">
                <span className="font-semibold">{formatDate(b.hikeDate, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}</span> · {b.partySize}{" "}
                {b.partySize === 1 ? "hiker" : "hikers"} · {b.customerEmail ?? "Customer"} · <StatusBadge status={b.status} />
              </span>
              <Link href={`/admin/bookings/${b.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-forest-800 underline underline-offset-2">
                Open booking
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export default async function TrailClosuresPage({ params }: PageProps<"/admin/trails/[id]/closures">) {
  const { id } = await params;
  const user = await requirePermission("closures.manage", `/admin/trails/${id}/closures`);
  const trail = await getAdminTrail(user, id);
  if (!trail) notFound();
  const [closures, facts, impacts] = await Promise.all([listClosures(user, trail.id), getTrailFactsView(user, trail.id), listClosureImpacts(user, trail.id)]);
  const sources = facts.allSources.map((s) => ({ value: s.id, label: s.label }));
  const tz = trail.regionTimezone;

  return (
    <>
      <Section id="new" title="Add a closure or notice" description="Takes effect immediately for recommendations, trail pages and new bookings. Existing bookings are not cancelled automatically — each full closure lists the paid bookings on its days.">
        <Card>
          <ActionForm action={createClosureAction.bind(null, trail.id)} submitLabel="Save closure">
            <ClosureFields idPrefix="cl-new" tz={tz} sources={sources} />
          </ActionForm>
        </Card>
      </Section>

      <Section id="list" title="Closures and notices">
        {closures.length ? (
          <ul className="space-y-3">
            {closures.map((c) => (
              <li key={c.id}>
                <Card className="p-4 sm:p-5">
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={c.severity} />
                    <StatusBadge status={c.state === "active" ? "active" : c.state === "scheduled" ? "scheduled" : "finished"} label={c.state} />
                    <span className="text-sm text-muted">{c.sourceLabel ? `Source: ${c.sourceLabel}` : "No source"}</span>
                  </div>
                  <p className="mt-2 whitespace-pre-wrap">{c.reason}</p>
                  <p className="mt-1 text-sm text-muted">
                    From <When at={c.startsAt} tz={tz} /> until {c.endsAt ? <When at={c.endsAt} tz={tz} /> : "further notice"}
                  </p>
                  {c.severity === "closed" && c.state !== "ended" ? <ClosureImpactNote impact={impacts[c.id]} /> : null}
                  {c.state !== "ended" ? (
                    <div className="mt-3 flex flex-col gap-3">
                      <ActionForm action={endClosureAction.bind(null, trail.id, c.id)} submitLabel="End now" variant="secondary" compact />
                      <details className="rounded-xl border border-sand-200 p-3">
                        <summary className="min-h-11 cursor-pointer content-center font-semibold">Edit</summary>
                        <ActionForm action={updateClosureAction.bind(null, trail.id, c.id)} submitLabel="Save changes" className="mt-2">
                          <ClosureFields idPrefix={`cl-${c.id}`} tz={tz} sources={sources} c={c} />
                        </ActionForm>
                        <ActionForm action={deleteClosureAction.bind(null, trail.id, c.id)} submitLabel="Delete (entered by mistake)" variant="danger" className="mt-4" compact>
                          <CheckField id={`cl-${c.id}-del`} name="confirm" required label="Delete this closure record entirely." />
                        </ActionForm>
                      </details>
                    </div>
                  ) : null}
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <Alert tone="forest" title="No closures recorded for this trail." />
        )}
      </Section>
    </>
  );
}
