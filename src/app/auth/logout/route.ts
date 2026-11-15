import { signOut } from "@/server/auth";

/**
 * Sign out, then go home. Clear-Site-Data asks supporting browsers to drop
 * this site's caches and storage too (a shared device keeps nothing from the
 * previous visitor).
 */
export async function POST(request: Request) {
  // Same-origin check: logout is state-changing.
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return new Response("Forbidden", { status: 403 });
  }
  await signOut();
  return new Response(null, {
    status: 303,
    headers: {
      Location: "/",
      "Cache-Control": "no-store",
      "Clear-Site-Data": '"cache", "storage"',
    },
  });
}
