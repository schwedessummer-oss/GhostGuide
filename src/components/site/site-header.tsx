import { env } from "@/config/env";
import { SiteHeaderNav } from "./site-header-nav";

/**
 * Site header. Desktop (md+): the five primary destinations plus Admin for
 * staff. Phones use the bottom tab bar (TabBar in the root layout) for the
 * primary destinations; the header keeps the brand and a small menu for
 * secondary items.
 *
 * Rendered by the root layout, so it must not read cookies, headers or the
 * session: that would make every page dynamic (no ISR/CDN caching of the
 * public trail pages). The signed-in parts are filled in by the browser
 * (SiteHeaderNav → useSession).
 */
export function SiteHeader() {
  const demo = env().APP_MODE === "demo";

  return (
    <>
      {demo ? (
        <div className="bg-amber-bg text-amber-ink print:hidden">
          <p className="mx-auto max-w-6xl px-4 py-1.5 text-center text-xs font-medium sm:px-6 sm:text-sm">
            <span className="font-bold">Demo:</span> trail, map, weather and place data are real; payments, notifications, partner services and AI
            text are simulated. Always check conditions with official sources.
          </p>
        </div>
      ) : null}
      <header className="border-b border-sand-200 bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/85 print:hidden">
        <SiteHeaderNav />
      </header>
    </>
  );
}
