import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Alert, Card } from "@/components/ui";
import { Section } from "@/components/admin/admin-ui";
import { ActionForm } from "@/components/admin/action-form";
import { CheckField } from "@/components/admin/fields";
import { PermitRequirementFields } from "@/components/admin/permit-fields";
import { requirePermission } from "@/server/auth";
import { getAdminTrail, getTrailFactsView } from "@/server/admin/trails";
import { listPermitRequirements } from "@/server/admin/permits";
import { formatDate } from "@/lib/format";
import { createPermitRequirementAction, deletePermitRequirementAction, updatePermitRequirementAction } from "../../actions";

export const metadata: Metadata = { title: "Trail permits" };

export default async function TrailPermitsPage({ params }: PageProps<"/admin/trails/[id]/permits">) {
  const { id } = await params;
  const user = await requirePermission("permits.manage", `/admin/trails/${id}/permits`);
  const trail = await getAdminTrail(user, id);
  if (!trail) notFound();
  const [reqs, facts] = await Promise.all([listPermitRequirements(user, trail.id), getTrailFactsView(user, trail.id)]);
  const sources = facts.allSources.map((s) => ({ value: s.id, label: s.label }));

  return (
    <>
      <Alert tone="blue" className="mb-6">
        Ghost Guide shows official links, requirements and reminders, and tracks status. It never buys permits for customers and never automates permit
        queues, lotteries or CAPTCHAs.
      </Alert>
      {trail.permitRequired !== reqs.length > 0 ? (
        <Alert tone="amber" className="mb-6">
          {trail.permitRequired
            ? "The “Permit required” fact is Yes, but no permit requirement is recorded."
            : "Permit requirements are recorded, but the “Permit required” fact is No. Update the fact if every hiker needs a permit."}
        </Alert>
      ) : null}
      <Section id="list" title="Permit requirements">
        {reqs.length ? (
          <ul className="space-y-3">
            {reqs.map((r) => (
              <li key={r.id}>
                <Card className="p-4 sm:p-5">
                  <p className="font-semibold">{r.name}</p>
                  <p className="text-sm text-muted">
                    {r.authority} · lead time {r.leadTimeDays ?? "—"} day(s) · verified {r.verifiedAt ? formatDate(r.verifiedAt) : "never"} ·{" "}
                    <a className="underline" href={r.officialUrl} target="_blank" rel="noopener noreferrer">
                      official page
                    </a>
                  </p>
                  <p className="mt-2 whitespace-pre-wrap">{r.requirementSummary}</p>
                  <details className="mt-3 rounded-xl border border-sand-200 p-3">
                    <summary className="min-h-11 cursor-pointer content-center font-semibold">Edit requirement</summary>
                    <ActionForm action={updatePermitRequirementAction.bind(null, trail.id, r.id)} submitLabel="Save requirement" className="mt-2">
                      <PermitRequirementFields idPrefix={`pr-${r.id}`} r={r} sources={sources} />
                    </ActionForm>
                    <ActionForm action={deletePermitRequirementAction.bind(null, trail.id, r.id)} submitLabel="Delete requirement" variant="danger" className="mt-4" compact>
                      <CheckField id={`pr-${r.id}-del`} name="confirm" required label="Delete (only possible when no trip tracks it)." />
                    </ActionForm>
                  </details>
                </Card>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">No permit requirements recorded.</p>
        )}
      </Section>
      <Section id="new" title="Add a permit requirement">
        <Card>
          <ActionForm action={createPermitRequirementAction.bind(null, trail.id)} submitLabel="Add requirement">
            <PermitRequirementFields idPrefix="pr-new" sources={sources} />
          </ActionForm>
        </Card>
      </Section>
    </>
  );
}
