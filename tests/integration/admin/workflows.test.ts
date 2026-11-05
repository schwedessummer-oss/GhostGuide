import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { closeDb, sql, withSystem } from "@/server/db";
import { parsePage } from "@/server/admin/common";
import { setFlag } from "@/server/admin/feature-flags";
import { deletePricingRule, savePricingRule, updateTrailBasePrice } from "@/server/admin/pricing";
import { grantStaffRole, revokeStaffRole } from "@/server/admin/staff";
import { cancelJobAsStaff, retryJobAsStaff } from "@/server/admin/jobs";
import { approveNarration, createNarration, editNarration, getNarration, rejectNarration } from "@/server/admin/content";
import { createClosure, endClosure } from "@/server/admin/closures";
import { setDayInventory, getAvailability } from "@/server/admin/availability";
import {
  approveMarketingDraft,
  generateMarketingDraft,
  getMarketingDraft,
  publishMarketingDraft,
  submitMarketingDraft,
  updateMarketingDraft,
} from "@/server/admin/marketing";
import { listUpcomingTripPermits, permitReminderDedupKey, updateTripPermit } from "@/server/admin/permits";
import { opsHandlers } from "@/server/jobs/handlers/ops";
import { enqueueJob, runDueJobs } from "@/server/jobs/queue";
import { activeClosures, isTrailAvailable } from "@/server/catalog/trails";
import { listAuditLogs } from "@/server/admin/audit-log";
import { createDemoWeatherProvider } from "@/integrations/weather/demo";
import { localDateInZone } from "@/lib/time";
import { demoUser, trailBySlug } from "../../helpers/db";
import { expectOk } from "./helpers";

afterAll(closeDb);

async function lastAudit(action: string, entityId?: string) {
  const rows = await sql()<{ action: string; actorId: string; actorRoles: string[]; entityId: string; metadata: Record<string, unknown> }[]>`
    select action, actor_id, actor_roles, entity_id, metadata from public.audit_logs
    where action = ${action} and (${entityId ?? null}::text is null or entity_id = ${entityId ?? null}::text)
    order by id desc limit 1`;
  return rows[0];
}

const rule = (over: Record<string, unknown> = {}) => ({
  name: "Test weekday fee",
  kind: "flat_fee" as const,
  value: "250",
  threshold: "",
  minParty: "",
  dates: "",
  scope: "global" as const,
  regionId: "",
  trailId: "",
  priority: "90",
  effectiveFrom: "",
  effectiveTo: "",
  active: false,
  ...over,
});

