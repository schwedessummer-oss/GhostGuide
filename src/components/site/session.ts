import { useEffect, useSyncExternalStore } from "react";
import { usePathname } from "next/navigation";

/**
 * Who is signed in, for the site chrome only (header links, tab bar, Admin).
 *
 * The root layout must not read cookies or headers: that would make every
 * page render per request, including the trail pages that are meant to be
 * cached for an hour (ISR) and shared by every visitor. So the server HTML
 * of the chrome is the same for everyone (the signed-out links), and the
 * browser asks GET /api/session (never cached) once it has hydrated.
 *
 * Until that answer arrives, the readable `gg_owner` device hint (set at
 * sign-in, deleted at sign-out; see src/server/auth/owner-hint.ts) is the
 * guess: present → signed in. The Admin link waits for the answer. After a
 * client-side navigation (sign-in ends with one) or when the tab comes back,
 * the session is asked for again only if the hint changed since the last
 * answer, so ordinary navigation costs no request.
 *
 * Never use this for authorization: pages, actions and APIs check the
 * session themselves.
 */
export interface SessionView {
  /** "pending": not confirmed by the server yet (signedIn is the hint's guess). */
  status: "pending" | "known";
  signedIn: boolean;
  canAdmin: boolean;
}

/** Keep in sync with OWNER_HINT_COOKIE in src/server/auth/owner-hint.ts (that module is server-only). */
export const OWNER_HINT_COOKIE = "gg_owner";
export const SESSION_ENDPOINT = "/api/session";

const HINT_RE = /^[A-Za-z0-9_-]{8,128}$/;

/** The device sign-in hint in a Cookie header / document.cookie string, or null. */
export function hintFromCookie(cookie: string | null | undefined): string | null {
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== OWNER_HINT_COOKIE) continue;
    let v = part.slice(i + 1).trim();
    try {
      v = decodeURIComponent(v);
    } catch {
      return null;
    }
    return HINT_RE.test(v) ? v : null;
  }
  return null;
}

/** The body of GET /api/session, or null when it is not one. Admin only ever with a session. */
export function parseSessionResponse(json: unknown): { signedIn: boolean; canAdmin: boolean } | null {
  if (!json || typeof json !== "object") return null;
  const o = json as Record<string, unknown>;
  if (typeof o.signedIn !== "boolean") return null;
  return { signedIn: o.signedIn, canAdmin: o.signedIn && o.canAdmin === true };
}

/** What the server renders (and hydration uses): signed out, unconfirmed. */
export const SERVER_SESSION: SessionView = Object.freeze({ status: "pending", signedIn: false, canAdmin: false });

let view: SessionView | null = null;
/** The hint the last request was made for; undefined = ask on the next check. */
let askedForHint: string | null | undefined;
let controller: AbortController | null = null;
const listeners = new Set<() => void>();

function readHint(): string | null {
  try {
    return hintFromCookie(document.cookie);
  } catch {
    return null;
  }
}

function setView(next: SessionView) {
  const cur = view;
  if (cur && cur.status === next.status && cur.signedIn === next.signedIn && cur.canAdmin === next.canAdmin) return;
  view = next;
  for (const l of listeners) l();
}

/** The current client view (the hint's guess before the first answer). */
export function getSessionView(): SessionView {
  if (!view) view = { status: "pending", signedIn: readHint() !== null, canAdmin: false };
  return view;
}

/**
 * Ask the server who is signed in, unless this device's sign-in hint is the
 * same as when it last asked (`force` asks anyway). Failures keep the guess
 * and ask again on the next check.
 */
export function refreshSession(force = false): void {
  if (typeof window === "undefined") return;
  const hint = readHint();
  if (!force && askedForHint !== undefined && hint === askedForHint) return;
  askedForHint = hint;
  // Signed in or out on this device since the last answer: go by the hint until the new one arrives.
  if (getSessionView().signedIn !== (hint !== null)) setView({ status: "pending", signedIn: hint !== null, canAdmin: false });
  controller?.abort();
  const ctrl = new AbortController();
  controller = ctrl;
  fetch(SESSION_ENDPOINT, { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" }, signal: ctrl.signal })
    .then(async (res) => {
      const parsed = res.ok ? parseSessionResponse(await res.json()) : null;
      if (ctrl.signal.aborted) return;
      if (!parsed) throw new Error(`session ${res.status}`);
      setView({ status: "known", ...parsed });
    })
    .catch(() => {
      if (ctrl.signal.aborted) return;
      askedForHint = undefined;
    })
    .finally(() => {
      if (controller === ctrl) controller = null;
    });
}

function onVisible() {
  if (document.visibilityState === "visible") refreshSession();
}
function onPageShow(e: PageTransitionEvent) {
  // Restored from the back/forward cache: the page may predate a sign-in or sign-out.
  if (e.persisted) refreshSession(true);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
  }
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
    }
  };
}

/** The visitor's session for the site chrome (see the module comment). */
export function useSession(): SessionView {
  const pathname = usePathname();
  const session = useSyncExternalStore(subscribe, getSessionView, () => SERVER_SESSION);
  useEffect(() => {
    refreshSession();
  }, [pathname]);
  return session;
}
