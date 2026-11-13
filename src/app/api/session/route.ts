import "server-only";
import { can, getCurrentUser } from "@/server/auth";
import { log } from "@/server/log";

export const dynamic = "force-dynamic";

const PRIVATE = { "Cache-Control": "private, no-store", Vary: "Cookie" } as const;

/**
 * GET /api/session — whether this browser is signed in, for the site chrome
 * (header links, tab bar, the Admin link): { signedIn, canAdmin }.
 *
 * The root layout does not read cookies (so public pages can be cached and
 * shared); the header asks here after it hydrates (src/components/site/session.ts).
 * Nothing personal is returned (no id or email), and the answer is never
 * stored by a browser or CDN. It grants nothing: every page, action and API
 * checks the session itself.
 */
export async function GET() {
  try {
    const user = await getCurrentUser();
    return Response.json({ signedIn: user !== null, canAdmin: can(user?.roles, "admin.access") }, { headers: PRIVATE });
  } catch (err) {
    log.error("api.session_failed", { error: err instanceof Error ? err.message : String(err) });
    return Response.json({ error: "Could not check your session. Please try again." }, { status: 503, headers: PRIVATE });
  }
}
