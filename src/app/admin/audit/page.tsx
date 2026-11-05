import type { Metadata } from "next";
import { AdminHeader, When } from "@/components/admin/admin-ui";
import { DataTable, FilterBar, Pagination } from "@/components/admin/data-table";
import { SelectField, TextField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { listAuditLogs, type AuditRow } from "@/server/admin/audit-log";
import { parsePage, sp } from "@/server/admin/common";

export const metadata: Metadata = { title: "Audit log" };

export default async function AuditPage({ searchParams }: PageProps<"/admin/audit">) {
  const user = await requirePermission("audit.view", "/admin/audit");
  const q = await searchParams;
  const filters = { action: sp(q.action), entityType: sp(q.entityType), entityId: sp(q.entityId), actor: sp(q.actor), from: sp(q.from), to: sp(q.to) };
  const page = parsePage({ limit: sp(q.limit), offset: sp(q.offset) });
  const data = await listAuditLogs(user, filters, page);
  return (
    <>
      <AdminHeader title="Audit log" description="Sensitive staff and system actions. Metadata is redacted: no contact details, coordinates or message bodies are stored here." />
      <FilterBar action="/admin/audit" resetHref="/admin/audit">
        <SelectField id="au-action" name="action" label="Action" options={data.actions} placeholder="Any action" defaultValue={filters.action ?? ""} />
        <TextField id="au-type" name="entityType" label="Entity type" placeholder="e.g. trail" defaultValue={filters.entityType ?? ""} />
        <TextField id="au-id" name="entityId" label="Entity id" defaultValue={filters.entityId ?? ""} />
        <TextField id="au-actor" name="actor" label="Actor email" defaultValue={filters.actor ?? ""} />
        <TextField id="au-from" name="from" type="date" label="From" defaultValue={filters.from ?? ""} />
        <TextField id="au-to" name="to" type="date" label="To" defaultValue={filters.to ?? ""} />
      </FilterBar>
      <DataTable<AuditRow>
        caption="Audit entries, newest first"
        rows={data.rows}
        rowKey={(a) => a.id}
        empty="No audit entries match."
        columns={[
          { header: "When", cell: (a) => <When at={a.createdAt} /> },
          { header: "Action", cell: (a) => <code className="font-semibold">{a.action}</code> },
          { header: "Actor", cell: (a) => <span>{a.actorEmail ?? (a.actorId ? a.actorId.slice(0, 8) : "system")}<span className="block text-xs text-muted">{a.actorRoles.join(", ") || "—"}</span></span> },
          { header: "Entity", cell: (a) => <span className="break-all">{a.entityType}{a.entityId ? <span className="block font-mono text-xs text-muted">{a.entityId}</span> : null}</span> },
          { header: "Details", cell: (a) => <code className="block max-w-md text-xs break-all whitespace-pre-wrap">{JSON.stringify(a.metadata)}</code> },
        ]}
      />
      <Pagination basePath="/admin/audit" params={filters} total={data.total} limit={data.limit} offset={data.offset} />
    </>
  );
}
