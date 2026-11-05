import { afterAll, describe, expect, it } from "vitest";
import { closeDb, sql, withSystem, withUser } from "@/server/db";
import { sha256 } from "@/server/auth/tokens";
import { createShare, listShares, lookupShare, resolveShare, revokeShare } from "@/server/sharing/shares";
import { purgeExpiredLocations } from "@/server/account/retention";
import { deleteLocationHistory, getProfile, updatePrivacySettings, updateProfile } from "@/server/account/profile";
import { createContact, deleteContact, listConsentedContacts, listContacts, updateContact, CONSENT_STATEMENT } from "@/server/account/contacts";
import { confirmOkByUser, listTripNotifications } from "@/server/checkins/manage";
import type { SessionUser } from "@/server/auth";
import { createCustomer } from "../../helpers/db";
import { addLastLocation, addMin, bookedTrip, consentedContact, optIn, setFullName } from "./helpers";

afterAll(closeDb);

describe("trip sharing", () => {
  it("token works, then fails after revoke; stores only the hash", async () => {
    const user = await createCustomer("share");
    await setFullName(user, "Hana Hiker");
    const trip = await bookedTrip(user);
    const contact = await consentedContact(user);
    await optIn(user, trip.id, contact);
    const created = await createShare(user, trip.id, 24, false);
    if (!created.ok) throw new Error(created.error);
    expect(created.url).toMatch(/\/share\/[A-Za-z0-9_-]{32}$/);
    const [row] = await sql()`select token_hash from public.trip_shares where id = ${created.shareId}`;
    expect(row.tokenHash).toBe(sha256(created.token));
    expect(row.tokenHash).not.toContain(created.token);

    const view = await resolveShare(created.token);
    expect(view).not.toBeNull();
    expect(view!.trailName).toBe("Lantern Creek Loop");
    expect(view!.hikerFirstName).toBe("Hana");
    expect(view!.statusText).toBe("No confirmation received yet");
    expect(view!.expectedReturnAt).not.toBeNull();
    expect(view!.location).toBeNull();
    expect(view!.locationIncluded).toBe(false);
    expect(JSON.stringify(view)).not.toMatch(/555|casey/i);

    await confirmOkByUser(user, trip.id);
    expect((await resolveShare(created.token))!.statusText).toMatch(/^Confirmed okay at \d{1,2}:\d{2} [AP]M/);

    expect(await revokeShare(user, trip.id, created.shareId)).toEqual({ ok: true });
    expect(await resolveShare(created.token)).toBeNull();
    expect((await listShares(user, trip.id))[0].active).toBe(false);
  });

  it("expires, includes the last location only when chosen, and rejects malformed tokens", async () => {
    const user = await createCustomer("share2");
    const trip = await bookedTrip(user, { status: "active" });
    const contact = await consentedContact(user);
    await optIn(user, trip.id, contact);
    const now = new Date();
    await addLastLocation(user, trip.id, { lat: 47.51, lng: -121.69, accuracyM: 12, recordedAt: addMin(now, -30) });
    const withLoc = await createShare(user, trip.id, 6, true, now);
    if (!withLoc.ok) throw new Error(withLoc.error);
    const v = await resolveShare(withLoc.token, now);
    expect(v!.location).toMatchObject({ lat: 47.51, lng: -121.69, accuracyM: 12, freshness: "stale" });
    expect(v!.location!.label).toBe("STALE — 30 min old");
    expect(await resolveShare(withLoc.token, addMin(now, 6 * 60 + 1))).toBeNull(); // expired
    expect(await resolveShare("not a token")).toBeNull();
    expect(await resolveShare("A".repeat(32))).toBeNull(); // unknown
    expect(await createShare(user, trip.id, 12, false)).toMatchObject({ ok: false });
  });

  it("only the owner can create, list or revoke links; lookups are rate limited", async () => {
    const alice = await createCustomer("alice");
    const bob = await createCustomer("bob");
    const trip = await bookedTrip(alice);
    const share = await createShare(alice, trip.id, 24, false);
    if (!share.ok) throw new Error(share.error);
    expect(await createShare(bob, trip.id, 24, true)).toMatchObject({ ok: false, notFound: true });
    expect(await listShares(bob, trip.id)).toEqual([]);
    expect(await revokeShare(bob, trip.id, share.shareId)).toMatchObject({ ok: false });
    expect(await resolveShare(share.token)).not.toBeNull();
    // RLS backstop: bob cannot see or revoke the row directly
    expect(await withUser(bob, (tx) => tx`update public.trip_shares set revoked_at = now() where id = ${share.shareId} returning id`)).toHaveLength(0);

    const client = `test-client-${Math.random()}`;
    let limited = false;
    for (let i = 0; i < 65 && !limited; i++) limited = (await lookupShare(share.token, client)).rateLimited;
    expect(limited).toBe(true);
  });
});

