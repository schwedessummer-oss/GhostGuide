"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";

/** Horizontal sub-navigation (wraps on small screens); marks the current tab with aria-current. */
export function SubTabs({ label, tabs }: { label: string; tabs: { href: string; label: string; exact?: boolean }[] }) {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label={label} className="mb-6 border-b border-sand-200">
      <ul className="-mb-px flex flex-wrap gap-x-1">
        {tabs.map((t) => {
          const current = t.exact ? pathname === t.href : pathname === t.href || pathname.startsWith(`${t.href}/`);
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={current ? "page" : undefined}
                className={clsx(
                  "inline-flex min-h-11 items-center border-b-2 px-3 font-semibold",
                  current ? "border-forest-700 text-forest-800" : "border-transparent text-muted hover:text-ink",
                )}
              >
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
