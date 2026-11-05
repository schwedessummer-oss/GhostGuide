/** Result type for hike use-cases: route handlers map `status` to the HTTP status. */
export type HikeResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409 | 422 | 429; error: string };

export const ok = <T>(value: T): HikeResult<T> => ({ ok: true, value });
export const notFound = <T = never>(error = "Not found"): HikeResult<T> => ({ ok: false, status: 404, error });
export const conflict = <T = never>(error: string): HikeResult<T> => ({ ok: false, status: 409, error });

export function toResponse<T>(r: HikeResult<T>, init?: ResponseInit): Response {
  if (r.ok) return Response.json(r.value, { ...init, headers: { "Cache-Control": "private, no-store", ...(init?.headers ?? {}) } });
  return Response.json({ error: r.error }, { status: r.status, headers: { "Cache-Control": "private, no-store" } });
}