describe("location retention", () => {
  async function addPoints(user: SessionUser, tripId: string, ages: number[]) {
    const sessionId = await addLastLocation(user, tripId, { lat: 47.5, lng: -121.7, accuracyM: 10, recordedAt: new Date() });
    await withSystem(async (tx) => {
      for (const [i, ageH] of ages.entries()) {
        await tx`
          insert into public.location_points (hike_session_id, user_id, client_point_id, lat, lng, accuracy_m, recorded_at)
          values (${sessionId}, ${user.id}, ${`p-${i}-${ageH}`}, 47.5, -121.7, 10, now() - make_interval(hours => ${ageH}))`;
      }
    });
    return sessionId;
  }

  it("purge deletes only points older than each user's own retention", async () => {
    const shortUser = await createCustomer("short");
    const longUser = await createCustomer("long");
    expect(await updatePrivacySettings(shortUser, { locationRetentionDays: 1, shareLocationWithContacts: true })).toEqual({ ok: true });
    expect(await updatePrivacySettings(longUser, { locationRetentionDays: 30, shareLocationWithContacts: true })).toEqual({ ok: true });
    const t1 = await bookedTrip(shortUser);
    const t2 = await bookedTrip(longUser);
    await addPoints(shortUser, t1.id, [1, 23, 25, 48]);
    await addPoints(longUser, t2.id, [1, 48, 24 * 29]);
    // an old last-known location of a finished trip is purged too
    await withSystem((tx) => tx`update public.hike_last_locations set recorded_at = now() - interval '3 days' where user_id = ${shortUser.id}`);

    await purgeExpiredLocations(new Date());
    const left = async (u: SessionUser) =>
      (await sql()<{ h: number }[]>`select round(extract(epoch from now() - recorded_at) / 3600)::int as h from public.location_points where user_id = ${u.id} order by recorded_at desc`).map((r) => r.h);
    expect(await left(shortUser)).toEqual([1, 23]);
    expect(await left(longUser)).toEqual([1, 48, 24 * 29]);
    expect(await sql()`select 1 from public.hike_last_locations where user_id = ${shortUser.id}`).toHaveLength(0);
    expect(await sql()`select 1 from public.hike_last_locations where user_id = ${longUser.id}`).toHaveLength(1);
    const [audit] = await sql()`select actor_id, metadata from public.audit_logs where action = 'retention.purge' order by id desc limit 1`;
    expect(audit.actorId).toBeNull();
    expect(audit.metadata.pointsDeleted).toBeGreaterThanOrEqual(2);
  });

  it("keeps the last-known location while the trip's check-in is open", async () => {
    const user = await createCustomer("openkeep");
    await updatePrivacySettings(user, { locationRetentionDays: 1, shareLocationWithContacts: true });
    const trip = await bookedTrip(user);
    await optIn(user, trip.id, await consentedContact(user));
    await addLastLocation(user, trip.id, { lat: 47.5, lng: -121.7, accuracyM: 10, recordedAt: addMin(new Date(), -3 * 24 * 60) });
    await purgeExpiredLocations(new Date());
    expect(await sql()`select 1 from public.hike_last_locations where user_id = ${user.id}`).toHaveLength(1);
  });

  it("“Delete my location history now” removes only my points and last locations, with an audit entry", async () => {
    const me = await createCustomer("me");
    const other = await createCustomer("other");
    const t1 = await bookedTrip(me);
    const t2 = await bookedTrip(other);
    await addPoints(me, t1.id, [1, 2]);
    await addPoints(other, t2.id, [1]);
    const res = await deleteLocationHistory(me);
    expect(res).toEqual({ pointsDeleted: 2, lastFixesDeleted: 1 });
    expect(await sql()`select 1 from public.location_points where user_id = ${me.id}`).toHaveLength(0);
    expect(await sql()`select 1 from public.location_points where user_id = ${other.id}`).toHaveLength(1);
    const [audit] = await sql()`select actor_id, metadata from public.audit_logs where action = 'privacy.location_history_deleted' and actor_id = ${me.id}`;
    expect(audit.metadata).toEqual({ pointsDeleted: 2, lastFixesDeleted: 1 });
  });
});

