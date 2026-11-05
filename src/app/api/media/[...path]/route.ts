import { storage, verifyLocalMediaSignature } from "@/integrations/storage";

/** Serves locally stored media via HMAC-signed, expiring URLs (local storage mode only). */
export async function GET(request: Request, ctx: RouteContext<"/api/media/[...path]">) {
  const { path } = await ctx.params;
  const objectPath = path.join("/");
  const url = new URL(request.url);
  const s = storage();
  if (s.kind !== "local") return new Response("Not found", { status: 404 });
  if (!verifyLocalMediaSignature(objectPath, url.searchParams.get("exp"), url.searchParams.get("sig"))) {
    return new Response("Forbidden", { status: 403 });
  }
  const obj = await s.get(objectPath);
  if (!obj) return new Response("Not found", { status: 404 });
  return new Response(Buffer.from(obj.data), {
    headers: { "Content-Type": obj.contentType, "Cache-Control": "private, max-age=3600" },
  });
}
