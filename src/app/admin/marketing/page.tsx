import Link from "next/link";
import type { Metadata } from "next";
import { Alert, Card } from "@/components/ui";
import { AdminHeader, DemoBadge, Section, StatusBadge, When } from "@/components/admin/admin-ui";
import { DataTable, FilterBar, Pagination } from "@/components/admin/data-table";
import { ActionForm } from "@/components/admin/action-form";
import { SelectField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { DRAFT_CHANNELS, DRAFT_STATUSES, listMarketingDrafts, marketingEnabled, type DraftRow } from "@/server/admin/marketing";
import { listAdminTrails } from "@/server/admin/trails";
import { can } from "@/server/auth/rbac";
import { parsePage, sp } from "@/server/admin/common";
import { integrationStatus } from "@/config/env";
import { generateDraftAction } from "./actions";

export const metadata: Metadata = { title: "Marketing drafts" };

export default async function MarketingPage({ searchParams }: PageProps<"/admin/marketing">) {
  const user = await requirePermission("marketing.draft", "/admin/marketing");
  const q = await searchParams;
  const status = sp(q.status);
  const page = parsePage({ limit: sp(q.limit), offset: sp(q.offset) });
  const enabled = await marketingEnabled();
  const [data, trails] = await Promise.all([listMarketingDrafts(user, { status }, page), can(user.roles, "trails.manage") ? listAdminTrails(user) : Promise.resolve([])]);
  const weather = integrationStatus().weather;

  return (
    <>
      <AdminHeader
        title="Marketing drafts"
        description="Drafts are generated from sourced trail facts and a weather snapshot by a fixed template (no AI). Every draft needs approval before it can be marked published."
      />
      {!enabled ? (
        <Alert tone="amber" className="mb-6" title="The marketing-draft workflow is turned off">
          An admin can turn on the <code>marketing_drafts</code> feature flag. Existing drafts are shown read-only.
        </Alert>
      ) : null}

      {enabled ? (
        <Section id="generate" title="Generate a draft" description={`Weather comes from: ${weather}. Simulated weather is always labeled and flagged for review.`}>
          <Card>
            <ActionForm action={generateDraftAction} submitLabel="Generate draft" pendingLabel="Generating…" inline>
              <SelectField id="mk-trail" name="trailId" label="Trail" required options={trails.filter((t) => t.status !== "archived").map((t) => ({ value: t.id, label: `${t.name}${t.isDemo ? " (demo)" : ""}` }))} placeholder="Choose a trail" className="sm:min-w-72" />
              <SelectField id="mk-channel" name="channel" label="Channel" options={DRAFT_CHANNELS} defaultValue="newsletter" />
            </ActionForm>
          </Card>
        </Section>
      ) : null}

      <Section id="drafts" title="Drafts">
        <FilterBar action="/admin/marketing" resetHref="/admin/marketing">
          <SelectField id="mk-status" name="status" label="Status" options={DRAFT_STATUSES} placeholder="Any status" defaultValue={status ?? ""} />
        </FilterBar>
        <DataTable<DraftRow>
          caption="Marketing drafts, recently updated first"
          captionHidden
          rows={data.rows}
          rowKey={(d) => d.id}
          empty="No drafts yet."
          columns={[
            {
              header: "Draft",
              cell: (d) => (
                <Link href={`/admin/marketing/${d.id}`} className="font-semibold text-forest-800 underline-offset-2 hover:underline">
                  {d.title}
                </Link>
              ),
            },
            { header: "Status", cell: (d) => <StatusBadge status={d.status} /> },
            { header: "Trail", cell: (d) => <span className="flex flex-wrap items-center gap-1">{d.trailName}{d.trailIsDemo ? <DemoBadge /> : null}</span> },
            { header: "Channel", cell: (d) => d.channel },
            { header: "Updated", cell: (d) => <When at={d.updatedAt} /> },
          ]}
        />
        <Pagination basePath="/admin/marketing" params={{ status }} total={data.total} limit={data.limit} offset={data.offset} />
      </Section>
    </>
  );
}
