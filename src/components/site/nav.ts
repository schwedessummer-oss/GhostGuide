/**
 * Primary navigation model (pure): the same five destinations in the
 * desktop header and the phone tab bar.
 */
export type NavKey = "explore" | "trips" | "hike" | "saved" | "profile";

export interface NavItem {
  key: NavKey;
  href: string;
  label: string;
}

export function primaryNav(signedIn: boolean): NavItem[] {
  return [
    { key: "explore", href: "/explore", label: "Explore" },
    { key: "trips", href: "/trips", label: "Trips" },
    { key: "hike", href: "/hike", label: "Hike" },
    { key: "saved", href: "/saved", label: "Saved" },
    { key: "profile", href: signedIn ? "/account" : "/login", label: "Profile" },
  ];
}

const under = (path: string, base: string) => path === base || path.startsWith(`${base}/`);

/** Which primary destination a path belongs to (null for pages outside the five, e.g. /admin). */
export function activeNavKey(pathname: string | null | undefined): NavKey | null {
  const p = (pathname ?? "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  if (under(p, "/hike") || /^\/trips\/[^/]+\/(hike|help|complete|prepare|checkin)(\/|$)/.test(p)) return "hike";
  if (under(p, "/trips") || under(p, "/bookings") || under(p, "/checkout")) return "trips";
  if (under(p, "/explore") || under(p, "/trail") || under(p, "/trails") || under(p, "/plan")) return "explore";
  if (under(p, "/saved")) return "saved";
  if (under(p, "/account") || under(p, "/login") || under(p, "/signup")) return "profile";
  return null;
}

/** Routes that render as a full-height app (no footer, no page scroll). */
export function isFullscreenRoute(pathname: string | null | undefined): boolean {
  const p = (pathname ?? "").split(/[?#]/)[0].replace(/\/+$/, "");
  return p === "/explore";
}
