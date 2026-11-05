import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card } from "@/components/ui";
import { Section, StatusBadge } from "@/components/admin/admin-ui";
import { ActionForm } from "@/components/admin/action-form";
import { CheckField, SelectField } from "@/components/admin/fields";
import { SourceFields } from "@/components/admin/source-fields";
import { requirePermission } from "@/server/auth";
import { getAdminTrail, getTrailFactsView } from "@/server/admin/trails";
import { listSources } from "@/server/admin/sources";
import { formatDate } from "@/lib/format";
import { createSourceAction, deleteSourceAction, linkSourceAction, unlinkSourceAction, updateSourceAction } from "../../actions";

export const metadata: Metadata = { title: "Trail sources" };

export default async function TrailSourcesPage({ params }: PageProps<"/admin/trails/[id]/sources">) {
  const { id } = await params;
  const user = await requirePermission("trails.manage", `/admin/trails/${id}/sources`);
  const trail = await getAdminTrail(user, id);
  if (!trail) notFound();
  const [facts, all] = await Promise.all([getTrailFactsView(user, trail.id), listSources(user)]);
  const linkedIds = new Set(facts.linkedSources.map((s) => s.id));
  const unlinked = all.filter((s) => !linkedIds.has(s.id));

  return (
    <>
      <Section id="linked" title="Sources linked to this trail" description="At least one linked source is required to publish. Customers see linked sources on the trail page.">
        {facts.linkedSources.length ? (
          <ul className="space-y-3">
            {facts.linkedSources.map((s) => {
              const usage = all.find((a) => a.id === s.id);
              return (
                <li key={s.id}>
                  <Card className="p-4 sm:p-5">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-semibold">{s.label}</p>
                      <StatusBadge status={s.sourceType === "demo" ? "simulated" : "approved"} label={s.sourceType.replace("_", " ")} />
                    </div>
                    <p className="mt-1 text-sm text-muted">
                      {s.publisher ?? "Unknown publisher"} · retrieved {s.retrievedAt ? formatDate(s.retrievedAt) : "date not recorded"}
                      {s.url ? (
                        <>
                          {" "}
                          ·{" "}
                          <a href={s.url} className="underline" target="_blank" rel="noopener noreferrer">
                            open link
                          </a>
                        </>
                      ) : null}
                    </p>
                    {s.notes ? <p className="mt-1 whitespace-pre-wrap text-sm">{s.notes}</p> : null}
                    <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                      <ActionForm action={unlinkSourceAction.bind(null, trail.id, s.id)} submitLabel="Unlink from trail" variant="secondary" compact />
                      <details className="w-full rounded-xl border border-sand-200 p-3">
                        <summary className="min-h-11 cursor-pointer content-center font-semibold">Edit source</summary>
                        <ActionForm action={updateSourceAction.bind(null, trail.id, s.id)} submitLabel="Save source" className="mt-2">
                          <SourceFields idPrefix={`src-${s.id}`} source={s} />
                        </ActionForm>
                        {usage && usage.trailCount <= 1 ? (
                          <ActionForm action={deleteSourceAction.bind(null, trail.id, s.id)} submitLabel="Delete source" variant="danger" className="mt-4" compact>
                            <CheckField id={`src-${s.id}-del`} name="confirm" required label="Delete this source permanently (only possible if nothing cites it)." />
                          </ActionForm>
                        ) : null}
                      </details>
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-muted">No sources linked yet.</p>
        )}
      </Section>

      {unlinked.length ? (
        <Section id="link" title="Link an existing source">
          <Card>
            <ActionForm action={linkSourceAction.bind(null, trail.id)} submitLabel="Link source" inline>
              <SelectField id="link-source" name="sourceId" label="Source" required options={unlinked.map((s) => ({ value: s.id, label: s.label }))} placeholder="Choose a source" className="sm:min-w-80" />
            </ActionForm>
          </Card>
        </Section>
      ) : null}

      <Section id="new" title="Add a new source" description="Record where facts, narration, closures or permit rules come from. The new source is linked to this trail.">
        <Card>
          <ActionForm action={createSourceAction.bind(null, trail.id)} submitLabel="Create and link source">
            <SourceFields idPrefix="src-new" />
          </ActionForm>
        </Card>
      </Section>
    </>
  );
}
