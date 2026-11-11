import "server-only";
import type { SessionUser } from "@/server/auth";
import type { TripRow } from "@/server/trips/queries";
import { getRegionById } from "@/server/catalog/trails";
import { getFlags } from "@/server/flags";
import { env } from "@/config/env";
import { listContacts, type ContactView } from "@/server/account/contacts";
import { getCheckinDefaults, getOwnedCheckin, type CheckinView } from "@/server/checkins/manage";
import { listShares, type ShareView } from "@/server/sharing/shares";
import { getProfile } from "@/server/account/profile";
import { MIN_LEAD_MIN, timeZoneLabel, toLocalInputValue } from "@/domain/checkin";

/** Data the check-in cards and page render from (all reads are RLS-scoped to the user). */
export interface CheckinCardData {
  trip: TripRow;
  timeZone: string;
  /** DST-neutral zone name, e.g. "Pacific Time" — shown next to time inputs */
  tzLabel: string;
  emergencyNumber: string;
  emergencyGuidance: string;
  checkinsEnabled: boolean;
  sharingEnabled: boolean;
  notificationsSimulated: boolean;
  checkin: CheckinView | null;
  contacts: ContactView[];
  contact: ContactView | null;
  /** the check-in's contact can receive a notice now (selected, consent on file, phone or email) */
  contactReachable: boolean;
  /** profiles.share_location_with_contacts (on by default) */
  shareLocation: boolean;
  defaults: { expectedReturnLocal: string; graceMinutes: number; reminderOffsetsMin: number[] };
  /** earliest acceptable "pick a new return time" value (datetime-local, region time) */
  minExtendLocal: string;
}

export async function loadCheckinCardData(user: SessionUser, trip: TripRow): Promise<CheckinCardData> {
  const [region, flags, checkin, contacts, defaults, profile] = await Promise.all([
    getRegionById(trip.regionId),
    getFlags(),
    getOwnedCheckin(user, trip.id),
    listContacts(user),
    getCheckinDefaults(trip),
    getProfile(user),
  ]);
  const timeZone = region?.timezone ?? defaults.timeZone;
  const now = new Date();
  const fallbackReturn = new Date(Math.ceil((now.getTime() + 4 * 3_600_000) / 900_000) * 900_000);
  const expected =
    checkin && checkin.status !== "cancelled" && checkin.status !== "completed"
      ? checkin.expectedReturnAt
      : defaults.expectedReturnAt && defaults.expectedReturnAt.getTime() > now.getTime() + 10 * 60_000
        ? defaults.expectedReturnAt
        : fallbackReturn;
  const contact = checkin?.emergencyContactId ? (contacts.find((c) => c.id === checkin.emergencyContactId) ?? null) : null;
  return {
    trip,
    timeZone,
    tzLabel: timeZoneLabel(timeZone, expected),
    emergencyNumber: region?.emergencyNumber ?? "911",
    emergencyGuidance: region?.emergencyGuidance ?? "",
    checkinsEnabled: flags.checkins_enabled === true,
    sharingEnabled: flags.trip_sharing === true,
    notificationsSimulated: env().NOTIFY_PROVIDER !== "live",
    checkin,
    contacts,
    contact,
    contactReachable: !!contact && contact.hasConsent && !!(contact.phone || contact.email),
    shareLocation: profile.shareLocationWithContacts,
    defaults: {
      expectedReturnLocal: toLocalInputValue(expected, timeZone),
      graceMinutes: checkin && checkin.status !== "cancelled" ? checkin.graceMinutes : defaults.graceMinutes,
      reminderOffsetsMin: checkin && checkin.status !== "cancelled" ? checkin.reminderOffsetsMin : defaults.reminderOffsetsMin,
    },
    minExtendLocal: toLocalInputValue(new Date(now.getTime() + (MIN_LEAD_MIN + 1) * 60_000), timeZone),
  };
}

export async function loadShares(user: SessionUser, tripId: string): Promise<ShareView[]> {
  return listShares(user, tripId);
}
