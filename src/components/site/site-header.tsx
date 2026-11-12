import Link from "next/link";
import { Compass, Menu } from "lucide-react";
import { getCurrentUser } from "@/server/auth";
import { can } from "@/server/auth/rbac";
import { env } from "@/config/env";
import { SignOutButton } from "@/components/hike/sign-out-guard";
import { HeaderNavLinks } from "./primary-nav";

/**
 * Site header. Desktop (md+): the five primary destinations plus Admin for
 * staff. Phones use the bottom tab bar (TabBar in the root layout) for the
 * primary destinations; the header keeps the brand and a small menu for
 * secondary items.
 */
export async function SiteHeader() {
  const user = await getCurrentUser();
  const isAdmin = can(user?.roles, "admin.access");
  const demo = env().APP_MODE === "demo";
  const secondary = [{ href: "/how-it-works", label: "How it works & limits" }, ...(isAdmin ? [{ href: "/admin", label: "Admin" }] : [])];

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
        <nav aria-label="Main" className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-1.5 sm:px-6 md:py-2.5">
          <Link href="/" className="flex min-h-11 items-center gap-2 text-lg font-bold tracking-tight text-forest-800">
            <Compass aria-hidden className="size-6" />
            Ghost Guide
          </Link>

          <div className="hidden items-center gap-1 md:flex">
            <HeaderNavLinks signedIn={Boolean(user)} extra={isAdmin ? [{ href: "/admin", label: "Admin" }] : []} />
            {user ? (
              <SignOutButton className="inline-flex min-h-11 items-center rounded-lg px-3 font-medium text-muted hover:bg-forest-50">Sign out</SignOutButton>
            ) : (
              <Link href="/login" className="ml-2 inline-flex min-h-11 items-center rounded-xl bg-forest-700 px-4 font-semibold text-white hover:bg-forest-800">
                Sign in
              </Link>
            )}
          </div>

          {/* Phones: primary destinations live in the bottom tab bar; this menu holds the rest (works without JavaScript). */}
          <div className="flex items-center gap-1 md:hidden">
            {user ? null : (
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
                {secondary.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} className="flex min-h-11 items-center rounded-lg px-3 font-medium hover:bg-forest-50">
                      {l.label}
                    </Link>
                  </li>
                ))}
                <li>
                  {user ? (
                    <SignOutButton className="flex min-h-11 w-full items-center rounded-lg px-3 text-left font-medium hover:bg-forest-50">Sign out</SignOutButton>
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
      </header>
    </>
  );
}