describe("audit entries for sensitive actions", () => {
  it("records flag, pricing, role and job-retry changes with the actor", async () => {
    const admin = await demoUser("admin");
    const operator = await demoUser("operator");

    expectOk(await setFlag(admin, "trip_sharing", false));
    const flag = await lastAudit("flag.toggled", "trip_sharing");
    expect(flag).toMatchObject({ actorId: admin.id, metadata: { from: true, to: false } });
    expect(flag.actorRoles).toContain("admin");
    expectOk(await setFlag(admin, "trip_sharing", true));

    const created = await savePricingRule(admin, null, rule());
    expectOk(created);
    expect((await lastAudit("pricing.rule_created", created.data!.id)).actorId).toBe(admin.id);
    expectOk(await savePricingRule(admin, created.data!.id, rule({ value: "300" })));
    expect((await lastAudit("pricing.rule_updated", created.data!.id)).metadata).toMatchObject({ after: { value: 300 } });
    expectOk(await deletePricingRule(admin, created.data!.id));
    expect(await lastAudit("pricing.rule_deleted", created.data!.id)).toBeDefined();
    const trail = await trailBySlug("whisper-falls");
    expectOk(await updateTrailBasePrice(admin, trail.id, "26.50"));
    expect((await lastAudit("pricing.base_price_updated", trail.id)).metadata).toMatchObject({ to: 2650 });

    // invalid pricing input is rejected by validation
    const bad = await savePricingRule(admin, null, rule({ kind: "high_demand_pct", value: "10", threshold: "" }));
    expect(bad.ok).toBe(false);

    expectOk(await grantStaffRole(admin, { email: "support@demo.ghostguide.test", role: "content_editor" }));
    const support = await demoUser("support");
    expect((await lastAudit("staff.role_granted", support.id)).metadata).toMatchObject({ role: "content_editor" });
    expectOk(await revokeStaffRole(admin, support.id, "content_editor"));
    expect((await lastAudit("staff.role_revoked", support.id)).metadata).toMatchObject({ role: "content_editor" });

    const kind = `test.audit.${randomUUID().slice(0, 6)}`;
    const { id } = await enqueueJob(null, kind, {}, { maxAttempts: 1 });
    await runDueJobs({ [kind]: async () => { throw new Error("boom"); } }, { kinds: [kind] });
    const [dead] = await sql()<{ status: string }[]>`select status from public.jobs where id = ${id}`;
    expect(dead.status).toBe("dead");
    expectOk(await retryJobAsStaff(operator, id));
    const [requeued] = await sql()<{ status: string }[]>`select status from public.jobs where id = ${id}`;
    expect(requeued.status).toBe("queued");
    expect(await lastAudit("job.retried", String(id))).toMatchObject({ actorId: operator.id, metadata: { kind, from: "dead" } });
    // a queued job cannot be "retried", but can be cancelled (audited)
    expect((await retryJobAsStaff(operator, id)).ok).toBe(false);
    expectOk(await cancelJobAsStaff(operator, id));
    expect((await lastAudit("job.cancelled", String(id))).actorId).toBe(operator.id);

    // admins can read the audit log through the viewer (RLS)
    const page = await listAuditLogs(admin, { action: "job." }, parsePage());
    expect(page.rows.some((r) => r.entityId === String(id))).toBe(true);
  });

  it("the seeded dead job can be retried from the queue", async () => {
    const admin = await demoUser("admin");
    const [job] = await sql()<{ id: number }[]>`select id from public.jobs where dedup_key = 'seed:admin:dead-job-example'`;
    expectOk(await retryJobAsStaff(admin, job.id));
    const s = await runDueJobs(opsHandlers, { kinds: ["ops.purge_rate_limits"] });
    expect(s.succeeded).toBeGreaterThanOrEqual(1);
    const [after] = await sql()<{ status: string }[]>`select status from public.jobs where id = ${job.id}`;
    expect(after.status).toBe("succeeded");
  });
});