describe("account settings", () => {
  it("updates profile and privacy settings with validation", async () => {
    const user = await createCustomer("profile");
    expect(await updateProfile(user, { fullName: "  Hana Hiker ", phone: "(555) 555-0199", units: "metric" })).toEqual({ ok: true });
    const p = await getProfile(user);
    expect(p).toMatchObject({ fullName: "Hana Hiker", phone: "+15555550199", units: "metric" });
    expect(await updateProfile(user, { fullName: "", phone: "abc", units: "furlongs" })).toMatchObject({
      ok: false,
      fieldErrors: { fullName: expect.any(String), phone: expect.any(String), units: expect.any(String) },
    });
    expect(await updatePrivacySettings(user, { locationRetentionDays: 0, shareLocationWithContacts: true })).toMatchObject({ ok: false });
    expect(await updatePrivacySettings(user, { locationRetentionDays: 366, shareLocationWithContacts: true })).toMatchObject({ ok: false });
    expect(await updatePrivacySettings(user, { locationRetentionDays: 7, shareLocationWithContacts: false })).toEqual({ ok: true });
    expect(await getProfile(user)).toMatchObject({ locationRetentionDays: 7, shareLocationWithContacts: false });
  });

  it("stores consent attestation with the statement; changing details requires fresh consent", async () => {
    const user = await createCustomer("contacts");
    expect(await createContact(user, { name: "No Way", phone: "", email: "", relationship: "", consent: true })).toMatchObject({ ok: false });
    expect(await createContact(user, { name: "Bad", phone: "12", email: "nope", relationship: "", consent: true })).toMatchObject({
      ok: false,
      fieldErrors: { phone: expect.any(String), email: expect.any(String) },
    });
    const id = await consentedContact(user);
    const [c] = await listContacts(user);
    expect(c).toMatchObject({ id, hasConsent: true, consentStatement: CONSENT_STATEMENT, phone: "+15555550123", phoneMasked: "+1•••••0123" });
    const firstConsent = c.consentConfirmedAt!;
    await updateContact(user, id, { name: "Casey C.", phone: "+15555550123", email: "casey@example.com", relationship: "Sister", consent: true });
    expect((await listContacts(user))[0].consentConfirmedAt!.getTime()).toBe(firstConsent.getTime());
    await updateContact(user, id, { name: "Casey C.", phone: "+15555550124", email: "casey@example.com", relationship: "Sister", consent: false });
    expect(await listConsentedContacts(user)).toHaveLength(0);
  });

  it("another customer cannot read, edit or delete my contacts or see my notifications", async () => {
    const alice = await createCustomer("alice");
    const bob = await createCustomer("bob");
    const id = await consentedContact(alice);
    expect(await listContacts(bob)).toEqual([]);
    expect(await updateContact(bob, id, { name: "Hacked", phone: "+15555550000", email: "", relationship: "", consent: true })).toMatchObject({ ok: false });
    expect(await deleteContact(bob, id)).toMatchObject({ ok: false });
    expect((await listContacts(alice))[0].name).toBe("Casey Contact");
    const trip = await bookedTrip(alice);
    await optIn(alice, trip.id, id);
    expect(await listTripNotifications(bob, trip.id)).toEqual([]);
    expect(await deleteContact(alice, id)).toEqual({ ok: true });
    // the check-in keeps working without a contact (FK set null)
    expect((await sql()`select emergency_contact_id from public.trip_checkins where trip_id = ${trip.id}`)[0].emergencyContactId).toBeNull();
  });
});
