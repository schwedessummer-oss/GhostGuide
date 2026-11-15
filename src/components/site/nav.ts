/**
 * Site navigation model (pure): the links the header shows. While the hike
 * catalog is being rebuilt the public site is the home page plus accounts,
 * so the header carries only account links (and Admin for staff).
 */
export interface NavLink {
  href: string;
  label: string;
}

/** Header links for a visitor; Sign in / Sign out are rendered separately. */
export function siteNav({ signedIn, canAdmin }: { signedIn: boolean; canAdmin: boolean }): NavLink[] {
  if (!signedIn) return [];
  return [{ href: "/account", label: "Account" }, ...(canAdmin ? [{ href: "/admin", label: "Admin" }] : [])];
}

/** Whether `pathname` is the page a link points to, or a page below it. */
export function isCurrentPath(pathname: string | null | undefined, href: string): boolean {
  const p = (pathname ?? "").split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  return p === href || (href !== "/" && p.startsWith(`${href}/`));
}
