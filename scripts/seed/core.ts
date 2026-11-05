/**
 * Core demo seed: region, sources, DEMONSTRATION trails (fictional, clearly
 * labeled), POIs, approved narration with provenance, permits, closures,
 * add-ons, gear, pricing rules, feature flags, settings and demo users.
 */
import { createHash } from "node:crypto";
import type postgres from "postgres";
import { createClient } from "@supabase/supabase-js";
import { hashPassword } from "../../src/server/auth/password";
import {
  cumulativeDistancesM,
  elevationGainM,
  lineLengthM,
  pointAtDistance,
  validateLineString,
  type Position,
} from "../../src/domain/geo";
import { makeLoop, makeOutAndBack, makePointToPoint } from "./geometry";

export const DEMO_PASSWORD = "ghostguide-demo";
export const DEMO_USERS = [
  { email: "hiker@demo.ghostguide.test", name: "Hana Hiker", roles: [] as string[] },
  { email: "hiker2@demo.ghostguide.test", name: "Ravi Rambler", roles: [] as string[] },
  { email: "admin@demo.ghostguide.test", name: "Ada Admin", roles: ["admin"] },
  { email: "operator@demo.ghostguide.test", name: "Omar Operator", roles: ["operator"] },
  { email: "safety@demo.ghostguide.test", name: "Sam Safety", roles: ["safety"] },
  { email: "editor@demo.ghostguide.test", name: "Eda Editor", roles: ["content_editor"] },
  { email: "support@demo.ghostguide.test", name: "Sue Support", roles: ["support"] },
];

const REGION = {
  slug: "demo-ghost-ridge",
  name: "Ghost Ridge (Demo Region)",
  timezone: "America/Los_Angeles",
  center: { lat: 47.512, lng: -121.684 },
};

interface PoiSeed {
  frac: number;
  name: string;
  kind: string;
  radius?: number;
  narration: { title: string; transcript: string };
}

interface TrailSeed {
  slug: string;
  name: string;
  summary: string;
  description: string;
  difficulty: "easy" | "moderate" | "hard" | "strenuous";
  routeType: "loop" | "out_and_back" | "point_to_point";
  terrain: string[];
  accessibility: string[];
  dogsAllowed: boolean;
  permitRequired: boolean;
  trailhead: { name: string; lat: number; lng: number; parking: string };
  targetKm: number;
  baseEle: number;
  gain: number;
  bearing: number;
  seed: number;
  priceCents: number;
  capacity: number;
  status?: "published" | "draft";
  pois: PoiSeed[];
}

const FICTION = "Demonstration content: this place, route and story are fictional.";

