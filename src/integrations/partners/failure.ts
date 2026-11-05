import "server-only";
import { recordIntegrationEvent } from "@/server/integration-log";
import { PartnerRejectedError, PartnerTransientError, type PartnerCallContext, type SimulateMode } from "./types";

/**
 * Deterministic failure injection for demo adapters (documented in README.md):
 *
 *   booking_addons.details.simulate = "fail"       every attempt fails (transient) → retries → needs_attention
 *   booking_addons.details.simulate = "fail_once"  the first attempt fails, the retry succeeds
 *   booking_addons.details.simulate = "reject"     the partner declines (permanent) → needs_attention at once
 *
 * Adapter-specific rules (also documented): the demo meal-pack kitchen
 * rejects orders for a party of exactly 7.
 */
export function injectSimulatedFailure(partner: string, ctx: PartnerCallContext) {
  const mode: SimulateMode | null | undefined = ctx.simulate;
  if (mode === "fail") throw new PartnerTransientError(`Simulated ${partner} timeout (failure injection: fail)`);
  if (mode === "fail_once" && ctx.attempt <= 1) throw new PartnerTransientError(`Simulated ${partner} timeout (failure injection: fail_once)`);
  if (mode === "reject") throw new PartnerRejectedError(`Simulated ${partner} rejection (failure injection: reject)`);
}

/**
 * Run a partner call and log it for the integration-health view:
 * outcome "simulated" for demo adapters, "failure" when the call throws.
 */
export async function partnerCall<T>(
  meta: { providerKind: string; providerKey: string; operation: string; entityType?: string; entityId?: string; simulated: boolean },
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    await recordIntegrationEvent({
      providerKind: meta.providerKind,
      providerKey: meta.providerKey,
      operation: meta.operation,
      outcome: meta.simulated ? "simulated" : "success",
      entityType: meta.entityType,
      entityId: meta.entityId,
      durationMs: Date.now() - started,
    });
    return result;
  } catch (err) {
    await recordIntegrationEvent({
      providerKind: meta.providerKind,
      providerKey: meta.providerKey,
      operation: meta.operation,
      outcome: "failure",
      entityType: meta.entityType,
      entityId: meta.entityId,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    });
    throw err;
  }
}
