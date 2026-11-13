import "server-only";
import { trailPath } from "@/domain/catalog";
import { withAnon, type Tx } from "@/server/db";
import { SLUG_RE } from "./slug";

/**
 * Old trail URLs (public.catalog_trail_redirects, migration
 * 20261112003000_catalog_trail_redirects.sql).
 *
 * A trail's path /trail/<country>/<region>/<slug> is meant to be permanent,
 * but it can change: a trail first stored while reverse geocoding was
 * unavailable gets "unknown" as its region and moves once the region is
 * known; a row whose stored country was wrong (the old 0.1° cell rule) moves
 * to the country at its exact point. Every path a trail leaves is recorded
 * here, pointing at the trail (not at a path, so there are never chains):
 *   - the trail page answers an old path with a permanent redirect (308) to
 *     the trail's current path (findTrailRedirect);
 *   - an old path is never given to another trail (repository.allocateSlug
 *     skips it, and a trigger refuses it), so a shared or indexed link can
 *     never open a different trail;
 *   - a trail may take one of its OWN old paths back; that row is then
 *     dropped because the path is live again (releaseOwnRedirect).
 * Rows go away only with their trail (on delete cascade). Hidden trails
 * keep their rows (the path stays reserved) but are not redirected to.
 */

export interface TrailPathKey {
  countryCode: string;
  regionSlug: string;
  slug: string;
}

const COUNTRY_RE = /^[a-z]{2}$/;

function validKey(k: TrailPathKey): boolean {
  return (
    typeof k?.countryCode === "string" &&
    typeof k.regionSlug === "string" &&
    typeof k.slug === "string" &&
    COUNTRY_RE.test(k.countryCode) &&
    SLUG_RE.test(k.regionSlug) &&
    k.regionSlug.length <= 80 &&
    SLUG_RE.test(k.slug) &&
    k.slug.length <= 120
  );
}

/**
 * Record that `trailId` left the path `from` (in the transaction that moves
 * it). The path was live for this trail until now, so it now redirects to
 * it (replacing any stale row for the same path).
 */
export async function recordTrailRedirect(tx: Tx, from: TrailPathKey, trailId: string): Promise<void> {
  if (!validKey(from)) return;
  await tx`
    insert into public.catalog_trail_redirects (country_code, region_slug, slug, trail_id)
    values (${from.countryCode}, ${from.regionSlug}, ${from.slug}, ${trailId}::uuid)
    on conflict (country_code, region_slug, slug) do update
      set trail_id = excluded.trail_id, created_at = now()`;
}

/** The trail took one of its own old paths back: that path is live again, not a redirect. */
export async function releaseOwnRedirect(tx: Tx, at: TrailPathKey, trailId: string): Promise<void> {
  await tx`
    delete from public.catalog_trail_redirects
     where country_code = ${at.countryCode} and region_slug = ${at.regionSlug} and slug = ${at.slug}
       and trail_id = ${trailId}::uuid`;
}

/**
 * The current path of the visible trail that used to live at
 * (country, region, slug), or null (no such old path, malformed input, or
 * the trail is hidden: public RLS applies). Never throws on bad input.
 */
export async function findTrailRedirect(countryCode: string, regionSlug: string, slug: string): Promise<string | null> {
  const key = { countryCode, regionSlug, slug };
  if (!validKey(key)) return null;
  const [row] = await withAnon(
    (tx) => tx<{ countryCode: string; regionSlug: string; slug: string }[]>`
      select t.country_code, t.region_slug, t.slug
        from public.catalog_trail_redirects r
        join public.catalog_trails t on t.id = r.trail_id
       where r.country_code = ${countryCode} and r.region_slug = ${regionSlug} and r.slug = ${slug}
         and not t.hidden`,
  );
  if (!row) return null;
  const path = trailPath(row);
  // Defensive: never redirect a path to itself.
  return path === trailPath(key) ? null : path;
}
