import "server-only";
import { withSystem } from "@/server/db";
import type { SessionUser } from "@/server/auth";
import { log } from "@/server/log";
import { demoWebhookHeaders, getDemoSession, settleDemoSession, type DemoOutcome, type DemoSessionRow } from "@/integrations/payments/demo";
import { receivePaymentWebhook } from "./payments";

/**
 * Use-cases behind the SIMULATED payment page (/checkout/demo/[sessionId]).
 * The page acts as the "provider": it settles the session and delivers a
 * signed event to the webhook processor behind /api/webhooks/demo-payments —
 * the same processor Stripe events go through. The page itself never
 * confirms a booking.
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
  /** One of the processor's known outcomes, or "rejected" / "failed" — never text taken from a response. */
  outcome: DeliveryOutcome;
  via: "in-process";
}

const KNOWN_OUTCOMES = ["confirmed", "needs_attention", "payment_failed", "expired", "refund_synced", "noop", "duplicate", "ignored", "failed"] as const;
export type DeliveryOutcome = (typeof KNOWN_OUTCOMES)[number] | "rejected";

/**
 * Deliver a signed demo event to the SAME webhook processor the
 * /api/webhooks/demo-payments route uses, in-process. The signature is still
 * verified (receivePaymentWebhook → parseWebhook), so this exercises the real
 * verification and idempotency path.
 *
 * Security: the app never builds a URL from request headers to call itself
 * (X-Forwarded-Host / -Proto are client-controlled, which made the former
 * HTTP self-delivery an SSRF vector), and nothing from a remote response is
 * ever shown to the customer: the outcome is mapped onto a fixed set.
 */
export async function deliverDemoWebhook(rawBody: string): Promise<Delivery> {
  const headers = demoWebhookHeaders(rawBody);
  const res = await receivePaymentWebhook("demo", rawBody, new Headers(headers));
  const raw = res.body.outcome;
  const outcome: DeliveryOutcome =
    res.status === 200 && typeof raw === "string" && (KNOWN_OUTCOMES as readonly string[]).includes(raw) ? (raw as DeliveryOutcome) : res.status === 400 ? "rejected" : "failed";
  if (outcome === "failed" || outcome === "rejected") log.warn("demo_payments.delivery_not_processed", { status: res.status });
  return { status: res.status, outcome, via: "in-process" };
}

export type SimulateResult =
  | { ok: true; redirectTo: string; delivery: Delivery }
  | { ok: false; error: string };

export async function simulateDemoPayment(user: SessionUser, sessionId: string, outcome: DemoOutcome): Promise<SimulateResult> {
  const view = await getDemoCheckoutView(user, sessionId);
  if (!view) return { ok: false, error: "Checkout session not found." };
  const settled = await settleDemoSession(sessionId, outcome);
  if (!settled) return { ok: false, error: "This simulated checkout has already been completed or cancelled." };
  const delivery = await deliverDemoWebhook(settled.body);
  const target = outcome === "paid" ? settled.session.successUrl : settled.session.cancelUrl;
  const redirectTo = outcome === "declined" ? `${target}&reason=declined` : outcome === "cancelled" ? `${target}&reason=cancelled` : target;
  return { ok: true, redirectTo, delivery };
}

/** Re-send the last event (same event id) to demonstrate duplicate-delivery handling. */
export async function redeliverLastDemoEvent(user: SessionUser, sessionId: string): Promise<{ ok: true; delivery: Delivery; eventId: string } | { ok: false; error: string }> {
  const view = await getDemoCheckoutView(user, sessionId);
  if (!view) return { ok: false, error: "Checkout session not found." };
  const body = view.session.lastEventBody;
  if (!body) return { ok: false, error: "No webhook has been delivered for this session yet." };
  const eventId = (JSON.parse(body) as { id: string }).id;
  return { ok: true, delivery: await deliverDemoWebhook(body), eventId };
}
