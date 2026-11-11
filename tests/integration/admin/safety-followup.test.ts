import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { closeDb, sql, withSystem } from "@/server/db";
import { listAttentionCheckins, recordStaffCheckinFollowUp } from "@/server/admin/safety";
import { createCustomer, demoUser } from "../../helpers/db";
import { bookedTrip, consentedContact, optIn } from "../safety/helpers";
import { expectForbidden, expectOk } from "./helpers";

afterAll(closeDb);

/** A check-in the hiker never confirmed: overdue, optionally with the contact already notified. */
async function overdueCheckin(tag: string, opts: { contactNotified?: boolean } = {}) {
  const hiker = await createCustomer(`followup-${tag}`);
  const trip = await bookedTrip(hiker, { status: "active" });
  const contactId = await consentedContact(hiker);
  const c = await optIn(hiker, trip.id, contactId, { minutesAhead: 120 });
  await withSystem(
    (tx) => tx`
      update public.trip_checkins
      set status = ${opts.contactNotified ? "contact_notified" : "overdue"}, overdue_at = now() - interval '5 minutes',
          contact_notified_at = ${opts.contactNotified ? new Date(Date.now() - 4 * 60_000) : null}::timestamptz
      where id = ${c.id}`,
  );
  return { hiker, tripId: trip.id, checkinId: c.id };
}

async function auditFor(action: string, checkinId: string) {
  return sql()<{ metadata: Record<string, unknown>; actorRoles: string[] }[]>`
    select metadata, actor_roles from public.audit_logs where action = ${action} and entity_id = ${checkinId} order by id`;
}

async function staffEvents(checkinId: string) {
  return sql()<{ kind: string; actor: string; actorId: string | null; details: Record<string, unknown> }[]>`
    select kind, actor, actor_id, details from public.checkin_events where checkin_id = ${checkinId} and actor = 'staff' order by id`;
}

describe("safety monitor: staff follow-up on an unconfirmed check-in", () => {
  it("lists overdue check-ins with the trail's time zone and readable timeline entries", async () => {
    const safety = await demoUser("safety");
    const { checkinId } = await overdueCheckin("list");
    const row = (await listAttentionCheckins(safety)).find((c) => c.id === checkinId);
    expect(row?.timeZone).toBe("America/Los_Angeles");
    expect(row?.events.length).toBeGreaterThan(0);
    for (const e of row!.events) expect(`${e.label} ${e.detail}`).not.toMatch(/\b[a-z]+_[a-z_]+\b|clientEventId|version/);
  });

  it("a note keeps the check-in open, is recorded on its timeline and audited", async () => {
    const safety = await demoUser("safety");
    const { checkinId } = await overdueCheckin("note");
    const r = await recordStaffCheckinFollowUp(safety, checkinId, { outcome: "note_only", note: "Called the hiker, voicemail. Will try again at 7 PM." });
    expectOk(r);
    const [c] = await sql()<{ status: string }[]>`select status from public.trip_checkins where id = ${checkinId}`;
    expect(c.status).toBe("overdue");
    const events = await staffEvents(checkinId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: "staff", actorId: safety.id });
    expect(events[0].details.note).toBe("Called the hiker, voicemail. Will try again at 7 PM.");
    const audit = await auditFor("checkin.staff_note", checkinId);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ outcome: "note_only", fromStatus: "overdue" });
    // the note itself is not copied into the audit log (no message bodies there)
    expect(JSON.stringify(audit[0].metadata)).not.toContain("voicemail");
    const row = (await listAttentionCheckins(safety)).find((x) => x.id === checkinId);
    expect(row?.events.some((e) => e.label === "Staff note" && e.detail.includes("voicemail"))).toBe(true);
  });

  it("confirming the hiker safe closes the check-in, cancels its jobs and queues the contact follow-up when they were notified", async () => {
    const operator = await demoUser("operator");
    const { checkinId } = await overdueCheckin("resolve", { contactNotified: true });
    const r = await recordStaffCheckinFollowUp(operator, checkinId, { outcome: "hiker_confirmed_safe", note: "Hiker phoned the office at 6:40 PM, back at the car." });
    expectOk(r);
    expect(r.message).toMatch(/hiker confirmed safe/);
    expect(r.warnings?.join(" ")).toMatch(/follow-up notice/);
    const [c] = await sql()<{ status: string; completedAt: Date | null }[]>`select status, completed_at from public.trip_checkins where id = ${checkinId}`;
    expect(c.status).toBe("completed");
    const [{ n }] = await sql()<{ n: number }[]>`
      select count(*)::int as n from public.jobs where status = 'queued' and payload ->> 'checkinId' = ${checkinId} and kind like 'checkins.%'`;
    expect(n).toBe(0);
    expect((await staffEvents(checkinId)).some((e) => e.details.note === "Hiker phoned the office at 6:40 PM, back at the car.")).toBe(true);
    const audit = await auditFor("checkin.staff_resolved", checkinId);
    expect(audit[0].metadata).toMatchObject({ outcome: "hiker_confirmed_safe", fromStatus: "contact_notified" });
    // it leaves the "needs attention" list
    expect((await listAttentionCheckins(operator)).some((x) => x.id === checkinId)).toBe(false);
    // a second resolve is refused (already completed)
    const again = await recordStaffCheckinFollowUp(operator, checkinId, { outcome: "hiker_confirmed_safe", note: "Duplicate click from a stale tab" });
    expect(again.ok).toBe(false);
    expect(await auditFor("checkin.staff_resolved", checkinId)).toHaveLength(1);
  });

  it("validates input and requires trips.monitor", async () => {
    const safety = await demoUser("safety");
    const support = await demoUser("support");
    const editor = await demoUser("editor");
    const { checkinId } = await overdueCheckin("validate");
    const short = await recordStaffCheckinFollowUp(safety, checkinId, { outcome: "note_only", note: "ok" });
    expect(short.ok ? "" : short.error).toMatch(/at least 5 characters/);
    expect((await recordStaffCheckinFollowUp(safety, checkinId, { outcome: "escalate_to_911" as never, note: "Not a valid outcome" })).ok).toBe(false);
    expect((await recordStaffCheckinFollowUp(safety, randomUUID(), { outcome: "note_only", note: "No such check-in" })).ok).toBe(false);
    await expectForbidden(recordStaffCheckinFollowUp(support, checkinId, { outcome: "note_only", note: "Support should not write here" }));
    await expectForbidden(recordStaffCheckinFollowUp(editor, checkinId, { outcome: "hiker_confirmed_safe", note: "Editors cannot resolve" }));
    expect(await staffEvents(checkinId)).toHaveLength(0);
  });
});