const TRAILS: TrailSeed[] = [
  {
    slug: "lantern-creek-loop",
    name: "Lantern Creek Loop",
    summary: "A gentle, firm-surfaced forest loop along a quiet creek with benches and a step-free start.",
    description:
      "Lantern Creek Loop circles a mossy creek bottom under tall conifers. The path is wide and firm with a gentle grade, benches every few hundred metres and an accessible restroom at the trailhead. " +
      FICTION,
    difficulty: "easy",
    routeType: "loop",
    terrain: ["forest", "river", "gravel"],
    accessibility: ["step_free_start", "firm_surface", "benches", "accessible_restroom", "accessible_parking", "gentle_grade", "shade", "no_exposure", "no_water_crossings"],
    dogsAllowed: true,
    permitRequired: false,
    trailhead: { name: "Lantern Creek Trailhead (demo)", lat: 47.5052, lng: -121.7021, parking: "Paved lot, 2 accessible stalls (fictional)." },
    targetKm: 3.2,
    baseEle: 180,
    gain: 40,
    bearing: 0,
    seed: 1.1,
    priceCents: 1900,
    capacity: 30,
    pois: [
      { frac: 0.02, name: "Lantern Creek Trailhead", kind: "trailhead", narration: { title: "Welcome to Lantern Creek", transcript: "Welcome to the Lantern Creek demonstration loop. This narration is sample content written by Ghost Guide to show how the audio companion works; the place is fictional. Stay on the marked path and enjoy the creek." } },
      { frac: 0.3, name: "Mossy Footbridge", kind: "ecology", narration: { title: "Moss on the footbridge", transcript: "In this fictional forest, the bridge rails are covered with moss because shade and creek spray keep them damp. In real forests, mosses often thrive where moisture stays high and sunlight is limited. Sample narration for demonstration." } },
      { frac: 0.55, name: "Lantern Bench", kind: "history", narration: { title: "The lantern story", transcript: "The demo story says lantern-makers once rested here on their way to market. This is an invented tale used to demonstrate history narration; Ghost Guide only publishes real history from cited sources." } },
      { frac: 0.82, name: "Creek Overlook", kind: "viewpoint", narration: { title: "Creek overlook", transcript: "From this overlook you can watch the creek bend around a gravel bar. Please stay behind the railing. Demonstration narration." } },
    ],
  },
  {
    slug: "hollow-pine-ridge",
    name: "Hollow Pine Ridge",
    summary: "A steady climb through pine forest to an open ridge viewpoint and back the same way.",
    description: "A classic out-and-back: switchbacks through second-growth pines lead to a rocky ridge with wide views. Expect some exposure near the top. " + FICTION,
    difficulty: "moderate",
    routeType: "out_and_back",
    terrain: ["forest", "ridge", "rocky"],
    accessibility: ["accessible_parking"],
    dogsAllowed: true,
    permitRequired: false,
    trailhead: { name: "Hollow Pine Trailhead (demo)", lat: 47.5215, lng: -121.6702, parking: "Gravel lot for ~25 cars (fictional)." },
    targetKm: 7.4,
    baseEle: 260,
    gain: 400,
    bearing: 40,
    seed: 2.3,
    priceCents: 2900,
    capacity: 24,
    pois: [
      { frac: 0.01, name: "Hollow Pine Trailhead", kind: "trailhead", narration: { title: "Before you climb", transcript: "This demonstration trail climbs steadily. Set your own pace, drink water, and remember the turnaround time in your itinerary. Sample narration." } },
      { frac: 0.18, name: "Hollow Pine", kind: "ecology", narration: { title: "The hollow pine", transcript: "This fictional pine was hollowed by an old fire scar but still stands. Fire-scarred trees can provide shelter for birds and small mammals. Demonstration narration." } },
      { frac: 0.35, name: "Switchback Junction", kind: "junction", radius: 35, narration: { title: "Stay on the main trail", transcript: "At this junction keep right on the main trail. The side path is not part of your route. Demonstration narration." } },
      { frac: 0.49, name: "Ridge Viewpoint", kind: "viewpoint", narration: { title: "Ridge viewpoint", transcript: "You've reached the ridge viewpoint, the halfway point of this out-and-back. Rocks near the edge can be loose; enjoy the view from the trail. Demonstration narration." } },
    ],
  },
  {
    slug: "whisper-falls",
    name: "Whisper Falls Trail",
    summary: "River-side trail to a small waterfall, with one shallow seasonal creek crossing.",
    description: "Follows a lively river through alder and fern to a two-tier waterfall. One seasonal crossing may require stepping stones in spring. " + FICTION,
    difficulty: "moderate",
    routeType: "out_and_back",
    terrain: ["river", "forest"],
    accessibility: ["shade"],
    dogsAllowed: false,
    permitRequired: false,
    trailhead: { name: "Whisper Falls Trailhead (demo)", lat: 47.4981, lng: -121.6604, parking: "Roadside pullout (fictional)." },
    targetKm: 5.6,
    baseEle: 210,
    gain: 220,
    bearing: 120,
    seed: 3.7,
    priceCents: 2500,
    capacity: 20,
    pois: [
      { frac: 0.02, name: "Whisper Falls Trailhead", kind: "trailhead", narration: { title: "Welcome to Whisper Falls", transcript: "Welcome to the Whisper Falls demonstration trail. Listen for the river on your right. Sample narration." } },
      { frac: 0.22, name: "Stepping Stones", kind: "safety", radius: 30, narration: { title: "Seasonal crossing", transcript: "Ahead is a seasonal creek crossing. If water is high or fast, do not cross; turn around. This is general guidance, not an assessment of current conditions. Demonstration narration." } },
      { frac: 0.48, name: "Whisper Falls", kind: "water", narration: { title: "Whisper Falls", transcript: "The fictional falls drop in two tiers into a cold pool. Wet rocks are slippery; stay back from the edge. Demonstration narration." } },
    ],
  },
  {
    slug: "echo-basin-traverse",
    name: "Echo Basin Traverse",
    summary: "A long point-to-point traverse past alpine lakes. Permit and shuttle required.",
    description:
      "A full-day traverse over two rocky passes and past a chain of lakes, finishing at a different trailhead. Requires a (fictional) wilderness permit and a shuttle or second car. " +
      FICTION,
    difficulty: "hard",
    routeType: "point_to_point",
    terrain: ["ridge", "rocky", "lake", "meadow"],
    accessibility: [],
    dogsAllowed: false,
    permitRequired: true,
    trailhead: { name: "Echo Basin North Trailhead (demo)", lat: 47.5402, lng: -121.6511, parking: "Small lot; arrive early (fictional)." },
    targetKm: 12.8,
    baseEle: 640,
    gain: 780,
    bearing: 150,
    seed: 4.2,
    priceCents: 4900,
    capacity: 12,
    pois: [
      { frac: 0.01, name: "North Trailhead", kind: "trailhead", narration: { title: "A long day ahead", transcript: "This demonstration traverse is long and remote. Check your permit, your shuttle pickup and your turnaround time before you start. Sample narration." } },
      { frac: 0.27, name: "First Pass", kind: "viewpoint", narration: { title: "First pass", transcript: "You're on the first pass. Weather can change quickly at elevation; if conditions worsen, consider turning back. General guidance, demonstration narration." } },
      { frac: 0.52, name: "Echo Lake", kind: "water", narration: { title: "Echo Lake", transcript: "Echo Lake is the largest lake on this fictional route. Treat any water before drinking. Demonstration narration." } },
      { frac: 0.78, name: "Second Pass", kind: "safety", narration: { title: "Second pass", transcript: "The descent ahead is rocky and steep. Take your time and use poles if you have them. Demonstration narration." } },
    ],
  },
  {
    slug: "miners-meadow-loop",
    name: "Miner's Meadow Loop",
    summary: "Rolling loop through a wildflower meadow with a short history walk.",
    description: "A sunny loop through an open meadow ringed by aspens, passing the (fictional) ruins of a prospector's cabin. Little shade. " + FICTION,
    difficulty: "easy",
    routeType: "loop",
    terrain: ["meadow", "forest", "gravel"],
    accessibility: ["accessible_parking", "gentle_grade", "no_water_crossings", "benches"],
    dogsAllowed: true,
    permitRequired: false,
    trailhead: { name: "Miner's Meadow Trailhead (demo)", lat: 47.5128, lng: -121.7254, parking: "Gravel lot with vault toilet (fictional)." },
    targetKm: 4.6,
    baseEle: 320,
    gain: 90,
    bearing: 0,
    seed: 5.9,
    priceCents: 2100,
    capacity: 30,
    pois: [
      { frac: 0.02, name: "Meadow Gate", kind: "trailhead", narration: { title: "Into the meadow", transcript: "Welcome to the Miner's Meadow demonstration loop. There's little shade ahead; consider sun protection and water. Sample narration." } },
      { frac: 0.4, name: "Cabin Ruins", kind: "history", narration: { title: "The prospector's cabin", transcript: "These stones are part of an invented demonstration story about a prospector's cabin. Real history narration in Ghost Guide always cites an approved source. Please don't climb on structures." } },
      { frac: 0.7, name: "Aspen Grove", kind: "ecology", narration: { title: "Aspen grove", transcript: "Aspens often grow in connected groups from shared roots. This narration is sample content for the demo." } },
    ],
  },
  {
    slug: "old-signal-summit",
    name: "Old Signal Summit",
    summary: "Strenuous summit climb with big elevation gain. Upper section partially closed (demo).",
    description: "A relentless climb to a summit with an old signal tower. The upper switchbacks are under a demonstration partial closure. " + FICTION,
    difficulty: "strenuous",
    routeType: "out_and_back",
    terrain: ["forest", "ridge", "rocky"],
    accessibility: [],
    dogsAllowed: false,
    permitRequired: false,
    trailhead: { name: "Signal Road Trailhead (demo)", lat: 47.4902, lng: -121.6892, parking: "Large lot (fictional)." },
    targetKm: 14.2,
    baseEle: 300,
    gain: 1150,
    bearing: 200,
    seed: 6.4,
    priceCents: 3900,
    capacity: 16,
    pois: [
      { frac: 0.02, name: "Signal Road Trailhead", kind: "trailhead", narration: { title: "A big climb", transcript: "This demonstration summit climb gains a lot of elevation. Check the closure notice and your turnaround time. Sample narration." } },
      { frac: 0.3, name: "Halfway Spring", kind: "water", narration: { title: "Halfway spring", transcript: "A seasonal spring may be flowing here. Treat any water. Demonstration narration." } },
      { frac: 0.49, name: "Signal Tower", kind: "history", narration: { title: "The signal tower", transcript: "The demo story places a fire-lookout signal tower here. Fictional sample narration." } },
    ],
  },
  {
    slug: "cinder-spur-draft",
    name: "Cinder Spur (unpublished draft)",
    summary: "Draft route awaiting validation — not visible to customers.",
    description: "Unpublished demonstration trail used to test content workflows. " + FICTION,
    difficulty: "moderate",
    routeType: "out_and_back",
    terrain: ["rocky"],
    accessibility: [],
    dogsAllowed: false,
    permitRequired: false,
    trailhead: { name: "Cinder Spur Trailhead (demo)", lat: 47.5301, lng: -121.7102, parking: "None (fictional)." },
    targetKm: 6,
    baseEle: 400,
    gain: 300,
    bearing: 300,
    seed: 7.1,
    priceCents: 2500,
    capacity: 10,
    status: "draft",
    pois: [],
  },
];

