import "server-only";
import { withUser, type DbUser } from "@/server/db";

/**
 * Saved catalog trails (public.saved_trails), owner-only.
 *
 * Every function runs through withUser, so the saved_trails RLS policies
 * (user_id = auth.uid()) apply: a user can only ever see, add or remove their
 * own rows, whatever id they pass. Writes use auth.uid() rather than the
 * caller-supplied id, so a confused caller cannot save on someone else's
 * behalf.
 *
 * Unknown, malformed and hidden (moderated) trails are "not_found" for
 * saving — the same answer for all three, like the public API's 404. A trail
 * that is hidden AFTER it was saved stays in the list (listSavedTrails) so the
 * /saved page can say "No longer available" and offer to remove it.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Most trails one person can save (the /saved page shows them all). */
export const MAX_SAVED_TRAILS = 500;

export type SaveTrailResult = { ok: true; saved: true; alreadySaved: boolean } | { ok: false; reason: "not_found" | "limit_reached" };

export interface SavedTrailRef {
  trailId: string;
  savedAt: string;
}

const normalizeId = (id: unknown): string | null => (typeof id === "string" && UUID_RE.test(id) ? id.toLowerCase() : null);

/** Save a visible catalog trail for the user. Idempotent: saving twice keeps one row (and its first date). */
export async function saveTrail(user: DbUser, trailId: string): Promise<SaveTrailResult> {
  const id = normalizeId(trailId);
  if (!id) return { ok: false, reason: "not_found" };
  return withUser(user, async (tx) => {
    // RLS on catalog_trails hides hidden trails from `authenticated` too; the explicit filter is defence in depth.
    const [trail] = await tx<{ id: string }[]>`
      select t.id from public.catalog_trails t where t.id = ${id}::uuid and not t.hidden`;
    if (!trail) return { ok: false, reason: "not_found" } as const;

    const [existing] = await tx<{ trailId: string }[]>`
      select s.trail_id from public.saved_trails s where s.user_id = auth.uid() and s.trail_id = ${id}::uuid`;
    if (existing) return { ok: true, saved: true, alreadySaved: true } as const;

    const [{ count }] = await tx<{ count: number }[]>`
      select count(*)::int as count from public.saved_trails s where s.user_id = auth.uid()`;
    if (count >= MAX_SAVED_TRAILS) return { ok: false, reason: "limit_reached" } as const;

    const inserted = await tx<{ trailId: string }[]>`
      insert into public.saved_trails (user_id, trail_id)
      values (auth.uid(), ${id}::uuid)
      on conflict (user_id, trail_id) do nothing
      returning trail_id`;
    // A concurrent save of the same trail wins the race: still saved, once.
    return { ok: true, saved: true, alreadySaved: inserted.length === 0 } as const;
  });
}

/** Remove a saved trail. Idempotent; works for trails that are hidden or gone. Returns whether a row was removed. */
export async function unsaveTrail(user: DbUser, trailId: string): Promise<boolean> {
  const id = normalizeId(trailId);
  if (!id) return false;
  const rows = await withUser(
    user,
    (tx) => tx`
      delete from public.saved_trails s
       where s.user_id = auth.uid() and s.trail_id = ${id}::uuid
      returning s.trail_id`,
  );
  return rows.length > 0;
}

/** Whether the user has saved the trail (true even if the trail was hidden since). */
export async function isTrailSaved(user: DbUser, trailId: string): Promise<boolean> {
  const id = normalizeId(trailId);
  if (!id) return false;
  const rows = await withUser(
    user,
    (tx) => tx`
      select 1 from public.saved_trails s where s.user_id = auth.uid() and s.trail_id = ${id}::uuid`,
  );
  return rows.length > 0;
}

/** The user's saved trails, newest first (ties by trail id), at most MAX_SAVED_TRAILS. */
export async function listSavedTrails(user: DbUser): Promise<SavedTrailRef[]> {
  const rows = await withUser(
    user,
    (tx) => tx<{ trailId: string; createdAt: Date }[]>`
      select s.trail_id, s.created_at
        from public.saved_trails s
       where s.user_id = auth.uid()
       order by s.created_at desc, s.trail_id asc
       limit ${MAX_SAVED_TRAILS}::int`,
  );
  return rows.map((r) => ({ trailId: r.trailId, savedAt: new Date(r.createdAt).toISOString() }));
}

/** Saved trail ids, newest first. */
export async function listSavedTrailIds(user: DbUser): Promise<string[]> {
  return (await listSavedTrails(user)).map((r) => r.trailId);
}
