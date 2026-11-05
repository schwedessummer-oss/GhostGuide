"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import clsx from "clsx";
import {
  Activity,
  BadgeDollarSign,
  BookOpenCheck,
  CalendarDays,
  ClipboardList,
  FileBadge,
  Flag,
  Gauge,
  LifeBuoy,
  ListChecks,
  Map as MapIcon,
  Megaphone,
  Menu,
  Package,
  Bell,
  Ticket,
  Users,
  UserCog,
  Wrench,
} from "lucide-react";
import type { AdminIcon } from "./nav-items";

const ICONS: Record<AdminIcon, typeof Gauge> = {
  overview: Gauge,
  trails: MapIcon,
  content: BookOpenCheck,
  customers: Users,
  bookings: Ticket,
  availability: CalendarDays,
  pricing: BadgeDollarSign,
  fulfillment: Package,
  gear: Wrench,
  safety: Activity,
  notifications: Bell,
  permits: FileBadge,
  marketing: Megaphone,
  support: LifeBuoy,
  jobs: ListChecks,
  flags: Flag,
  staff: UserCog,
  audit: ClipboardList,
};

export interface NavGroup {
  group: string;
  items: { href: string; label: string; icon: AdminIcon }[];
}

function isCurrent(pathname: string, href: string) {
  return href === "/admin" ? pathname === "/admin" : pathname === href || pathname.startsWith(`${href}/`);
}

function NavList({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname() ?? "";
  return (
    <div className="space-y-5">
      {groups.map((g) => (
        <div key={g.group}>
          <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">{g.group}</p>
          <ul className="space-y-0.5">
            {g.items.map((item) => {
              const Icon = ICONS[item.icon];
              const current = isCurrent(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={current ? "page" : undefined}
                    className={clsx(
                      "flex min-h-11 items-center gap-3 rounded-lg px-3 font-medium",
                      current ? "bg-forest-700 text-white" : "text-ink hover:bg-forest-50",
                    )}
                  >
                    <Icon aria-hidden className="size-5 shrink-0" />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Sidebar on large screens; a disclosure menu on small screens that closes after navigating. */
export function AdminNav({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (details.current) details.current.open = false;
  }, [pathname]);
  const current = groups.flatMap((g) => g.items).find((i) => isCurrent(pathname ?? "", i.href));
  return (
    <>
      <details ref={details} className="rounded-xl border border-sand-200 bg-surface lg:hidden">
        <summary className="flex min-h-12 cursor-pointer list-none items-center gap-3 px-4 font-semibold [&::-webkit-details-marker]:hidden">
          <Menu aria-hidden className="size-5" />
          <span>Admin menu</span>
          {current ? <span className="ml-auto truncate text-sm font-normal text-muted">{current.label}</span> : null}
        </summary>
        <nav aria-label="Admin sections" className="border-t border-sand-200 p-2">
          <NavList groups={groups} />
        </nav>
      </details>
      <nav aria-label="Admin sections" className="hidden lg:block">
        <NavList groups={groups} />
      </nav>
    </>
  );
}