describe("narration review", () => {
  it("approval requires a source and citation (and the DB enforces the source)", async () => {
    const editor = await demoUser("editor");
    const admin = await demoUser("admin");
    const trail = await trailBySlug("lantern-creek-loop");
    const created = await createNarration(editor, trail.id, { title: "Creek stones", transcript: "<b>Imported</b> text about creek stones, demo.", poiId: "", sourceId: "", sourceCitation: "", submit: true });
    expectOk(created);
    const id = created.data!.id;

    const noSource = await approveNarration(admin, id, { sourceId: "", sourceCitation: "Some citation" });
    expect(noSource.ok).toBe(false);
    const noCitation = await approveNarration(admin, id, { sourceId: randomUUID(), sourceCitation: "" });
    expect(noCitation.ok).toBe(false);
    // DB check: approved without a source is impossible even for trusted code
    await expect(withSystem((tx) => tx`update public.narrations set status = 'approved', approved_at = now() where id = ${id}`)).rejects.toThrow(/narration_approved_needs_source/);

    const [src] = await sql()<{ id: string }[]>`select id from public.sources order by created_at limit 1`;
    expectOk(await approveNarration(admin, id, { sourceId: src.id, sourceCitation: "Demo source, p. 1" }));
    const [n] = await sql()<{ status: string; approvedBy: string; sourceId: string }[]>`select status, approved_by, source_id from public.narrations where id = ${id}`;
    expect(n).toMatchObject({ status: "approved", approvedBy: admin.id, sourceId: src.id });
    expect((await lastAudit("narration.approved", id)).actorId).toBe(admin.id);
  });

  it("editing approved narration creates a new version; approving it retires the old one", async () => {
    const editor = await demoUser("editor");
    const trail = await trailBySlug("lantern-creek-loop");
    const [orig] = await sql()<{ id: string; version: number; sourceId: string; title: string; transcript: string }[]>`
      select id, version, source_id, title, transcript from public.narrations where trail_id = ${trail.id} and status = 'approved' order by created_at limit 1`;
    const edit = await editNarration(editor, orig.id, { title: orig.title, transcript: `${orig.transcript} (revised)`, poiId: "", sourceId: orig.sourceId, sourceCitation: "Demo" });
    expectOk(edit);
    const revId = edit.data!.id;
    expect(revId).not.toBe(orig.id);
    const [rev] = await sql()<{ status: string; version: number; supersedesId: string }[]>`select status, version, supersedes_id from public.narrations where id = ${revId}`;
    expect(rev).toMatchObject({ status: "in_review", version: orig.version + 1, supersedesId: orig.id });
    // the original stays approved while the revision is under review
    let [o] = await sql()<{ status: string }[]>`select status from public.narrations where id = ${orig.id}`;
    expect(o.status).toBe("approved");
    // a second concurrent revision is refused
    expect((await editNarration(editor, orig.id, { title: orig.title, transcript: `${orig.transcript} again`, poiId: "", sourceId: "", sourceCitation: "" })).ok).toBe(false);

    const view = await getNarration(editor, revId);
    expect(view?.versions.map((v) => v.id)).toEqual(expect.arrayContaining([orig.id, revId]));

    expectOk(await approveNarration(editor, revId, { sourceId: orig.sourceId, sourceCitation: "Demo" }));
    [o] = await sql()<{ status: string }[]>`select status from public.narrations where id = ${orig.id}`;
    expect(o.status).toBe("retired");
  });

  it("rejection needs a reason; operators can view but not edit narration", async () => {
    const editor = await demoUser("editor");
    const operator = await demoUser("operator");
    const trail = await trailBySlug("whisper-falls");
    const created = await createNarration(editor, trail.id, { title: "Ferns", transcript: "Ferns like shade (demo narration).", poiId: "", sourceId: "", sourceCitation: "" });
    expectOk(created);
    expect((await rejectNarration(editor, created.data!.id, "")).ok).toBe(false);
    expectOk(await rejectNarration(editor, created.data!.id, "Needs a cited source"));
    const [n] = await sql()<{ status: string; reviewNote: string }[]>`select status, review_note from public.narrations where id = ${created.data!.id}`;
    expect(n).toMatchObject({ status: "rejected", reviewNote: "Needs a cited source" });
    expect((await editNarration(operator, created.data!.id, { title: "Ferns", transcript: "Changed by operator text", poiId: "", sourceId: "", sourceCitation: "" })).ok).toBe(false);
  });
});

describe("closures and inventory", () => {
  it("a 'closed' closure makes the trail unavailable immediately; ending it restores availability", async () => {
    const operator = await demoUser("operator");
    const trail = await trailBySlug("hollow-pine-ridge");
    const load = async () => {
      const [t] = await sql()<{ status: "published"; geometry: unknown; geometryValidatedAt: Date }[]>`
        select status, geometry, geometry_validated_at from public.trails where id = ${trail.id}`;
      const closures = await withSystem((tx) => activeClosures(tx, [trail.id]));
      return isTrailAvailable(t as never, closures);
    };
    expect(await load()).toBe(true);
    const c = await createClosure(operator, trail.id, { severity: "closed", reason: "Bridge out (test)", sourceId: "", startsAt: "", endsAt: "" });
    expectOk(c);
    expect(await load()).toBe(false);
    expect((await lastAudit("closure.created", trail.id)).metadata).toMatchObject({ closureId: c.data!.id, severity: "closed" });
    expectOk(await endClosure(operator, c.data!.id));
    expect(await load()).toBe(true);
  });

  it("closure end must be after start; advisory closures keep the trail available", async () => {
    const editor = await demoUser("editor");
    const trail = await trailBySlug("miners-meadow-loop");
    const bad = await createClosure(editor, trail.id, { severity: "closed", reason: "Bad window test", sourceId: "", startsAt: "2030-01-02T10:00", endsAt: "2030-01-01T10:00" });
    expect(bad.ok).toBe(false);
    const adv = await createClosure(editor, trail.id, { severity: "advisory", reason: "Muddy (test advisory)", sourceId: "", startsAt: "", endsAt: "" });
    expectOk(adv);
    const closures = await withSystem((tx) => activeClosures(tx, [trail.id]));
    expect(isTrailAvailable({ status: "published", geometry: { type: "LineString", coordinates: [] }, geometryValidatedAt: new Date() }, closures)).toBe(true);
    expectOk(await endClosure(editor, adv.data!.id));
  });

  it("blocking a day requires a note and is audited", async () => {
    const operator = await demoUser("operator");
    const trail = await trailBySlug("whisper-falls");
    const avail = await getAvailability(operator, trail.id);
    expect(avail?.rows).toHaveLength(30);
    const day = avail!.rows[5].day;
    expect((await setDayInventory(operator, trail.id, { day, capacity: "", blocked: true, note: "" })).ok).toBe(false);
    expectOk(await setDayInventory(operator, trail.id, { day, capacity: "5", blocked: true, note: "Trail crew day (test)" }));
    const after = await getAvailability(operator, trail.id);
    expect(after!.rows[5]).toMatchObject({ blocked: true, capacity: 5, remaining: 0 });
    expect((await lastAudit("inventory.day_blocked", trail.id)).metadata).toMatchObject({ day });
    expectOk(await setDayInventory(operator, trail.id, { day, capacity: "", blocked: false, note: "" }));
  });
});

