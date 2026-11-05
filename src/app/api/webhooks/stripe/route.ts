import { receivePaymentWebhook } from "@/server/commerce/payments";

export const dynamic = "force-dynamic";

/**
 * Stripe webhook endpoint. The RAW body (request.text()) is required for
 * signature verification; the shared processor makes handling idempotent.
 * Non-2xx responses make Stripe retry with backoff.
 */
export async function POST(request: Request) {
  const rawBody = await request.text();
  const result = await receivePaymentWebhook("stripe", rawBody, request.headers);
  return Response.json(result.body, { status: result.status });
}
