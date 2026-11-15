"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import clsx from "clsx";
import { Compass, Menu } from "lucide-react";
import { isCurrentPath, siteNav } from "./nav";
import { useSession } from "./session";

const noopSubscribe = () => () => {};

/**
 * The current path, but only after hydration. The server HTML never carries
 * route-specific "current" markup (it is shared by every visitor), so it
 * always hydrates cleanly; the highlight appears right after hydration.
 */
function useHydratedPathname(): string {
  const pathname = usePathname();
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return hydrated ? pathname : "";
}

/**
 * The header's navigation. The server HTML is the signed-out version for
 * everyone (the root layout reads no cookies, so public pages stay
 * cacheable); after hydration it follows the visitor's session
 * (src/components/site/session.ts): Account, Sign out, and Admin for staff
 * who may open it.
 */
export function SiteHeaderNav() {
  const { signedIn, canAdmin } = useSession();
  const pathname = useHydratedPathname();
  const links = siteNav({ signedIn, canAdmin });

  return (
    <nav aria-label="Main" className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-1.5 sm:px-6 md:py-2.5">
      <Link href="/" className="flex min-h-11 items-center gap-2 text-lg font-bold tracking-tight text-forest-800">
        <Compass aria-hidden className="size-6" />
        Ghost Guide
      </Link>

      <div className="hidden items-center gap-1 md:flex">
        <ul className="flex items-center gap-0.5">
          {links.map((l) => {
            const current = isCurrentPath(pathname, l.href);
            return (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={current ? "page" : undefined}
                  className={clsx("inline-flex min-h-11 items-center rounded-lg px-3 font-medium hover:bg-forest-50", current ? "text-forest-800" : "text-ink")}
                >
                  {l.label}
                </Link>
              </li>
            );
          })}
        </ul>
        {signedIn ? (
          <SignOutButton className="inline-flex min-h-11 items-center rounded-lg px-3 font-medium text-muted hover:bg-forest-50" />
        ) : (
          <Link href="/login" className="ml-2 inline-flex min-h-11 items-center rounded-xl bg-forest-700 px-4 font-semibold text-white hover:bg-forest-800">
            Sign in
          </Link>
        )}
      </div>

      {/* Phones: a small menu (works without JavaScript). */}
      <div className="flex items-center gap-1 md:hidden">
        {signedIn ? null : (
          <Link href="/login" className="inline-flex min-h-11 items-center rounded-xl px-3 font-semibold text-forest-800 hover:bg-forest-50">
            Sign in
          </Link>
        )}
        <details className="relative">
          <summary className="flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center rounded-lg hover:bg-forest-50 [&::-webkit-details-marker]:hidden">
            <Menu aria-hidden className="size-6" />
            <span className="sr-only">More</span>
          </summary>
          <ul className="absolute right-0 z-50 mt-2 w-60 rounded-xl border border-sand-200 bg-surface p-2 shadow-lg">
            {links.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={isCurrentPath(pathname, l.href) ? "page" : undefined}
                  className="flex min-h-11 items-center rounded-lg px-3 font-medium hover:bg-forest-50"
                >
                  {l.label}
                </Link>
              </li>
            ))}
            <li>
              {signedIn ? (
                <SignOutButton className="flex min-h-11 w-full items-center rounded-lg px-3 text-left font-medium hover:bg-forest-50" />
              ) : (
                <Link href="/signup" className="flex min-h-11 items-center rounded-lg px-3 font-medium hover:bg-forest-50">
                  Create an account
                </Link>
              )}
            </li>
          </ul>
        </details>
      </div>
    </nav>
  );
}

/** Sign out: a plain POST form to /auth/logout (works without JavaScript). */
function SignOutButton({ className }: { className: string }) {
  return (
    <form action="/auth/logout" method="post">
      <button className={className} data-testid="sign-out">
        Sign out
      </button>
    </form>
  );
}
