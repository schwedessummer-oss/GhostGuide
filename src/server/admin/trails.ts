import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import type { Closure, FieldProvenance, Source, Trail } from "@/domain/types";
import type { Tx } from "@/server/db";
import { activeClosures } from "@/server/catalog/trails";
import { getLaunchRegion } from "@/server/catalog/trails";
import {
  assertCan,
  auditInStaffTx,
  fail,
  guarded,
  isUuid,
  isoDate,
  likePattern,
  notBlank,
  ok,
  optionalText,
  requiredText,
  staffTx,
  zodFail,
  type ActionResult,
} from "./common";
import { DIFFICULTIES, FACT_FIELDS, FACT_KINDS, ROUTE_TYPES, isFactField, parseFactValue } from "./trail-fields";

export interface AdminTrail extends Trail {
  regionName: string;
  regionTimezone: string;
  geometrySourceId: string | null;
  createdAt: Date;
}

export interface AdminTrailListRow {
  id: string;
  slug: string;
  name: string;
  status: Trail["status"];
  isDemo: boolean;
  difficulty: string;
  distanceKm: number;
  geometryValidatedAt: Date | null;
  hasGeometry: boolean;
  sourceCount: number;
  activeClosureCount: number;
  closedNow: boolean;
  pendingNarrations: number;
  updatedAt: Date;
}

const STATUSES = ["draft", "published", "closed", "archived"] as const;

export async function listAdminTrails(user: SessionUser, filters: { status?: string; q?: string } = {}): Promise<AdminTrailListRow[]> {
  assertCan(user, "trails.manage");
  const status = z.enum(STATUSES).safeParse(filters.status).data ?? null;
  const q = filters.q?.trim().slice(0, 100) || null;
  return staffTx(user, (tx) => tx<AdminTrailListRow[]>`
    select t.id, t.slug, t.name, t.status, t.is_demo, t.difficulty, t.distance_km, t.geometry_validated_at,
           (t.geometry is not null) as has_geometry,
           (select count(*)::int from public.trail_sources ts where ts.trail_id = t.id) as source_count,
           (select count(*)::int from public.trail_closures c where c.trail_id = t.id and c.starts_at <= now()
              and (c.ends_at is null or c.ends_at > now())) as active_closure_count,
           exists (select 1 from public.trail_closures c where c.trail_id = t.id and c.severity = 'closed' and c.starts_at <= now()
              and (c.ends_at is null or c.ends_at > now())) as closed_now,
           (select count(*)::int from public.narrations n where n.trail_id = t.id and n.status in ('draft', 'in_review')) as pending_narrations,
           t.updated_at
    from public.trails t
    where (${status}::public.trail_status is null or t.status = ${status}::public.trail_status)
      and (${q}::text is null or t.name ilike ${likePattern(q ?? "")})
    order by t.status = 'archived', t.name`);
}

const TRAIL_SELECT = (tx: Tx) => tx`
  t.id, t.region_id, t.slug, t.name, t.summary, t.description, t.is_demo, t.status, t.distance_km, t.elevation_gain_m,
  t.max_elevation_m, t.difficulty, t.terrain, t.route_type, t.estimated_duration_min, t.accessibility_features, t.dogs_allowed,
  t.permit_required, t.trailhead_name, t.trailhead_lat, t.trailhead_lng, t.parking_info, t.hero_image_url, t.base_price_cents,
  t.currency, t.daily_capacity, t.geometry, t.geometry_checksum, t.geometry_validated_at, t.geometry_source_id, t.facts_verified_at,
  t.created_at, t.updated_at, r.name as region_name, r.timezone as region_timezone`;

export async function getAdminTrail(user: SessionUser, trailId: string): Promise<AdminTrail | null> {
  assertCan(user, "trails.manage");
  if (!isUuid(trailId)) return null;
  const [t] = await staffTx(user, (tx) => tx<AdminTrail[]>`
    select ${TRAIL_SELECT(tx)} from public.trails t join public.regions r on r.id = t.region_id where t.id = ${trailId}`);
  return t ?? null;
}

