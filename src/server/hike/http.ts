import "server-only";
import type { z } from "zod";
import { jsonError } from "@/server/auth";

/**
 * Request helpers for the hike JSON API. Cookie-authenticated POSTs must be
 * JSON (a cross-site HTML form cannot send application/json without a CORS
 * preflight) and, when the browser sends an Origin header, same-origin.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const o = new URL(origin);
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
    return o.host === host;
  } catch {
    return false;
  }
}

export async function parseJsonBody<S extends z.ZodType>(
  request: Request,
  schema: S,
  maxBytes = 512_000,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; response: Response }> {
  if (!isSameOrigin(request)) return { ok: false, response: jsonError(403, "Cross-origin request refused") };
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) return { ok: false, response: jsonError(415, "Send JSON") };
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > maxBytes) return { ok: false, response: jsonError(413, "Request too large") };
  const text = await request.text();
  if (text.length > maxBytes) return { ok: false, response: jsonError(413, "Request too large") };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, response: jsonError(400, "Invalid JSON") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "body"))].slice(0, 5).join(", ");
    return { ok: false, response: jsonError(400, `Invalid request: ${fields}`) };
  }
  return { ok: true, data: parsed.data };
}
