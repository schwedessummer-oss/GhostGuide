import { env } from "@/config/env";
import { SiteHeaderNav } from "./site-header-nav";

/**
 * Site header: the brand and the account links (Admin for staff).
 *
 * Rendered by the root layout, so it must not read cookies, headers or the
 * session: that would make every page dynamic (no static or CDN caching of
 * public pages). The signed-in parts are filled in by the browser
 * (SiteHeaderNav → useSession).
 */
export function SiteHeader() {
  const demo = env().APP_MODE === "demo";

  return (
    <>
      {demo ? (
        <div className="bg-amber-bg text-amber-ink print:hidden">
          <p className="mx-auto max-w-6xl px-4 py-1.5 text-center text-xs font-medium sm:px-6 sm:text-sm">
            <span className="font-bold">Demo:</span> this is a test build of Ghost Guide.
          </p>
        </div>
      ) : null}
      <header className="border-b border-sand-200 bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85 print:hidden">
        <SiteHeaderNav />
      </header>
    </>
  );
}