export interface TrailFactsView {
  provenance: (FieldProvenance & { sourceLabel: string | null; verifiedBy: string | null })[];
  linkedSources: Source[];
  allSources: Source[];
  activeClosures: Closure[];
}

export async function getTrailFactsView(user: SessionUser, trailId: string): Promise<TrailFactsView> {
  assertCan(user, "trails.manage");
  return staffTx(user, async (tx) => {
    const [provenance, linkedSources, allSources, closures] = await Promise.all([
      tx<TrailFactsView["provenance"]>`
        select p.field, p.kind, p.source_id, p.verified_at, p.note, p.verified_by, s.label as source_label
        from public.trail_field_provenance p left join public.sources s on s.id = p.source_id
        where p.trail_id = ${trailId} order by p.field`,
      tx<Source[]>`
        select s.id, s.label, s.url, s.publisher, s.source_type, s.retrieved_at, s.notes
        from public.sources s join public.trail_sources ts on ts.source_id = s.id where ts.trail_id = ${trailId} order by s.label`,
      tx<Source[]>`select id, label, url, publisher, source_type, retrieved_at, notes from public.sources order by label`,
      activeClosures(tx, [trailId]),
    ]);
    return { provenance, linkedSources, allSources, activeClosures: closures };
  });
}

// ---------------------------------------------------------------------------
// Create / basics
// ---------------------------------------------------------------------------
const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "trail";

const createSchema = z.object({
  name: requiredText(3, 120, "Name"),
  summary: z.string().trim().max(400).default(""),
  description: z.string().trim().max(8000).default(""),
  distanceKm: notBlank(z.coerce.number("Enter the distance in km.").min(0.1, "Distance must be at least 0.1 km").max(500), "Enter the distance in km."),
  elevationGainM: notBlank(z.coerce.number("Enter the elevation gain in metres.").int().min(0).max(10000), "Enter the elevation gain in metres."),
  difficulty: z.enum(DIFFICULTIES),
  routeType: z.enum(ROUTE_TYPES),
  estimatedDurationMin: notBlank(z.coerce.number("Enter the typical time in minutes.").int().min(1).max(4320), "Enter the typical time in minutes."),
  trailheadName: optionalText(200),
  trailheadLat: notBlank(z.coerce.number("Enter the trailhead latitude.").min(-90).max(90), "Enter the trailhead latitude."),
  trailheadLng: notBlank(z.coerce.number("Enter the trailhead longitude.").min(-180).max(180), "Enter the trailhead longitude."),
  basePriceCents: notBlank(z.coerce.number("Enter the base price.").int().min(0).max(1_000_000), "Enter the base price."),
  dailyCapacity: notBlank(z.coerce.number("Enter the daily capacity.").int().min(0).max(1000), "Enter the daily capacity."),
  isDemo: z.boolean(),
});

export type CreateTrailInput = z.input<typeof createSchema>;

export async function createTrail(user: SessionUser, input: CreateTrailInput): Promise<ActionResult<{ id: string }>> {
  assertCan(user, "trails.manage");
  const p = createSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const d = p.data;
  const region = await getLaunchRegion();
  return guarded(() =>
    staffTx(user, async (tx) => {
      const base = slugify(d.name);
      const taken = await tx<{ slug: string }[]>`select slug from public.trails where slug = ${base} or slug like ${base + "-%"}`;
      let slug = base;
      for (let i = 2; taken.some((r) => r.slug === slug); i++) slug = `${base}-${i}`;
      const [row] = await tx<{ id: string }[]>`
        insert into public.trails (region_id, slug, name, summary, description, is_demo, status, distance_km, elevation_gain_m, difficulty,
          route_type, estimated_duration_min, trailhead_name, trailhead_lat, trailhead_lng, base_price_cents, daily_capacity)
        values (${region.id}, ${slug}, ${d.name}, ${d.summary}, ${d.description}, ${d.isDemo}, 'draft', ${d.distanceKm}, ${d.elevationGainM},
          ${d.difficulty}, ${d.routeType}, ${d.estimatedDurationMin}, ${d.trailheadName}, ${d.trailheadLat}, ${d.trailheadLng},
          ${d.basePriceCents}, ${d.dailyCapacity})
        returning id`;
      await auditInStaffTx(tx, user, "trail.created", "trail", row.id, { slug, isDemo: d.isDemo });
      return ok("Draft trail created. Add sources, a validated route and facts before publishing.", { data: { id: row.id } });
    }),
  );
}