describe("marketing drafts", () => {
  it("cannot be published before approval; edits after approval send it back to review", async () => {
    const editor = await demoUser("editor");
    const operator = await demoUser("operator");
    const trail = await trailBySlug("lantern-creek-loop");
    const now = new Date();
    const gen = await generateMarketingDraft(editor, { trailId: trail.id, channel: "newsletter" }, { provider: createDemoWeatherProvider({ now: () => now }), now });
    expectOk(gen);
    const id = gen.data!.id;
    const view = await getMarketingDraft(editor, id);
    expect(view?.draft.status).toBe("draft");
    expect(view?.weather?.isSimulated).toBe(true);
    expect(view?.draft.body).toMatch(/SIMULATED/);
    expect(view?.draft.sources.length).toBeGreaterThan(0);
    expect(view?.warnings.join(" ")).toMatch(/SIMULATED|simulated/);

    // editors cannot approve or publish; nobody can publish an unapproved draft
    await expect(publishMarketingDraft(editor, id)).rejects.toThrow();
    const early = await publishMarketingDraft(operator, id);
    expect(early.ok).toBe(false);
    await expect(withSystem((tx) => tx`update public.marketing_drafts set status = 'published' where id = ${id}`)).rejects.toThrow(/marketing_publish_requires_approval/);

    expectOk(await submitMarketingDraft(editor, id));
    expect((await approveMarketingDraft(operator, id, false)).ok).toBe(false); // warnings must be acknowledged
    expectOk(await approveMarketingDraft(operator, id, true));

    expectOk(await updateMarketingDraft(editor, id, { title: "Edited title", body: view!.draft.body + "\nEdited." }));
    let [d] = await sql()<{ status: string; approvedAt: Date | null }[]>`select status, approved_at from public.marketing_drafts where id = ${id}`;
    expect(d).toMatchObject({ status: "in_review", approvedAt: null });
    expect((await publishMarketingDraft(operator, id)).ok).toBe(false);

    expectOk(await approveMarketingDraft(operator, id, true));
    expectOk(await publishMarketingDraft(operator, id));
    [d] = await sql()<{ status: string; approvedAt: Date | null }[]>`select status, approved_at from public.marketing_drafts where id = ${id}`;
    expect(d.status).toBe("published");
    expect((await lastAudit("marketing.draft_published", id)).actorId).toBe(operator.id);
    const [snap] = await sql()<{ n: number }[]>`select count(*)::int as n from public.integration_events where provider_kind = 'weather' and outcome = 'simulated'`;
    expect(snap.n).toBeGreaterThan(0);
  });

  it("respects the marketing_drafts feature flag", async () => {
    const admin = await demoUser("admin");
    const trail = await trailBySlug("lantern-creek-loop");
    expectOk(await setFlag(admin, "marketing_drafts", false));
    try {
      const r = await generateMarketingDraft(admin, { trailId: trail.id, channel: "web" });
      expect(r.ok).toBe(false);
    } finally {
      expectOk(await setFlag(admin, "marketing_drafts", true));
    }
  });
});

