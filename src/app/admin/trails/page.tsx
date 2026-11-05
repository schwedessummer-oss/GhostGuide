import Link from "next/link";
import type { Metadata } from "next";
import { ButtonLink } from "@/components/ui";
import { AdminHeader, DemoBadge, StatusBadge, When } from "@/components/admin/admin-ui";
import { DataTable, FilterBar } from "@/components/admin/data-table";
import { SelectField, TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { listAdminTrails, type AdminTrailListRow } from "@/server/admin/trails";
import { sp } from "@/server/admin/common";

export const metadata: Metadata = { title: "Trails" };

export default async function AdminTrailsPage({ searchParams }: PageProps<"/admin/trails">) {
  const user = await requirePermission("trails.manage", "/admin/trails");
  const q = await searchParams;
  const filters = { status: sp(q.status), q: sp(q.q) };
  const trails = await listAdminTrails(user, filters);

  return (
    <>
      <AdminHeader
        title="Trails"
        description="All trails, including drafts. A trail can be published only with a validated route and at least one linked source."
        actions={<ButtonLink href="/admin/trails/new">New draft trail</ButtonLink>}
      />
      <FilterBar action="/admin/trails" resetHref="/admin/trails">
        <SelectField id="f-status" name="status" label="Status" defaultValue={filters.status ?? ""} placeholder="Any status" options={["draft", "published", "closed", "archived"]} />
        <TextField id="f-q" name="q" label="Name contains" defaultValue={filters.q ?? ""} />
      </FilterBar>
      <DataTable<AdminTrailListRow>
        caption={`${trails.length} trail(s)`}
        rows={trails}
        rowKey={(t) => t.id}
        empty="No trails match these filters."
        columns={[
          {
            header: "Trail",
            cell: (t) => (
              <span className="flex flex-wrap items-center gap-2">
                <Link href={`/admin/trails/${t.id}`} className="font-semibold text-forest-800 underline-offset-2 hover:underline">
                  {t.name}
                </Link>
                {t.isDemo ? <DemoBadge /> : null}
              </span>
            ),
          },
          { header: "Status", cell: (t) => <StatusBadge status={t.status} /> },
          {
            header: "Route",
            cell: (t) =>
              t.hasGeometry && t.geometryValidatedAt ? (
                <span>
                  Validated <When at={t.geometryValidatedAt} />
                </span>
              ) : (
                <span className="font-semibold text-amber-ink">No validated route</span>
              ),
          },
          { header: "Sources", cell: (t) => (t.sourceCount ? t.sourceCount : <span className="font-semibold text-amber-ink">None</span>) },
          {
            header: "Closures",
            cell: (t) => (t.closedNow ? <StatusBadge status="closed" label="Closed now" /> : t.activeClosureCount ? `${t.activeClosureCount} notice(s)` : "—"),
          },
          { header: "Narration to review", cell: (t) => (t.pendingNarrations ? <Link className="underline" href={`/admin/content?trailId=${t.id}`}>{t.pendingNarrations}</Link> : "—") },
          { header: "Distance", cell: (t) => `${t.distanceKm} km` },
        ]}
      />
    </>
  );
}
