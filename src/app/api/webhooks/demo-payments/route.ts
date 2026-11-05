import { receivePaymentWebhook } from "@/server/commerce/payments";

export const dynamic = "force-dynamic";

/**
 * Webhook endpoint of the SIMULATED payment provider. Events are signed with
 * HMAC-SHA256(AUTH_SECRET) over "<timestamp>.<raw body>" (x-demo-signature,
 * 5-minute replay window) and processed by the same processor as Stripe.
 * The demo adapter refuses to run when APP_MODE=live.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  if (rawBody.length > 64 * 1024) return Response.json({ error: "payload too large" }, { status: 413 });
  const result = await receivePaymentWebhook("demo", rawBody, request.headers);
  return Response.json(result.body, { status: result.status });
}
