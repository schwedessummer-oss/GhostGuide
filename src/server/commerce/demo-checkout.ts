import "server-only";
import { withSystem } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { log } from "@/server/log";
import { demoWebhookHeaders, getDemoSession, settleDemoSession, type DemoOutcome, type DemoSessionRow } from "@/integrations/payments/demo";
import { receivePaymentWebhook } from "./payments";

/**
 * Use-cases behind the SIMULATED payment page (/checkout/demo/[sessionId]).
 * The page acts as the "provider": it settles the session and delivers a
 * signed webhook to /api/webhooks/demo-payments — the same processor Stripe
 * uses. The page itself never confirms a booking.
 */
export interface DemoCheckoutView {
  session: DemoSessionRow;
  bookingStatus: string;
  trailName: string;
  hikeDate: string;
  partySize: number;
  holdExpiresAt: Date | null;
  timezone: string;
}

/** Owner-only; null for anyone else (404). */
export async function getDemoCheckoutView(user: SessionUser, sessionId: string): Promise<DemoCheckoutView | null> {
  const session = await getDemoSession(sessionId);
  if (!session || session.userId !== user.id) return null;
  const [b] = await withSystem(
    (tx) => tx<{ status: string; trailName: string; hikeDate: string; partySize: number; holdExpiresAt: Date | null; timezone: string }[]>`
      select b.status, t.name as trail_name, to_char(b.hike_date, 'YYYY-MM-DD') as hike_date, b.party_size, b.hold_expires_at, r.timezone
      from public.bookings b join public.trails t on t.id = b.trail_id join public.regions r on r.id = t.region_id
      where b.id = ${session.bookingId} and b.user_id = ${user.id}`,
  );
  if (!b) return null;
  return { session, bookingStatus: b.status, trailName: b.trailName, hikeDate: b.hikeDate, partySize: b.partySize, holdExpiresAt: b.holdExpiresAt, timezone: b.timezone };
}

export interface Delivery {
  status: number;
  outcome: string;
  via: "http" | "in-process";
}

/**
 * Deliver a signed demo event to the webhook endpoint over HTTP (like a real
 * provider). If the app cannot reach itself (e.g. unusual local networking),
 * fall back to calling the identical handler in-process — still verifying
 * the signature.
 */
export async function deliverDemoWebhook(rawBody: string, origin: string | null): Promise<Delivery> {
  const headers = demoWebhookHeaders(rawBody);
  if (origin) {
    try {
      const res = await fetch(`${origin}/api/webhooks/demo-payments`, { method: "POST", headers, body: rawBody, cache: "no-store" });
      const json = (await res.json().catch(() => null)) as { received?: boolean; outcome?: string; error?: string } | null;
      // Only trust a response that came from our own webhook handler.
      if (json && (json.received === true || typeof json.error === "string")) {
        return { status: res.status, outcome: json.outcome ?? json.error ?? "unknown", via: "http" };
      }
      log.warn("demo_payments.http_delivery_unexpected_response", { status: res.status });
    } catch (err) {
      log.warn("demo_payments.http_delivery_failed", { error: err instanceof Error ? err.message : String(err) });
    }
  }
  const res = await receivePaymentWebhook("demo", rawBody, new Headers(headers));
  return { status: res.status, outcome: String(res.body.outcome ?? res.body.error ?? "unknown"), via: "in-process" };
}

export type SimulateResult =
  | { ok: true; redirectTo: string; delivery: Delivery }
  | { ok: false; error: string };

export async function simulateDemoPayment(user: SessionUser, sessionId: string, outcome: DemoOutcome, origin: string | null): Promise<SimulateResult> {
  const view = await getDemoCheckoutView(user, sessionId);
  if (!view) return { ok: false, error: "Checkout session not found." };
  const settled = await settleDemoSession(sessionId, outcome);
  if (!settled) return { ok: false, error: "This simulated checkout has already been completed or cancelled." };
  const delivery = await deliverDemoWebhook(settled.body, origin);
  const target = outcome === "paid" ? settled.session.successUrl : settled.session.cancelUrl;
  const redirectTo = outcome === "declined" ? `${target}&reason=declined` : outcome === "cancelled" ? `${target}&reason=cancelled` : target;
  return { ok: true, redirectTo, delivery };
}

/** Re-send the last event (same event id) to demonstrate duplicate-delivery handling. */
export async function redeliverLastDemoEvent(user: SessionUser, sessionId: string, origin: string | null): Promise<{ ok: true; delivery: Delivery; eventId: string } | { ok: false; error: string }> {
  const view = await getDemoCheckoutView(user, sessionId);
  if (!view) return { ok: false, error: "Checkout session not found." };
  const body = view.session.lastEventBody;
  if (!body) return { ok: false, error: "No webhook has been delivered for this session yet." };
  const eventId = (JSON.parse(body) as { id: string }).id;
  return { ok: true, delivery: await deliverDemoWebhook(body, origin), eventId };
}
