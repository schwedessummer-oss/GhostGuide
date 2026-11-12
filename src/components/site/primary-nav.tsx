"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import clsx from "clsx";
import { Bookmark, CalendarDays, CircleUserRound, Compass, Footprints, type LucideIcon } from "lucide-react";
import { activeNavKey, primaryNav, type NavKey } from "./nav";

const ICONS: Record<NavKey, LucideIcon> = {
  explore: Compass,
  trips: CalendarDays,
  hike: Footprints,
  saved: Bookmark,
  profile: CircleUserRound,
};

/** Desktop header links (md and up). */
const noopSubscribe = () => () => {};

/**
 * The current path, but only after hydration. Server HTML (and the service
 * worker's cached /offline shell, which is served under other URLs) never
 * carries route-specific "current" markup, so it always hydrates cleanly; the
 * highlight appears right after hydration.
 */
function useHydratedPathname(): string {
  const pathname = usePathname();
  const hydrated = useSyncExternalStore(noopSubscribe, () => true, () => false);
  return hydrated ? pathname : "";
}

export function HeaderNavLinks({ signedIn, extra = [] }: { signedIn: boolean; extra?: { href: string; label: string }[] }) {
  const pathname = useHydratedPathname();
  const active = activeNavKey(pathname);
  return (
    <ul className="hidden items-center gap-0.5 md:flex">
      {primaryNav(signedIn).map((item) => {
        const current = active === item.key;
        return (
          <li key={item.key}>
            <Link
              href={item.href}
              aria-current={current ? "page" : undefined}
              className={clsx(
                "relative inline-flex min-h-11 items-center rounded-lg px-3 font-medium transition-colors",
                current ? "text-forest-800" : "text-ink hover:bg-forest-50",
              )}
            >
              {item.label}
              {current ? <span aria-hidden className="absolute inset-x-3 -bottom-[7px] h-0.5 rounded-full bg-forest-700" /> : null}
            </Link>
          </li>
        );
      })}
      {extra.map((l) => {
        const current = pathname === l.href || pathname.startsWith(`${l.href}/`);
        return (
          <li key={l.href}>
            <Link
              href={l.href}
              aria-current={current ? "page" : undefined}
              className={clsx("inline-flex min-h-11 items-center rounded-lg px-3 font-medium hover:bg-forest-50", current ? "text-forest-800" : "text-muted")}
            >
              {l.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

/** Phone bottom tab bar (below md): fixed, safe-area aware, 56 px targets. */
export function TabBar({ signedIn }: { signedIn: boolean }) {
  const active = activeNavKey(useHydratedPathname());
  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-sand-200 bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-surface/90 md:hidden print:hidden"
    >
      <ul className="mx-auto grid max-w-lg grid-cols-5">
        {primaryNav(signedIn).map((item) => {
          const Icon = ICONS[item.key];
          const current = active === item.key;
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                aria-current={current ? "page" : undefined}
                className={clsx(
                  "flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[0.7rem] font-semibold tracking-wide transition-colors",
                  current ? "text-forest-800" : "text-muted hover:text-ink",
                )}
              >
                <span className={clsx("flex h-7 w-12 items-center justify-center rounded-full transition-colors", current && "bg-forest-100")}>
                  <Icon aria-hidden className="size-[1.3rem]" strokeWidth={current ? 2.4 : 2} />
                </span>
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
