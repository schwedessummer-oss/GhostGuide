/**
 * `publish [--slug x] [--dry-run]`: evaluate the database publish gate
 * (public.hike_publish_problems) for each hike, print what is missing, and
 * publish the draft or review hikes that pass. The gate itself also runs as a
 * deferred trigger at commit, so a hike can never be published around it.
 */
import type { Sql } from "../lib/db";
import type { Output } from "../lib/output";

export interface PublishResult {
  slug: string;
  status: string;
  problems: string[];
  action: "published" | "would_publish" | "blocked" | "already_published" | "skipped_archived" | "failed";
  error?: string;
}

export async function runPublish(
  sql: Sql,
  out: Output,
  opts: { slug?: string; dryRun?: boolean } = {},
): Promise<PublishResult[]> {
  const hikes = await sql<{ id: string; slug: string; status: string; problems: string[] }[]>`
    select id, slug, status::text as status, public.hike_publish_problems(id) as problems
    from public.hikes
    where ${opts.slug ?? null}::text is null or slug = ${opts.slug ?? null}
    order by seed_no nulls last, slug`;
  if (opts.slug && !hikes.length) throw new Error(`No hike with slug ${opts.slug}`);

  const results: PublishResult[] = [];
  for (const h of hikes) {
    const base = { slug: h.slug, status: h.status, problems: h.problems };
    if (h.status === "archived") {
      results.push({ ...base, action: "skipped_archived" });
    } else if (h.status === "published") {
      results.push({ ...base, action: "already_published" });
    } else if (h.problems.length) {
      results.push({ ...base, action: "blocked" });
    } else if (opts.dryRun) {
      results.push({ ...base, action: "would_publish" });
    } else {
      try {
        await sql.begin(async (tx) => {
          await tx`update public.hikes set status = 'published' where id = ${h.id} and status in ('draft', 'review')`;
        });
        results.push({ ...base, action: "published" });
      } catch (err) {
        results.push({ ...base, action: "failed", error: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  out.line(opts.dryRun ? "Publish gate (dry run: nothing is changed)" : "Publish gate");
  for (const r of results) {
    const label = {
      published: `${r.status} -> published`,
      would_publish: `${r.status}: passes (would publish)`,
      blocked: `${r.status}: blocked`,
      already_published: r.problems.length ? "published, but now fails the gate" : "published",
      skipped_archived: "archived (skipped)",
      failed: `FAILED: ${r.error}`,
    }[r.action];
    out.line(`${r.slug}: ${label}`);
    for (const p of r.problems) out.line(`    missing: ${p}`);
  }
  const count = (a: PublishResult["action"]) => results.filter((r) => r.action === a).length;
  const reasons = new Map<string, number>();
  for (const r of results) if (r.action === "blocked") for (const p of r.problems) reasons.set(p, (reasons.get(p) ?? 0) + 1);
  out.line("");
  out.line(
    `${results.length} hike(s): ${count(opts.dryRun ? "would_publish" : "published")} ${opts.dryRun ? "would be published" : "published"}, ` +
      `${count("blocked")} blocked, ${count("already_published")} already published, ${count("skipped_archived")} archived, ${count("failed")} failed`,
  );
  for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1])) out.line(`  ${n} x ${reason}`);
  return results;
}