const basicsSchema = z.object({
  name: requiredText(3, 120, "Name"),
  summary: z.string().trim().max(400),
  description: z.string().trim().max(8000),
  trailheadName: optionalText(200),
  dailyCapacity: notBlank(z.coerce.number("Enter the daily capacity.").int().min(0).max(1000), "Enter the daily capacity."),
});

export async function updateTrailBasics(user: SessionUser, trailId: string, input: z.input<typeof basicsSchema>): Promise<ActionResult> {
  assertCan(user, "trails.manage");
  if (!isUuid(trailId)) return fail("Trail not found.");
  const p = basicsSchema.safeParse(input);
  if (!p.success) return zodFail(p.error);
  const d = p.data;
  return guarded(() =>
    staffTx(user, async (tx) => {
      const rows = await tx`
        update public.trails set name = ${d.name}, summary = ${d.summary}, description = ${d.description},
          trailhead_name = ${d.trailheadName}, daily_capacity = ${d.dailyCapacity}
        where id = ${trailId} returning id`;
      if (!rows.length) return fail("Trail not found.");
      await auditInStaffTx(tx, user, "trail.basics_updated", "trail", trailId, { fields: ["name", "summary", "description", "trailheadName", "dailyCapacity"] });
      return ok("Trail details saved.");
    }),
  );
}

// ---------------------------------------------------------------------------
// Facts with per-field provenance
// ---------------------------------------------------------------------------
const provenanceSchema = z
  .object({
    kind: z.enum(FACT_KINDS),
    sourceId: z.union([z.uuid(), z.literal("")]).transform((v) => (v === "" ? null : v)),
    verifiedAt: z.union([isoDate, z.literal("")]).transform((v) => (v === "" ? null : v)),
    note: optionalText(500),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "verified" && !v.sourceId) ctx.addIssue({ code: "custom", path: ["sourceId"], message: "A verified fact needs a source." });
    if (v.kind === "verified" && !v.verifiedAt) ctx.addIssue({ code: "custom", path: ["verifiedAt"], message: "A verified fact needs a verification date." });
    if (v.verifiedAt && v.verifiedAt > new Date().toISOString().slice(0, 10)) {
      ctx.addIssue({ code: "custom", path: ["verifiedAt"], message: "The verification date cannot be in the future." });
    }
  });

export interface UpdateFactInput {
  field: string;
  value?: unknown;
  values?: unknown;
  lat?: unknown;
  lng?: unknown;
  kind: unknown;
  sourceId?: unknown;
  verifiedAt?: unknown;
  note?: unknown;
}

