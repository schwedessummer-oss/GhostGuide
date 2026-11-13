import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Next.js 16 Proxy (formerly middleware).
 *  - Trail pages live at lower-case paths: /trail/US/South-Carolina/Table-Rock-Trail
 *    answers one permanent redirect (308) to /trail/us/south-carolina/table-rock-trail
 *    here, before the page and without the database. (Old paths of moved
 *    trails need the database; the trail page redirects those.)
 *  - In Supabase auth mode, refreshes the auth session cookie on navigation
 *    (official Supabase SSR pattern: getClaims() immediately after creating
 *    the client).
 *  - Authorization is NOT decided here; pages, actions and route handlers
 *    check the session and permissions themselves.
 */
export async function proxy(request: NextRequest) {
  const trailPath = lowerCaseTrailPath(request.nextUrl.pathname);
  if (trailPath) {
    const url = request.nextUrl.clone();
    url.pathname = trailPath;
    return NextResponse.redirect(url, 308);
  }

  if (process.env.AUTH_PROVIDER !== "supabase") return NextResponse.next({ request });
  // Signed-out visitors have no Supabase session to refresh. Skipping them
  // keeps Set-Cookie off public pages, so the CDN can cache ISR trail pages.
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

/**
 * A trail page path (/trail/<country>/<region>/<slug> in ASCII letters,
 * digits and hyphens, like every stored path) written with upper-case
 * letters → the same path in lower case; otherwise null. Other shapes and
 * characters are left to the page, which answers 404 when no trail has the path.
 *
 * Done here, not in the ISR trail page: Next.js 16.4 sends a redirect thrown
 * during an ISR page's first (uncached) render with its Location header twice
 * (prerenderToStream sets it on the live response and records it in the cache
 * entry, and the entry's headers are then appended to that same response).
 */
const MIXED_CASE_TRAIL_PATH_RE = /^\/trail\/[A-Za-z]{2}\/[A-Za-z0-9-]{1,80}\/[A-Za-z0-9-]{1,120}$/;
export function lowerCaseTrailPath(pathname: string): string | null {
  if (!MIXED_CASE_TRAIL_PATH_RE.test(pathname)) return null;
  const lower = pathname.toLowerCase();
  return lower === pathname ? null : lower;
}

export const config = {
  matcher: [
    // Skip static assets, the service worker, webhooks and cron endpoints.
    "/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|icons/|api/webhooks|api/cron|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp3|json)$).*)",
  ],
};
