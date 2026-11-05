import Link from "next/link";
import type { Metadata } from "next";
import { Card } from "@/components/ui";
import { AdminHeader, DemoBadge, Section, StatusBadge, When } from "@/components/admin/admin-ui";
import { DataTable, FilterBar, Pagination } from "@/components/admin/data-table";
import { ActionForm } from "@/components/admin/action-form";
import { CheckField, SelectField, TextAreaField, TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { canEditNarration, listNarrations, narrationFormOptions, NARRATION_STATUSES, type NarrationRow } from "@/server/admin/content";
import { parsePage, sp } from "@/server/admin/common";
import { createNarrationAction } from "./actions";

export const metadata: Metadata = { title: "Narration review" };

export default async function ContentQueuePage({ searchParams }: PageProps<"/admin/content">) {
  const user = await requirePermission("trails.manage", "/admin/content");
  const q = await searchParams;
  const filters = { status: sp(q.status), trailId: sp(q.trailId) };
  const page = parsePage({ limit: sp(q.limit), offset: sp(q.offset) });
  const [data, options] = await Promise.all([listNarrations(user, filters, page), narrationFormOptions(user)]);
  const editable = canEditNarration(user);

  return (
    <>
      <AdminHeader
        title="Narration review"
        description="Narration customers hear must be approved with a cited source. Transcripts are shown as plain text: imported content is untrusted."
      />
      <FilterBar action="/admin/content" resetHref="/admin/content">
        <SelectField id="f-status" name="status" label="Status" options={NARRATION_STATUSES} placeholder="All (review first)" defaultValue={filters.status ?? ""} />
        <SelectField id="f-trail" name="trailId" label="Trail" options={options.trails.map((t) => ({ value: t.id, label: t.name }))} placeholder="All trails" defaultValue={filters.trailId ?? ""} />
      </FilterBar>
      <DataTable<NarrationRow>
        caption="Narration queue"
        rows={data.rows}
        rowKey={(n) => n.id}
        empty="No narration matches these filters."
        columns={[
          {
            header: "Title",
            cell: (n) => (
              <span className="flex flex-wrap items-center gap-2">
                <Link href={`/admin/content/${n.id}`} className="font-semibold text-forest-800 underline-offset-2 hover:underline">
                  {n.title}
                </Link>
                <span className="text-xs text-muted">v{n.version}</span>
              </span>
            ),
          },
          { header: "Status", cell: (n) => <StatusBadge status={n.status} /> },
          { header: "Trail / POI", cell: (n) => <span className="flex flex-wrap items-center gap-1">{n.trailName}{n.trailIsDemo ? <DemoBadge /> : null}{n.poiName ? <span className="text-muted">· {n.poiName}</span> : null}</span> },
          { header: "Source", cell: (n) => n.sourceLabel ?? <span className="font-semibold text-amber-ink">No source</span> },
          { header: "Preview", cell: (n) => <span className="line-clamp-2 text-muted">{n.transcript}</span> },
          { header: "Updated", cell: (n) => <When at={n.updatedAt} /> },
        ]}
      />
      <Pagination basePath="/admin/content" params={{ status: filters.status, trailId: filters.trailId }} total={data.total} limit={data.limit} offset={data.offset} />

      {editable ? (
        <Section id="new" title="Write new narration" description="New narration starts as a draft (or goes straight to review). It is never heard by customers until approved with a source.">
          <Card>
            <ActionForm action={createNarrationAction} submitLabel="Save narration">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <SelectField id="n-trail" name="trailId" label="Trail" required options={options.trails.map((t) => ({ value: t.id, label: t.name }))} placeholder="Choose a trail" defaultValue={filters.trailId ?? ""} />
                <SelectField
                  id="n-poi"
                  name="poiId"
                  label="POI (optional)"
                  options={options.pois.map((p) => ({ value: p.id, label: `${options.trails.find((t) => t.id === p.trailId)?.name ?? "?"} — ${p.seq}. ${p.name}` }))}
                  placeholder="Not tied to a POI"
                />
                <TextField id="n-title" name="title" label="Title" required minLength={3} maxLength={200} className="sm:col-span-2" />
                <TextAreaField id="n-transcript" name="transcript" label="Transcript" required minLength={10} maxLength={20000} className="sm:col-span-2" hint="Plain text. Formatting and HTML are shown literally." />
                <SelectField id="n-source" name="sourceId" label="Source" options={options.sources.map((s) => ({ value: s.id, label: s.label }))} placeholder="Add before approval" />
                <TextField id="n-cite" name="sourceCitation" label="Citation" maxLength={500} hint="e.g. page, section or URL fragment" />
                <CheckField id="n-submit" name="submit" label="Submit for review now" />
              </div>
            </ActionForm>
          </Card>
        </Section>
      ) : (
        <p className="mt-6 text-sm text-muted">Narration is written and edited by content editors and admins; your role can review the queue.</p>
      )}
    </>
  );
}
