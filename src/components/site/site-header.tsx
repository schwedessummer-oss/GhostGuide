import Link from "next/link";
import { Compass, Menu } from "lucide-react";
import { getCurrentUser } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import { env } from "@/config/env";

const customerLinks = [
  { href: "/trails", label: "Trails" },
  { href: "/plan", label: "Plan a hike" },
  { href: "/trips", label: "My trips" },
];

export async function SiteHeader() {
  const user = await getCurrentUser();
  const isAdmin = can(user?.roles, "admin.access");
  const demo = env().APP_MODE === "demo";

  const links = [...customerLinks, ...(user ? [{ href: "/account", label: "Account" }] : []), ...(isAdmin ? [{ href: "/admin", label: "Admin" }] : [])];

  return (
    <>
      {demo ? (
        <div className="bg-amber-bg text-amber-ink">
          <p className="mx-auto max-w-6xl px-4 py-2 text-center text-sm font-medium sm:px-6">
            Demo mode: trails are fictional, and payments, notifications, partner services and AI text are simulated.
            Do not use this demo to plan a real hike.
          </p>
        </div>
      ) : null}
      <header className="border-b border-sand-200 bg-surface/95 backdrop-blur supports-[backdrop-filter]:bg-surface/80">
        <nav aria-label="Main" className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6">
          <Link href="/" className="flex min-h-11 items-center gap-2 text-lg font-bold text-forest-800">
            <Compass aria-hidden className="size-6" />
            Ghost Guide
          </Link>

          <ul className="hidden items-center gap-1 md:flex">
            {links.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="inline-flex min-h-11 items-center rounded-lg px-3 font-medium text-ink hover:bg-forest-50">
                  {l.label}
                </Link>
              </li>
            ))}
            <li>
              {user ? (
                <form action="/auth/logout" method="post">
                  <button className="inline-flex min-h-11 items-center rounded-lg px-3 font-medium text-muted hover:bg-forest-50">Sign out</button>
                </form>
              ) : (
                <Link href="/login" className="ml-2 inline-flex min-h-11 items-center rounded-xl bg-forest-700 px-4 font-semibold text-white hover:bg-forest-800">
                  Sign in
                </Link>
              )}
            </li>
          </ul>

          {/* Mobile: disclosure menu without client JavaScript */}
          <details className="relative md:hidden">
            <summary className="flex min-h-11 min-w-11 cursor-pointer list-none items-center justify-center rounded-lg hover:bg-forest-50 [&::-webkit-details-marker]:hidden">
              <Menu aria-hidden className="size-6" />
              <span className="sr-only">Open menu</span>
            </summary>
            <ul className="absolute right-0 z-50 mt-2 w-56 rounded-xl border border-sand-200 bg-surface p-2 shadow-lg">
              {links.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} className="flex min-h-11 items-center rounded-lg px-3 font-medium hover:bg-forest-50">
                    {l.label}
                  </Link>
                </li>
              ))}
              <li>
                {user ? (
                  <form action="/auth/logout" method="post">
                    <button className="flex min-h-11 w-full items-center rounded-lg px-3 text-left font-medium hover:bg-forest-50">Sign out</button>
                  </form>
                ) : (
                  <Link href="/login" className="flex min-h-11 items-center rounded-lg px-3 font-semibold text-forest-800 hover:bg-forest-50">
                    Sign in
                  </Link>
                )}
              </li>
            </ul>
          </details>
        </nav>
      </header>
    </>
  );
}
