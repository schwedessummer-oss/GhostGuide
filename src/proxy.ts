import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Next.js 16 Proxy (formerly middleware).
 *  - Old OpenStreetMap trail pages (/trail/...) are gone for good: they
 *    answer 410 Gone here, without the database, so search engines drop
 *    them (docs/PLAN.md §2). Where a curated hike matches an old trail, a
 *    redirect can be added once the new catalog is published.
 *  - In Supabase auth mode, refreshes the auth session cookie on navigation
 *    (official Supabase SSR pattern: getClaims() immediately after creating
 *    the client).
 *  - Authorization is NOT decided here; pages, actions and route handlers
 *    check the session and permissions themselves.
 */
export async function proxy(request: NextRequest) {
  if (isRemovedTrailPath(request.nextUrl.pathname)) return goneResponse();

  if (process.env.AUTH_PROVIDER !== "supabase") return NextResponse.next({ request });
  // Signed-out visitors have no Supabase session to refresh. Skipping them
  // keeps Set-Cookie off public pages, so the CDN can cache them.
  if (!request.cookies.getAll().some((c) => c.name.startsWith("sb-"))) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet, headers) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
          Object.entries(headers ?? {}).forEach(([key, value]) => response.headers.set(key, value as string));
        },
      },
    },
  );
  await supabase.auth.getClaims();
  return response;
}

/** /trail and every path below it, in any letter case (old URLs were redirected to lower case). */
const REMOVED_TRAIL_PATH_RE = /^\/trail(?:\/|$)/i;
export function isRemovedTrailPath(pathname: string): boolean {
  return REMOVED_TRAIL_PATH_RE.test(pathname);
}

const GONE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Page removed · Ghost Guide</title></head>
<body style="font-family:system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1>This page has been removed</h1>
<p>Ghost Guide no longer has these trail pages. It is being rebuilt as a guide to the world&apos;s best hikes.</p>
<p><a href="/">Go to the home page</a></p>
</body>
</html>`;

function goneResponse(): Response {
  return new Response(GONE_HTML, {
    status: 410,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=3600",
      "x-robots-tag": "noindex",
    },
  });
}

export const config = {
  matcher: [
    // Skip static assets, the service worker and cron endpoints.
    "/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|icons/|api/cron|.*\\.(?:svg|png|jpg|jpeg|gif|webp|json)$).*)",
  ],
};
