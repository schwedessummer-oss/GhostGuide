import "server-only";
import { withSystem, type Tx } from "@/server/db";
import { redactString } from "@/server/log";

export interface IntegrationEvent {
  providerKind: string; // e.g. weather
  providerKey: string; // e.g. nws | demo
  operation: string;
  outcome: "success" | "failure" | "simulated";
  entityType?: string;
  entityId?: string;
  error?: string;
  durationMs?: number;
}

/** Record a provider call for the operator's integration-health view. */
export async function recordIntegrationEvent(ev: IntegrationEvent, tx?: Tx) {
  const write = (t: Tx) => t`
    insert into public.integration_events (provider_kind, provider_key, operation, outcome, entity_type, entity_id, error, duration_ms)
    values (${ev.providerKind}, ${ev.providerKey}, ${ev.operation}, ${ev.outcome}, ${ev.entityType ?? null},
            ${ev.entityId ?? null}, ${ev.error ? redactString(ev.error) : null}, ${ev.durationMs ?? null})`;
  if (tx) await write(tx);
  else await withSystem(write);
}