describe("permits", () => {
  it("staff update trip permit status; reminders are created once per trip/permit/day", async () => {
    const operator = await demoUser("operator");
    const editor = await demoUser("editor");
    const rows = await listUpcomingTripPermits(operator);
    const seeded = rows.find((r) => r.trailName === "Echo Basin Traverse" && r.status === "applied");
    expect(seeded).toBeDefined();
    // content editors manage requirements, not customers' trip permits
    expect(await listUpcomingTripPermits(editor)).toEqual([]);
    expect((await updateTripPermit(editor, seeded!.tripId, seeded!.permitRequirementId, { status: "obtained" })).ok).toBe(false);

    await sql()`update public.jobs set run_at = now() where kind = 'permits.remind' and status = 'queued'`;
    const s1 = await runDueJobs(opsHandlers, { kinds: ["permits.remind"] });
    expect(s1.claimed).toBeGreaterThanOrEqual(1);
    const today = localDateInZone(new Date(), "America/Los_Angeles");
    const key = permitReminderDedupKey(seeded!.tripId, seeded!.permitRequirementId, today);
    const [n] = await sql()<{ channel: string; recipientKind: string; status: string; body: string }[]>`
      select channel, recipient_kind, status, body from public.notifications where dedup_key = ${key}`;
    expect(n).toMatchObject({ channel: "in_app", recipientKind: "user", status: "simulated" });
    expect(n.body).toMatch(/does not obtain permits/);
    // the run re-scheduled itself for the next day
    const [next] = await sql()<{ n: number }[]>`select count(*)::int as n from public.jobs where kind = 'permits.remind' and status = 'queued' and run_at > now()`;
    expect(next.n).toBe(1);

    // a second run the same day creates nothing new
    await enqueueJob(null, "permits.remind", {}, { dedupKey: `test:permits:${randomUUID()}` });
    await runDueJobs(opsHandlers, { kinds: ["permits.remind"] });
    const [count] = await sql()<{ n: number }[]>`select count(*)::int as n from public.notifications where dedup_key = ${key}`;
    expect(count.n).toBe(1);

    // once obtained, no more reminders are candidates
    expectOk(await updateTripPermit(operator, seeded!.tripId, seeded!.permitRequirementId, { status: "obtained", confirmationRef: "DEMO-123", notes: "" }));
    expect((await lastAudit("trip_permit.staff_updated", seeded!.tripId)).metadata).toMatchObject({ from: "applied", to: "obtained" });
    await enqueueJob(null, "permits.remind", {}, { dedupKey: `test:permits:${randomUUID()}` });
    const [job] = await sql()<{ id: number }[]>`select id from public.jobs where kind = 'permits.remind' and status = 'queued' and run_at <= now() order by id desc limit 1`;
    await runDueJobs(opsHandlers, { kinds: ["permits.remind"] });
    const [done] = await sql()<{ lastError: string }[]>`select last_error from public.jobs where id = ${job.id}`;
    expect(done.lastError).toMatch(/^0 permit reminder/);
  });
});

describe("staff roles", () => {
  it("cannot remove the last remaining admin (use-case and database)", async () => {
    const admin = await demoUser("admin");
    const [{ n }] = await sql()<{ n: number }[]>`select count(*)::int as n from public.staff_roles where role = 'admin'`;
    expect(n).toBe(1);
    const r = await revokeStaffRole(admin, admin.id, "admin");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/last remaining admin/);
    await expect(withSystem((tx) => tx`delete from public.staff_roles where user_id = ${admin.id} and role = 'admin'`)).rejects.toThrow(/last remaining admin/);

    // with a second admin, removal works (and the remaining one is protected again)
    expectOk(await grantStaffRole(admin, { email: "operator@demo.ghostguide.test", role: "admin" }));
    const operator = await demoUser("operator");
    expectOk(await revokeStaffRole(admin, operator.id, "admin"));
    const [{ n: after }] = await sql()<{ n: number }[]>`select count(*)::int as n from public.staff_roles where role = 'admin'`;
    expect(after).toBe(1);
    expect((await grantStaffRole(admin, { email: "nobody@nowhere.test", role: "support" })).ok).toBe(false);
  });
});
