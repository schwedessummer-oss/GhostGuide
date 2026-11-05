import "server-only";
import type { SessionUser } from "@/server/auth";
import { assertCan, isoDate, likePattern, staffTx, type Page, type Paged } from "./common";

export interface AuditRow {
  id: number;
  actorId: string | null;
  actorEmail: string | null;
  actorRoles: string[];
  action: string;
  entityType: string;
  entityId: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
}

export interface AuditFilters {
  action?: string;
  entityType?: string;
  entityId?: string;
  actor?: string;
  from?: string;
  to?: string;
}

/** Audit log viewer (audit.view = admin; RLS audit_logs_admin enforces the same). */
export async function listAuditLogs(user: SessionUser, f: AuditFilters, page: Page): Promise<Paged<AuditRow> & { actions: string[] }> {
  assertCan(user, "audit.view");
  const action = f.action?.trim().slice(0, 80) || null;
  const entityType = f.entityType?.trim().slice(0, 60) || null;
  const entityId = f.entityId?.trim().slice(0, 80) || null;
  const actor = f.actor?.trim().slice(0, 120) || null;
  const from = isoDate.safeParse(f.from).data ?? null;
  const to = isoDate.safeParse(f.to).data ?? null;
  return staffTx(user, async (tx) => {
    const rows = await tx<(AuditRow & { total: number })[]>`
      select a.id, a.actor_id, p.email as actor_email, a.actor_roles, a.action, a.entity_type, a.entity_id, a.metadata, a.created_at,
             count(*) over()::int as total
      from public.audit_logs a left join public.profiles p on p.id = a.actor_id
      where (${action}::text is null or a.action like ${(action ?? "").replace(/[\\%_]/g, "\\$&") + "%"})
        and (${entityType}::text is null or a.entity_type = ${entityType}::text)
        and (${entityId}::text is null or a.entity_id = ${entityId}::text)
        and (${actor}::text is null or p.email ilike ${likePattern(actor ?? "")})
        and (${from}::date is null or a.created_at >= ${from}::date)
        and (${to}::date is null or a.created_at < ${to}::date + 1)
      order by a.created_at desc, a.id desc
      limit ${page.limit} offset ${page.offset}`;
    const actions = (await tx<{ action: string }[]>`select distinct action from public.audit_logs order by action limit 300`).map((r) => r.action);
    return { rows, total: rows[0]?.total ?? 0, ...page, actions };
  });
}
