"use client";

import Link from "next/link";
import { Compass, Menu } from "lucide-react";
import { SignOutButton } from "@/components/hike/sign-out-guard";
import { HeaderNavLinks } from "./primary-nav";
import { useSession } from "./session";

const ADMIN_LINK = { href: "/admin", label: "Admin" };

/**
 * The header's navigation. The server HTML is the signed-out version for
 * everyone (the root layout reads no cookies, so public pages stay
 * cacheable); after hydration it follows the visitor's session
 * (src/components/site/session.ts): Profile → account, Sign out, and Admin
 * for staff who may open it.
 */
export function SiteHeaderNav() {
  const { signedIn, canAdmin } = useSession();
  const extra = canAdmin ? [ADMIN_LINK] : [];
  const secondary = [{ href: "/how-it-works", label: "How it works & limits" }, ...extra];

  return (
    <nav aria-label="Main" className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-1.5 sm:px-6 md:py-2.5">
      <Link href="/" className="flex min-h-11 items-center gap-2 text-lg font-bold tracking-tight text-forest-800">
        <Compass aria-hidden className="size-6" />
        Ghost Guide
      </Link>

      <div className="hidden items-center gap-1 md:flex">
        <HeaderNavLinks signedIn={signedIn} extra={extra} />
        {signedIn ? (
          <SignOutButton className="inline-flex min-h-11 items-center rounded-lg px-3 font-medium text-muted hover:bg-forest-50">Sign out</SignOutButton>
        ) : (
          <Link href="/login" className="ml-2 inline-flex min-h-11 items-center rounded-xl bg-forest-700 px-4 font-semibold text-white hover:bg-forest-800">
            Sign in
          </Link>
        )}
      </div>

      {/* Phones: primary destinations live in the bottom tab bar; this menu holds the rest (works without JavaScript). */}
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
            {secondary.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="flex min-h-11 items-center rounded-lg px-3 font-medium hover:bg-forest-50">
                  {l.label}
                </Link>
              </li>
            ))}
            <li>
              {signedIn ? (
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
  );
}
