import { afterAll, describe, expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";

vi.mock("@/server/checkins/service", () => ({
  onHikeStarted: vi.fn(async () => {}),
  onCheckinConfirmedFromDevice: vi.fn(async () => {}),
  onTripFinished: vi.fn(async () => {}),
}));

import { closeDb, sql, withSystem } from "@/server/db";
import { getTripBundle } from "@/server/hike/bundle";
import { recordDownload, submitFeedback, updatePermitStatus } from "@/server/hike/records";
import { startHike, finishHike } from "@/server/hike/sessions";
import { getCompletionView, getHikeOverview, getPrepareView } from "@/server/hike/queries";
import { validateLineString } from "@/domain/geo";
import { createCustomer, trailBySlug } from "../../helpers/db";
import { createTrip } from "./helpers";

afterAll(closeDb);

describe("offline trip bundle", () => {
  it("is owner-only (404) and limited to booked/active/completed trips (409)", async () => {
    const owner = await createCustomer("bundle-owner");
    const other = await createCustomer("bundle-other");
    const booked = await createTrip(owner, "booked");
    expect(await getTripBundle(other, booked)).toMatchObject({ ok: false, status: 404 });
    expect(await getTripBundle(other, randomUUID())).toMatchObject({ ok: false, status: 404 });
    expect(await getTripBundle(owner, await createTrip(owner, "saved"))).toMatchObject({ ok: false, status: 409 });
    expect(await getTripBundle(owner, await createTrip(owner, "cancelled"))).toMatchObject({ ok: false, status: 409 });
    expect((await getTripBundle(owner, booked)).ok).toBe(true);
  });

  it("includes approved narration only, a verifiable geometry checksum and a manifest", async () => {
    const owner = await createCustomer("bundle-content");
    const tripId = await createTrip(owner, "booked", "lantern-creek-loop");
    const trail = await trailBySlug("lantern-creek-loop");
    // extra draft + retired narration (the core seed already has an in_review one)
    await withSystem(
      (tx) => tx`
        insert into public.narrations (trail_id, title, transcript, status) values
          (${trail.id}, 'Unreviewed draft', 'not for customers', 'draft'),
          (${trail.id}, 'Old retired story', 'not for customers', 'retired')`,
    );
    const r = await getTripBundle(owner, tripId);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const b = r.value;
    const statuses = await sql()<{ id: string; status: string }[]>`select id, status from public.narrations where trail_id = ${trail.id}`;
    const approvedIds = statuses.filter((n) => n.status === "approved").map((n) => n.id).sort();
    expect(b.narrations.map((n) => n.id).sort()).toEqual(approvedIds);
    expect(b.narrations.some((n) => /draft|retired|insects/i.test(n.title))).toBe(false);
    expect(b.narrations.every((n) => n.sourceCitation && n.transcript)).toBe(true);
    expect(b.narrations.every((n) => n.tts === (n.audioUrl === null))).toBe(true);

    // checksum = sha256 of the exact geometryJson string, and it parses to a valid LineString
    expect(b.geometryChecksum).toBe(createHash("sha256").update(b.geometryJson).digest("hex"));
    expect(validateLineString(JSON.parse(b.geometryJson)).valid).toBe(true);

    expect(b.trail).toMatchObject({ slug: "lantern-creek-loop", isDemo: true });
    expect(b.trail.provenanceSummary).toMatch(/Demonstration/);
    expect(b.region.emergencyNumber).toBe("911");
    expect(b.pois.length).toBeGreaterThan(0);
    expect(b.trip).toMatchObject({ id: tripId, status: "booked", partySize: 2 });
    expect(b.session).toBeNull();
    expect(b.settings.staleLocationMinutes).toBe(15);
    const keys = b.manifest.items.map((i) => i.key);
    expect(keys).toEqual(expect.arrayContaining(["page:hike", "page:help", "data:bundle", "data:geometry"]));
    expect(b.manifest.items.find((i) => i.key === "data:geometry")?.sha256).toBe(b.geometryChecksum);
    expect(b.manifest.items.find((i) => i.key === "page:hike")?.url).toBe(`/trips/${tripId}/hike`);
  });

  it("signs audio URLs for approved narration with a recording and lists them in the manifest", async () => {
    const owner = await createCustomer("bundle-audio");
    const tripId = await createTrip(owner, "booked", "whisper-falls");
    const trail = await trailBySlug("whisper-falls");
    const [n] = await withSystem(
      (tx) => tx<{ id: string }[]>`
        insert into public.narrations (trail_id, title, transcript, audio_path, status, source_id, source_citation, approved_at)
        select ${trail.id}, 'Recorded story', 'Recorded transcript', 'narration/test/recorded.mp3', 'approved', id, 'Demo', now()
        from public.sources limit 1
        returning id`,
    );
    const r = await getTripBundle(owner, tripId);
    if (!r.ok) throw new Error(r.error);
    const rec = r.value.narrations.find((x) => x.id === n.id)!;
    expect(rec.tts).toBe(false);
    expect(rec.audioUrl).toMatch(/^\/api\/media\/narration\/test\/recorded\.mp3\?exp=\d+&sig=[A-Za-z0-9_-]+$/);
    expect(r.value.manifest.items).toContainEqual(expect.objectContaining({ key: `audio:${n.id}`, kind: "audio", url: rec.audioUrl }));
  });

  it("includes the open session so another device can resume", async () => {
    const owner = await createCustomer("bundle-session");
    const tripId = await createTrip(owner, "booked");
    const s = await startHike(owner, { tripId });
    const r = await getTripBundle(owner, tripId);
    expect(r.ok && r.value.session?.id).toBe(s.ok ? s.value.session.id : "x");
    expect(r.ok && r.value.trip.status).toBe("active");
  });
});

describe("downloads, feedback, permits and read models", () => {
  it("records verified downloads for owned trips only", async () => {
    const owner = await createCustomer("dl");
    const other = await createCustomer("dl-other");
    const tripId = await createTrip(owner, "booked");
    const input = { manifestVersion: 1, manifestChecksum: "a".repeat(64), itemCount: 12, verifiedComplete: true };
    expect(await recordDownload(other, tripId, input)).toMatchObject({ ok: false, status: 404 });
    expect((await recordDownload(owner, tripId, input)).ok).toBe(true);
    const overview = await getHikeOverview(owner, tripId);
    expect(overview?.lastDownload).toMatchObject({ verifiedComplete: true, itemCount: 12 });
    expect(await getHikeOverview(other, tripId)).toBeNull();
  });

  it("accepts feedback only after the hike is finished and summarizes the hike", async () => {
    const owner = await createCustomer("fb");
    const tripId = await createTrip(owner, "booked");
    const fb = { rating: 5, comments: "Lovely", issues: ["battery"] };
    expect(await submitFeedback(owner, tripId, fb)).toMatchObject({ ok: false, status: 409 });
    await startHike(owner, { tripId });
    await finishHike(owner, { tripId, distanceCompletedM: 3000 });
    expect((await submitFeedback(owner, tripId, fb)).ok).toBe(true);
    expect((await submitFeedback(owner, tripId, { ...fb, rating: 4 })).ok).toBe(true); // edit
    const [row] = await sql()`select rating, issues from public.trip_feedback where trip_id = ${tripId}`;
    expect(row).toMatchObject({ rating: 4, issues: ["battery"] });
    const view = await getCompletionView(owner, tripId);
    expect(view?.summary?.distanceM).toBe(3000);
    expect(view?.feedback?.rating).toBe(4);
  });

  it("tracks permit status for the trip's own permit requirements", async () => {
    const owner = await createCustomer("permit");
    const tripId = await createTrip(owner, "booked", "echo-basin-traverse");
    const prep = await getPrepareView(owner, tripId);
    expect(prep?.permits).toHaveLength(1);
    expect(prep?.permits[0]).toMatchObject({ status: "not_started", officialUrl: expect.stringMatching(/^https:\/\//) });
    const reqId = prep!.permits[0].requirementId;
    expect((await updatePermitStatus(owner, tripId, { permitRequirementId: reqId, status: "obtained", confirmationRef: "ABC-1" })).ok).toBe(true);
    expect((await getPrepareView(owner, tripId))?.permits[0]).toMatchObject({ status: "obtained", confirmationRef: "ABC-1" });
    // a requirement from another trail is not accepted
    const other = await createTrip(owner, "booked", "lantern-creek-loop");
    expect(await updatePermitStatus(owner, other, { permitRequirementId: reqId, status: "obtained", confirmationRef: null })).toMatchObject({
      ok: false,
      status: 404,
    });
  });
});
