/**
 * `report`: write ingest/reports/coverage.md, one row per hike showing which
 * key fields are filled, its status and how many source records back it.
 * Read from the database, so it shows what the site can actually use.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Sql } from "../lib/db";
import type { Output } from "../lib/output";

interface CoverageRow {
  seed_no: number | null;
  slug: string;
  name: string;
  status: string;
  distance: "official" | "osm" | null;
  gain: "official" | "osm" | null;
  duration: boolean;
  best_months: boolean;
  permit: boolean;
  fees: boolean;
  rules: number;
  parking: boolean;
  transport: boolean;
  photos: number;
  route: boolean;
  wikivoyage: boolean;
  sources: number;
}

const COLUMNS: Array<[string, (r: CoverageRow) => string, (rows: CoverageRow[]) => string]> = [
  ["Distance", (r) => (r.distance === "official" ? "Y" : r.distance === "osm" ? "osm" : "-"), (rs) => String(rs.filter((r) => r.distance).length)],
  ["Gain", (r) => (r.gain === "official" ? "Y" : r.gain === "osm" ? "osm" : "-"), (rs) => String(rs.filter((r) => r.gain).length)],
  ["Duration", (r) => yes(r.duration), (rs) => String(rs.filter((r) => r.duration).length)],
  ["Best months", (r) => yes(r.best_months), (rs) => String(rs.filter((r) => r.best_months).length)],
  ["Permit", (r) => yes(r.permit), (rs) => String(rs.filter((r) => r.permit).length)],
  ["Fees", (r) => yes(r.fees), (rs) => String(rs.filter((r) => r.fees).length)],
  ["Rules", (r) => (r.rules ? String(r.rules) : "-"), (rs) => String(rs.filter((r) => r.rules).length)],
  ["Parking", (r) => yes(r.parking), (rs) => String(rs.filter((r) => r.parking).length)],
  ["Transport", (r) => yes(r.transport), (rs) => String(rs.filter((r) => r.transport).length)],
  ["Photos", (r) => (r.photos ? String(r.photos) : "-"), (rs) => String(rs.filter((r) => r.photos).length)],
  ["Route", (r) => yes(r.route), (rs) => String(rs.filter((r) => r.route).length)],
  ["Wikivoyage", (r) => yes(r.wikivoyage), (rs) => String(rs.filter((r) => r.wikivoyage).length)],
];

function yes(b: boolean): string {
  return b ? "Y" : "-";
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

export async function coverageRows(sql: Sql): Promise<CoverageRow[]> {
  return sql<CoverageRow[]>`
    with primary_metrics as (
      select hr.hike_id, m.length_m, m.gain_m
      from public.hike_routes hr join osm.route_metrics m on m.route_id = hr.osm_route_id
      where hr.is_primary
    ),
    hike_sources as (
      select hike_id, source_record_id from public.hike_facts where superseded_at is null
      union select hike_id, source_record_id from public.fees where hike_id is not null
      union select hike_id, source_record_id from public.hike_rules
      union select hike_id, source_record_id from public.hike_hazards
      union select hike_id, source_record_id from public.hike_stages
      union select hp.hike_id, p.source_record_id from public.hike_permits hp join public.permits p on p.id = hp.permit_id
      union select h.id, a.source_record_id from public.hikes h join public.areas a on a.id = h.area_id
      union select h.id, g.source_record_id from public.hikes h join public.agencies g on g.id = h.agency_id
      union select hike_id, source_record_id from osm.points where hike_id is not null
      union select r.hike_id, unnest(r.built_from) from osm.routes r where r.hike_id is not null
      union select pl.hike_id, ph.source_record_id from public.photo_links pl join public.photos ph on ph.id = pl.photo_id
        where pl.hike_id is not null and ph.source_record_id is not null
      union select t.hike_id, t.source_record_id from public.area_texts t where t.hike_id is not null and t.source_record_id is not null
    )
    select h.seed_no, h.slug, h.name, h.status::text as status,
      case when h.distance_km is not null then 'official'
           when exists (select 1 from primary_metrics m where m.hike_id = h.id) then 'osm' end as distance,
      case when h.elevation_gain_m is not null then 'official'
           when exists (select 1 from primary_metrics m where m.hike_id = h.id and m.gain_m is not null) then 'osm' end as gain,
      (h.duration_min_minutes is not null or h.duration_max_minutes is not null
        or h.duration_min_days is not null or h.duration_max_days is not null) as duration,
      h.best_months is not null as best_months,
      (h.permit_required is not null or exists (select 1 from public.hike_permits hp where hp.hike_id = h.id)) as permit,
      (exists (select 1 from public.fees f where f.hike_id = h.id)
        or exists (select 1 from public.fees f join public.hike_permits hp on hp.permit_id = f.permit_id where hp.hike_id = h.id)
        or exists (select 1 from public.hike_facts x where x.hike_id = h.id and x.field = 'entry_fee_none'
                   and x.superseded_at is null and x.verified)) as fees,
      (select count(*)::int from public.hike_rules r where r.hike_id = h.id) as rules,
      h.parking is not null as parking,
      h.public_transport is not null as transport,
      (select count(*)::int from public.photo_links pl join public.photos ph on ph.id = pl.photo_id
        where pl.hike_id = h.id and ph.status = 'published') as photos,
      exists (select 1 from public.hike_routes hr where hr.hike_id = h.id and hr.is_primary) as route,
      exists (select 1 from public.area_texts t where t.source = 'wikivoyage'
              and (t.hike_id = h.id or (h.area_id is not null and t.area_id = h.area_id))) as wikivoyage,
      (select count(distinct s.source_record_id)::int from hike_sources s where s.hike_id = h.id) as sources
    from public.hikes h
    order by h.seed_no nulls last, h.slug`;
}

export function renderCoverage(rows: CoverageRow[], sourceTotals: Array<{ key: string; n: number }>, today: string): string {
  const lines: string[] = [];
  lines.push("# Data coverage");
  lines.push("");
  lines.push(`Generated by \`npm run ingest -- report\` on ${today} from the database the loader wrote to.`);
  lines.push("");
  lines.push("Legend: **Y** = filled from an official or open source with a source record; **osm** = only an OSM-derived");
  lines.push("value (shown with ODbL credit); **-** = empty (the site shows \"Check the official site\"); numbers are counts.");
  lines.push("**Sources** = distinct source records behind the hike's facts, typed rows, area, agency, route and photos.");
  lines.push("");
  if (!rows.length) {
    lines.push("No hikes loaded yet.");
    return `${lines.join("\n")}\n`;
  }
  const header = ["#", "Hike", "Status", ...COLUMNS.map(([h]) => h), "Sources"];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map((h, i) => (i === 0 || i >= 3 ? "---:" : "---")).join("|")}|`);
  for (const r of rows) {
    lines.push(`| ${[r.seed_no ?? "", `${cell(r.name)} (\`${r.slug}\`)`, r.status, ...COLUMNS.map(([, f]) => f(r)), r.sources].join(" | ")} |`);
  }
  lines.push(`| | **Total (${rows.length} hikes)** | | ${COLUMNS.map(([, , t]) => `**${t(rows)}**`).join(" | ")} | |`);
  lines.push("");
  const statuses = new Map<string, number>();
  for (const r of rows) statuses.set(r.status, (statuses.get(r.status) ?? 0) + 1);
  lines.push("## Totals");
  lines.push("");
  lines.push(`- Hikes: ${rows.length} (${[...statuses].map(([s, n]) => `${n} ${s}`).join(", ")})`);
  for (const [h, , t] of COLUMNS) lines.push(`- ${h}: ${t(rows)} of ${rows.length}`);
  lines.push(`- Source records stored, by data source: ${sourceTotals.length ? sourceTotals.map((s) => `${s.key} ${s.n}`).join(", ") : "none"}`);
  return `${lines.join("\n")}\n`;
}

export async function runReport(sql: Sql, out: Output, opts: { file: string; today?: string }): Promise<CoverageRow[]> {
  const rows = await coverageRows(sql);
  const sourceTotals = await sql<{ key: string; n: number }[]>`
    select ds.key, count(*)::int as n from public.source_records sr join public.data_sources ds on ds.id = sr.data_source_id
    group by ds.key order by ds.key`;
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  await mkdir(path.dirname(opts.file), { recursive: true });
  await writeFile(opts.file, renderCoverage(rows, sourceTotals, today));
  out.line(`Wrote ${opts.file} (${rows.length} hikes)`);
  return rows;
}
