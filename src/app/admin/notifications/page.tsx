import type { Metadata } from "next";
import { SimulatedBadge } from "@/components/ui";
import { AdminHeader, StatusBadge, When } from "@/components/admin/admin-ui";
import { DataTable, FilterBar, Pagination } from "@/components/admin/data-table";
import { SelectField } from "@/components/admin/fields";
import { requirePermission } from "@/server/auth";
import { listNotifications, NOTIFICATION_CHANNELS, NOTIFICATION_STATUSES, type NotificationLogRow } from "@/server/admin/safety";
import { parsePage, sp } from "@/server/admin/common";
import { integrationStatus } from "@/config/env";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage({ searchParams }: PageProps<"/admin/notifications">) {
  const user = await requirePermission("notifications.view", "/admin/notifications");
  const q = await searchParams;
  const filters = { status: sp(q.status), channel: sp(q.channel) };
  const page = parsePage({ limit: sp(q.limit), offset: sp(q.offset) });
  const data = await listNotifications(user, filters, page);
  const simulated = integrationStatus().notifications === "simulated";
  return (
    <>
      <AdminHeader
        title="Notification delivery log"
        description={
          <span className="flex flex-wrap items-center gap-2">
            Recipients are masked; message bodies are not shown here. {simulated ? <SimulatedBadge label="SMS / email simulated" /> : null}
          </span>
        }
      />
      <FilterBar action="/admin/notifications" resetHref="/admin/notifications">
        <SelectField id="n-status" name="status" label="Status" options={NOTIFICATION_STATUSES} placeholder="Any status" defaultValue={filters.status ?? ""} />
        <SelectField id="n-channel" name="channel" label="Channel" options={NOTIFICATION_CHANNELS} placeholder="Any channel" defaultValue={filters.channel ?? ""} />
      </FilterBar>
      <DataTable<NotificationLogRow>
        caption={filters.status === "failed" ? "Failed notifications" : "Notifications, newest first"}
        rows={data.rows}
        rowKey={(n) => n.id}
        empty="No notifications match."
        columns={[
          { header: "Created", cell: (n) => <When at={n.createdAt} /> },
          { header: "Status", cell: (n) => <StatusBadge status={n.status} /> },
          { header: "Channel", cell: (n) => n.channel.replace("_", "-") },
          { header: "Recipient", cell: (n) => <span>{n.recipientMasked}<span className="block text-xs text-muted">{n.recipientKind.replace("_", " ")}</span></span> },
          { header: "Template", cell: (n) => n.template.replace(/_/g, " ") },
          { header: "Attempts", cell: (n) => `${n.attempts} · ${n.provider}` },
          { header: "Error", cell: (n) => (n.error ? <span className="text-red-ink">{n.error}</span> : "—") },
          { header: "Sent", cell: (n) => <When at={n.sentAt} /> },
        ]}
      />
      <Pagination basePath="/admin/notifications" params={filters} total={data.total} limit={data.limit} offset={data.offset} />
    </>
  );
}