/** Save one fact's value AND its provenance (kind, source, verified date) together. */
export async function updateTrailFact(user: SessionUser, trailId: string, input: UpdateFactInput): Promise<ActionResult> {
  assertCan(user, "trails.manage");
  if (!isUuid(trailId)) return fail("Trail not found.");
  if (!isFactField(input.field)) return fail("Unknown fact field.");
  const field = input.field;
  const value = parseFactValue(field, input);
  if (!value.ok) return fail(value.error);
  const prov = provenanceSchema.safeParse({ kind: input.kind, sourceId: input.sourceId ?? "", verifiedAt: input.verifiedAt ?? "", note: input.note ?? "" });
  if (!prov.success) return zodFail(prov.error);
  const pv = prov.data;

  return guarded(() =>
    staffTx(user, async (tx) => {
      const [current] = await tx<Record<string, unknown>[]>`select * from public.trails where id = ${trailId} for update`;
      if (!current) return fail("Trail not found.");
      if (pv.sourceId) {
        const [s] = await tx`select 1 from public.sources where id = ${pv.sourceId}`;
        if (!s) return fail("Source not found.");
      }
      const before: Record<string, unknown> = {};
      for (const [column, v] of Object.entries(value.value)) {
        before[column] = current[column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())];
        if (column === "terrain" || column === "accessibility_features") {
          await tx`update public.trails set ${tx(column)} = ${v as string[]}::text[] where id = ${trailId}`;
        } else {
          await tx`update public.trails set ${tx(column)} = ${v as string | number | boolean | null} where id = ${trailId}`;
        }
      }
      await tx`
        insert into public.trail_field_provenance (trail_id, field, kind, source_id, verified_at, verified_by, note)
        values (${trailId}, ${field}, ${pv.kind}, ${pv.sourceId}, ${pv.verifiedAt ? `${pv.verifiedAt}T12:00:00Z` : null}::timestamptz, ${user.id}, ${pv.note})
        on conflict (trail_id, field) do update set kind = excluded.kind, source_id = excluded.source_id,
          verified_at = excluded.verified_at, verified_by = excluded.verified_by, note = excluded.note`;
      await tx`
        update public.trails set facts_verified_at = (
          select max(verified_at) from public.trail_field_provenance where trail_id = ${trailId} and kind = 'verified')
        where id = ${trailId}`;
      await auditInStaffTx(tx, user, "trail.fact_updated", "trail", trailId, {
        field,
        kind: pv.kind,
        sourceId: pv.sourceId,
        before: field === "trailhead_location" ? "[redacted]" : before,
        after: field === "trailhead_location" ? "[redacted]" : value.value,
      });
      return ok(`${FACT_FIELDS[field].label} saved with provenance (${pv.kind.replace("_", " ")}).`);
    }),
  );
}

// ---------------------------------------------------------------------------
// Publish / unpublish / archive
// ---------------------------------------------------------------------------
export interface PublishReadiness {
  ready: boolean;
  problems: string[];
}

export async function publishReadiness(tx: Tx, trailId: string): Promise<PublishReadiness> {
  const [t] = await tx<{ geometry: unknown; geometryValidatedAt: Date | null; geometryChecksum: string | null; sources: number }[]>`
    select geometry, geometry_validated_at, geometry_checksum,
           (select count(*)::int from public.trail_sources ts where ts.trail_id = t.id) as sources
    from public.trails t where t.id = ${trailId}`;
  if (!t) return { ready: false, problems: ["Trail not found."] };
  const problems: string[] = [];
  if (!t.geometry || !t.geometryValidatedAt || !t.geometryChecksum) problems.push("Activate a validated route file (GeoJSON or GPX) first.");
  if (t.sources < 1) problems.push("Link at least one source to the trail.");
  return { ready: problems.length === 0, problems };
}

export async function getPublishReadiness(user: SessionUser, trailId: string): Promise<PublishReadiness> {
  assertCan(user, "trails.manage");
  return staffTx(user, (tx) => publishReadiness(tx, trailId));
}

export async function setTrailStatus(user: SessionUser, trailId: string, target: "published" | "draft" | "archived"): Promise<ActionResult> {
  assertCan(user, "trails.manage");
  if (!isUuid(trailId)) return fail("Trail not found.");
  if (!["published", "draft", "archived"].includes(target)) return fail("Unsupported status.");
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [t] = await tx<{ status: string; isDemo: boolean; slug: string }[]>`select status, is_demo, slug from public.trails where id = ${trailId} for update`;
      if (!t) return fail("Trail not found.");
      if (t.status === target) return ok(`Trail is already ${target}.`);
      if (target === "published") {
        const r = await publishReadiness(tx, trailId);
        if (!r.ready) return fail(`Cannot publish yet: ${r.problems.join(" ")}`);
      }
      await tx`update public.trails set status = ${target} where id = ${trailId}`;
      const action = target === "published" ? "trail.published" : target === "archived" ? "trail.archived" : "trail.unpublished";
      await auditInStaffTx(tx, user, action, "trail", trailId, { from: t.status, to: target, isDemo: t.isDemo, slug: t.slug });
      return ok(
        target === "published"
          ? `Published.${t.isDemo ? " It stays labeled as a demonstration trail." : ""}`
          : target === "archived"
            ? "Archived; customers can no longer see it."
            : "Unpublished; customers can no longer see or book it.",
      );
    }),
  );
}
