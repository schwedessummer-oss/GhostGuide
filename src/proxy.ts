import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * Next.js 16 Proxy (formerly middleware).
 *  - In Supabase auth mode, refreshes the auth session cookie on navigation
 *    (official Supabase SSR pattern: getClaims() immediately after creating
 *    the client).
 *  - Authorization is NOT decided here; pages, actions and route handlers
 *    check the session and permissions themselves.
 */
export async function proxy(request: NextRequest) {
  if (process.env.AUTH_PROVIDER !== "supabase") return NextResponse.next({ request });

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

export const config = {
  matcher: [
    // Skip static assets, the service worker, webhooks and cron endpoints.
    "/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|icons/|api/webhooks|api/cron|.*\\.(?:svg|png|jpg|jpeg|gif|webp|mp3|json)$).*)",
  ],
};
