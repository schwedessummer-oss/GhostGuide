import { getApiUser, jsonError } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import { uploadRouteFile } from "@/server/admin/route-files";
import { MAX_ROUTE_FILE_BYTES } from "@/server/admin/gpx";
import { guarded, isUuid } from "@/server/admin/common";
import { checkRateLimit } from "@/server/rate-limit";

/**
 * Route-file upload (multipart). A route handler instead of a server action
 * because uploads may be up to 2 MB (server actions cap bodies at 1 MB).
 * Same-origin only; returns JSON for the enhanced form, or a 303 redirect
 * back to the geometry page for plain HTML form posts.
 */
export async function POST(request: Request, ctx: RouteContext<"/admin/trails/[id]/geometry/upload">) {
  const { id } = await ctx.params;
  const wantsJson = request.headers.get("x-gg-upload") === "1";
  const back = (q: string) => Response.redirect(new URL(`/admin/trails/${encodeURIComponent(id)}/geometry?${q}`, request.url), 303);

  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const sameOrigin = (() => {
    if (!origin) return true;
    try {
      return !host || new URL(origin).host === host.split(",")[0].trim();
    } catch {
      return false;
    }
  })();
  if (!sameOrigin) return jsonError(403, "Cross-site upload refused");

  const user = await getApiUser();
  if (!user) return wantsJson ? jsonError(401, "Sign in required") : Response.redirect(new URL(`/login?next=/admin/trails/${id}/geometry`, request.url), 303);
  if (!can(user.roles, "trails.manage")) return jsonError(403, "You do not have permission to manage trails");
  if (!isUuid(id)) return jsonError(404, "Trail not found");
  if (!(await checkRateLimit(`admin:route-upload:${user.id}`, 30, 600)).allowed) return jsonError(429, "Too many uploads; wait a few minutes.");

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_ROUTE_FILE_BYTES + 64 * 1024) {
    return wantsJson ? jsonError(413, "The file is larger than 2 MB.") : back("upload=error&reason=too_large");
  }
  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get("file");
    file = f instanceof File ? f : null;
  } catch {
    return wantsJson ? jsonError(400, "Could not read the upload.") : back("upload=error&reason=unreadable");
  }
  if (!file || file.size === 0) return wantsJson ? jsonError(400, "Choose a .geojson or .gpx file.") : back("upload=error&reason=no_file");
  if (file.size > MAX_ROUTE_FILE_BYTES) return wantsJson ? jsonError(413, "The file is larger than 2 MB.") : back("upload=error&reason=too_large");

  const bytes = new Uint8Array(await file.arrayBuffer());
  const result = await guarded(() => uploadRouteFile(user, id, { filename: file.name, bytes }), "admin.route_upload");
  if (wantsJson) return Response.json(result, { status: result.ok ? 200 : 422 });
  if (!result.ok) return back(`upload=error&reason=invalid_request`);
  return back(`upload=${result.data?.status ?? "valid"}&file=${result.data?.routeFileId ?? ""}`);
}
