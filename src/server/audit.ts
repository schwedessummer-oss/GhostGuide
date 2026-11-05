import "server-only";
import type { JsonValue, Tx } from "@/server/db";
import { redact } from "@/server/log";

export interface AuditActor {
  id: string | null;
  roles?: readonly string[];
}

/**
 * Append an audit-log entry for a sensitive action. Call inside the same
 * transaction as the change so the log and the change commit together.
 * Metadata is redacted (no secrets, contact details or coordinates).
 */
export async function recordAudit(
  tx: Tx,
  actor: AuditActor,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
) {
  await tx`
    insert into public.audit_logs (actor_id, actor_roles, action, entity_type, entity_id, metadata)
    values (${actor.id}, ${[...(actor.roles ?? [])]}::text[], ${action}, ${entityType}, ${entityId},
            ${tx.json(redact(metadata) as JsonValue)})`;
}