/** Naismith-style estimate: 4.5 km/h plus 1 hour per 600 m of climbing. */
export function estimateDurationMin(distanceKm: number, gainM: number) {
  return Math.round((distanceKm / 4.5) * 60 + (gainM / 600) * 60);
}

export async function seedCore(sql: postgres.Sql) {
  const existing = await sql`select 1 from public.regions where slug = ${REGION.slug}`;
  if (existing.length) {
    console.log("Core seed already present; skipping.");
    return false;
  }

  // ---- users ---------------------------------------------------------------
  const userIds: Record<string, string> = {};
  if (process.env.AUTH_PROVIDER === "supabase") {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.SUPABASE_SECRET_KEY;
    if (!url || !key) throw new Error("Seeding Supabase Auth users needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY");
    const admin = createClient(url, key, { auth: { persistSession: false } }).auth.admin;
    for (const u of DEMO_USERS) {
      const { data, error } = await admin.createUser({
        email: u.email,
        password: process.env.SEED_DEMO_PASSWORD ?? DEMO_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: u.name },
      });
      if (error && !/already/i.test(error.message)) throw error;
      const id = data?.user?.id ?? (await sql<{ id: string }[]>`select id from auth.users where email = ${u.email}`)[0]?.id;
      userIds[u.email] = id;
    }
  } else {
    const hash = await hashPassword(DEMO_PASSWORD);
    for (const u of DEMO_USERS) {
      const [row] = await sql<{ id: string }[]>`
        insert into auth.users (email, encrypted_password, raw_user_meta_data)
        values (${u.email}, ${hash}, ${sql.json({ full_name: u.name })})
        returning id`;
      userIds[u.email] = row.id;
    }
  }
  for (const u of DEMO_USERS) {
    await sql`update public.profiles set full_name = ${u.name} where id = ${userIds[u.email]}`;
    for (const role of u.roles) {
      await sql`insert into public.staff_roles (user_id, role) values (${userIds[u.email]}, ${role}) on conflict do nothing`;
    }
  }
  const adminId = userIds["admin@demo.ghostguide.test"];
  const editorId = userIds["editor@demo.ghostguide.test"];

  // emergency contact for the demo hiker (consent attested by the hiker)
  await sql`
    insert into public.emergency_contacts (user_id, name, phone, email, relationship, consent_confirmed_at, consent_statement)
    values (${userIds["hiker@demo.ghostguide.test"]}, 'Casey Contact (demo)', '+15555550123', 'casey@demo.ghostguide.test', 'Friend',
            now(), 'I confirm this person agreed to receive Ghost Guide check-in notices about my trips.')`;

  // ---- region & sources ----------------------------------------------------
  const [region] = await sql<{ id: string }[]>`
    insert into public.regions (slug, name, timezone, center_lat, center_lng, default_zoom, is_active, is_demo, emergency_number, emergency_guidance)
    values (${REGION.slug}, ${REGION.name}, ${REGION.timezone}, ${REGION.center.lat}, ${REGION.center.lng}, 12, true, true, '911',
      ${"In an emergency call 911. Mobile coverage is unreliable on parts of these (fictional) trails; if you carry a satellite communicator, use its SOS function. Ghost Guide cannot contact emergency services for you."})
    returning id`;

  const [demoSource] = await sql<{ id: string }[]>`
    insert into public.sources (label, url, publisher, source_type, retrieved_at, notes)
    values ('Ghost Guide demonstration content (fictional)', null, 'Ghost Guide', 'demo', now(),
            'All demo-region trails, routes, facts and stories are invented for product demonstration. Not for navigation.')
    returning id`;
  const [surveySource] = await sql<{ id: string }[]>`
    insert into public.sources (label, url, publisher, source_type, retrieved_at, notes)
    values ('Simulated field survey (demo)', null, 'Ghost Guide operations', 'demo', now() - interval '20 days',
            'Simulated survey record used to demonstrate provenance and freshness labels.')
    returning id`;
  const [permitSource] = await sql<{ id: string }[]>`
    insert into public.sources (label, url, publisher, source_type, retrieved_at, notes)
    values ('Demo permit authority page (placeholder)', 'https://example.org/demo-permits/echo-basin', 'Fictional Land Agency', 'demo', now() - interval '3 days',
            'Placeholder link on a reserved example domain. Replace with the real land manager page for real trails.')
    returning id`;

  // ---- trails ---------------------------------------------------------------
  for (const t of TRAILS) {
    const th = { lat: t.trailhead.lat, lng: t.trailhead.lng };
    const coords: Position[] =
      t.routeType === "loop"
        ? makeLoop(th, t.targetKm, t.baseEle, t.gain, t.seed)
        : t.routeType === "out_and_back"
          ? makeOutAndBack(th, t.targetKm, t.bearing, t.baseEle, t.gain, t.seed)
          : makePointToPoint(th, t.targetKm, t.bearing, t.baseEle, t.gain, t.seed);
    const geometry = { type: "LineString" as const, coordinates: coords };
    const lengthKm = Math.round((lineLengthM(coords) / 1000) * 100) / 100;
    const gain = Math.round(elevationGainM(coords) ?? t.gain);
    const v = validateLineString(geometry, { declaredDistanceKm: lengthKm });
    if (!v.valid) throw new Error(`Seed geometry for ${t.slug} invalid: ${v.errors.join("; ")}`);
    const checksum = createHash("sha256").update(JSON.stringify(geometry)).digest("hex");
    const maxEle = Math.round(Math.max(...coords.map((c) => (c[2] as number) ?? 0)));
    const published = (t.status ?? "published") === "published";

    const [trail] = await sql<{ id: string }[]>`
      insert into public.trails (
        region_id, slug, name, summary, description, is_demo, status, distance_km, elevation_gain_m, max_elevation_m,
        difficulty, terrain, route_type, estimated_duration_min, accessibility_features, dogs_allowed, permit_required,
        trailhead_name, trailhead_lat, trailhead_lng, parking_info, base_price_cents, currency, daily_capacity,
        geometry, geometry_source_id, geometry_checksum, geometry_validated_at, geometry_validated_by, facts_verified_at)
      values (
        ${region.id}, ${t.slug}, ${t.name}, ${t.summary}, ${t.description}, true, ${t.status ?? "published"}, ${lengthKm}, ${gain}, ${maxEle},
        ${t.difficulty}, ${t.terrain}::text[], ${t.routeType}, ${estimateDurationMin(lengthKm, gain)}, ${t.accessibility}::text[],
        ${t.dogsAllowed}, ${t.permitRequired}, ${t.trailhead.name}, ${t.trailhead.lat}, ${t.trailhead.lng}, ${t.trailhead.parking},
        ${t.priceCents}, 'usd', ${t.capacity}, ${sql.json(geometry as unknown as postgres.JSONValue)}, ${demoSource.id}, ${checksum},
        ${published ? new Date() : null}::timestamptz, ${published ? adminId : null}, now() - interval '20 days')
      returning id`;

    await sql`insert into public.trail_sources (trail_id, source_id) values (${trail.id}, ${demoSource.id}), (${trail.id}, ${surveySource.id})`;

    const provenance: [string, string, string, string][] = [
      ["distance_km", "demo", demoSource.id, "Computed from the demonstration route geometry."],
      ["elevation_gain_m", "demo", demoSource.id, "Computed from synthetic elevation in the demonstration geometry."],
      ["difficulty", "operator_note", surveySource.id, "Operator rating (demo)."],
      ["terrain", "demo", surveySource.id, "Simulated field survey."],
      ["accessibility_features", "demo", surveySource.id, "Simulated field survey; verify on site for real trails."],
      ["estimated_duration_min", "estimate", demoSource.id, "Estimate: 4.5 km/h plus 1 h per 600 m climbing. Not a guarantee."],
      ["dogs_allowed", "demo", demoSource.id, "Fictional rule."],
      ["permit_required", "demo", t.permitRequired ? permitSource.id : demoSource.id, "Fictional rule."],
      ["geometry", "demo", demoSource.id, "Synthetic route generated for demonstration. Not for navigation."],
    ];
    for (const [field, kind, sourceId, note] of provenance) {
      await sql`
        insert into public.trail_field_provenance (trail_id, field, kind, source_id, verified_at, verified_by, note)
        values (${trail.id}, ${field}, ${kind}, ${sourceId}, now() - interval '20 days', ${adminId}, ${note})`;
    }

    const cum = cumulativeDistancesM(coords);
    const total = cum[cum.length - 1];
    for (const [i, p] of t.pois.entries()) {
      const at = pointAtDistance(coords, total * p.frac, cum);
      const [poi] = await sql<{ id: string }[]>`
        insert into public.trail_pois (trail_id, seq, name, kind, lat, lng, trigger_radius_m)
        values (${trail.id}, ${i + 1}, ${p.name}, ${p.kind}, ${at.lat}, ${at.lng}, ${p.radius ?? 40})
        returning id`;
      await sql`
        insert into public.narrations (trail_id, poi_id, title, transcript, duration_sec, status, source_id, source_citation,
                                       submitted_by, approved_by, approved_at)
        values (${trail.id}, ${poi.id}, ${p.narration.title}, ${p.narration.transcript},
                ${Math.round(p.narration.transcript.split(/\s+/).length / 2.5)}, 'approved', ${demoSource.id},
                'Ghost Guide demonstration content (fictional)', ${editorId}, ${adminId}, now() - interval '10 days')`;
    }
    if (t.slug === "lantern-creek-loop") {
      // one draft narration awaiting review, to demonstrate the approval queue
      await sql`
        insert into public.narrations (trail_id, title, transcript, status, submitted_by, source_citation)
        values (${trail.id}, 'Creek insects (draft)', 'Draft narration about creek insects awaiting a cited source and review. Demonstration content.',
                'in_review', ${editorId}, null)`;
    }
    if (t.permitRequired) {
      await sql`
        insert into public.permit_requirements (trail_id, name, authority, official_url, requirement_summary, how_to_obtain, lead_time_days, source_id, verified_at)
        values (${trail.id}, 'Echo Basin day-use permit (fictional)', 'Fictional Land Agency',
                'https://example.org/demo-permits/echo-basin',
                'A day-use permit is required for each person (demonstration rule).',
                'Apply on the land manager''s official site. Ghost Guide does not buy permits for you and never automates permit queues.',
                7, ${permitSource.id}, now() - interval '3 days')`;
    }
    if (t.slug === "old-signal-summit") {
      await sql`
        insert into public.trail_closures (trail_id, severity, reason, source_id, starts_at, ends_at, created_by)
        values (${trail.id}, 'partial', 'Upper switchbacks closed for (fictional) trail maintenance. Turn around at the Signal Tower.',
                ${surveySource.id}, now() - interval '2 days', now() + interval '30 days', ${adminId})`;
    }
  }

  // ---- add-ons, gear, pricing ---------------------------------------------
  await sql`
    insert into public.addons (code, name, description, kind, provider_key, price_cents, pricing_unit, requires_customer_confirmation, daily_capacity, region_id)
    values
      ('gear-poles-pack', 'Trailhead gear locker kit', 'Trekking poles and a daypack waiting in a trailhead locker. Access code issued after booking (simulated partner).', 'gear_locker', 'demo', 1200, 'per_person', false, 10, ${region.id}),
      ('shuttle-trailhead', 'Trailhead shuttle', 'Pickup or return shuttle. You confirm the pickup location, price and time before any ride is requested (simulated partner).', 'shuttle', 'demo', 3500, 'per_booking', true, 6, ${region.id}),
      ('meal-pack', 'Trail meal pack', 'Lunch and snacks packed for the trail, collected at the gear locker (simulated partner).', 'meal_pack', 'demo', 1800, 'per_person', false, 20, ${region.id}),
      ('sat-communicator', 'Satellite communicator rental', 'Rent a two-way satellite messenger from the locker. Ghost Guide does not provide SOS service; the device''s own service applies (simulated partner).', 'satellite_device', 'demo', 2500, 'per_booking', false, 3, ${region.id})`;

  const [locker] = await sql<{ id: string }[]>`
    insert into public.gear_lockers (region_id, name, location_description, lat, lng, status, provider_key)
    values (${region.id}, 'Lantern Creek Locker Bank (demo)', 'Beside the restroom at Lantern Creek Trailhead (fictional)', 47.5051, -121.7019, 'online', 'demo')
    returning id`;
  const items: [string, string, number][] = [
    ["trekking_poles", "Trekking poles", 8],
    ["daypack", "Daypack", 6],
    ["satellite_communicator", "Satellite communicator", 3],
    ["first_aid_kit", "First aid kit", 4],
  ];
  for (const [kind, label, count] of items) {
    for (let i = 1; i <= count; i++) {
      await sql`insert into public.gear_items (locker_id, region_id, kind, label, status, last_maintenance_at)
                values (${locker.id}, ${region.id}, ${kind}, ${`${label} #${i}`}, ${i === count && kind === "daypack" ? "maintenance" : "available"}, now() - interval '14 days')`;
    }
  }

  await sql`
    insert into public.pricing_rules (name, kind, value, params, region_id, priority, created_by)
    values
      ('Weekend surcharge', 'weekend_pct', 15, '{}'::jsonb, ${region.id}, 10, ${adminId}),
      ('Holiday surcharge', 'holiday_pct', 20, ${sql.json({ dates: ["2026-11-26", "2026-12-25", "2027-01-01"] })}, ${region.id}, 20, ${adminId}),
      ('High-demand surcharge', 'high_demand_pct', 10, '{"threshold": 0.75}'::jsonb, ${region.id}, 30, ${adminId}),
      ('Group discount (4+)', 'group_discount_pct', -10, '{"minParty": 4}'::jsonb, ${region.id}, 40, ${adminId})`;

  // ---- flags & settings -----------------------------------------------------
  const flags: [string, boolean, string][] = [
    ["checkout_enabled", true, "Allow customers to start checkout"],
    ["ai_explanations", true, "Use the AI provider for itinerary explanations (falls back to templates)"],
    ["addon_gear_locker", true, "Offer gear-locker add-on"],
    ["addon_shuttle", true, "Offer shuttle add-on"],
    ["addon_meal_pack", true, "Offer meal-pack add-on"],
    ["addon_satellite_device", true, "Offer satellite-communicator rental add-on"],
    ["trip_sharing", true, "Allow customers to create expiring trip-share links"],
    ["checkins_enabled", true, "Allow customers to opt in to trip check-ins"],
    ["marketing_drafts", true, "Enable the marketing-draft workflow in admin"],
  ];
  for (const [key, enabled, description] of flags) {
    await sql`insert into public.feature_flags (key, enabled, description) values (${key}, ${enabled}, ${description})`;
  }
  const settings: [string, unknown, string][] = [
    ["checkin_defaults", { graceMinutes: 60, reminderOffsetsMin: [60, 15] }, "Default check-in grace period and reminder offsets"],
    ["checkout_hold_minutes", 30, "Minutes a pending checkout holds inventory"],
    ["cancellation_policy", { fullRefundHours: 48, partialRefundPct: 50, partialRefundHours: 12 }, "Customer cancellation refund policy"],
    ["location_retention_default_days", 30, "Default days to keep precise hike location history"],
    ["stale_location_minutes", 15, "A last-known location older than this is labeled stale"],
  ];
  for (const [key, value, description] of settings) {
    await sql`insert into public.app_settings (key, value, description) values (${key}, ${sql.json(value as postgres.JSONValue)}, ${description})`;
  }

  console.log(`Seeded region, ${TRAILS.length} demonstration trails, add-ons, gear, pricing, flags and ${DEMO_USERS.length} demo users.`);
  return true;
}
