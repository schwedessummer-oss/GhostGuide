import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { Alert, Card, SimulatedBadge } from "@/components/ui";
import { getCurrentUser } from "@/server/auth";
import { getOwnedTrip } from "@/server/trips/queries";
import { isAwaiting, isOverdueState } from "@/domain/checkin";
import { loadCheckinCardData, type CheckinCardData } from "./data";
import { CheckinSetupForm, type SetupContactOption } from "./setup-form";
import { CheckinOptOutForm } from "./quick-actions";
import { CheckinStatusSummary } from "./status-summary";
import { CHECKIN_LIMITS_NOTE } from "./copy";

export function setupFormProps(d: CheckinCardData, mode: "create" | "update") {
  const consenting: SetupContactOption[] = d.contacts
    .filter((c) => c.hasConsent)
    .map((c) => ({ id: c.id, name: c.name, relationship: c.relationship, reach: [c.phoneMasked, c.emailMasked].filter(Boolean).join(" · ") }));
  return {
    tripId: d.trip.id,
    mode,
    contacts: consenting,
    contactsNeedingConsent: d.contacts.filter((c) => !c.hasConsent).map((c) => c.name),
    selectedContactId: d.checkin?.emergencyContactId ?? null,
    expectedReturnLocal: d.defaults.expectedReturnLocal,
    tzLabel: d.tzLabel,
    graceMinutes: d.defaults.graceMinutes,
    reminderOffsetsMin: d.defaults.reminderOffsetsMin,
    shareLocation: d.shareLocation,
  };
}

/**
 * CROSS-SLICE CONTRACT — implemented by the safety slice.
 * Rendered on the pre-hike page (hike slice) to let the customer opt in to
 * trip check-ins. Server component; loads its own data for `tripId`.
 */
export async function CheckinSetupCard({ tripId }: { tripId: string }) {
  const user = await getCurrentUser();
  if (!user) return null;
  const trip = await getOwnedTrip(user, tripId);
  if (!trip) return null;
  const d = await loadCheckinCardData(user, trip);
  const c = d.checkin;
  const eligible = trip.status === "booked" || trip.status === "active";

  return (
    <Card aria-labelledby={`checkin-setup-${trip.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={`checkin-setup-${trip.id}`} className="flex items-center gap-2 text-xl font-bold">
          <ShieldCheck aria-hidden className="size-5 text-forest-700" /> Trip check-ins
        </h2>
        {d.notificationsSimulated ? <SimulatedBadge label="Simulated notices (demo)" /> : null}
      </div>
      <p className="mt-1 text-muted">Optional. Pick a trusted contact and a return time; we&apos;ll send them a notice only if we don&apos;t hear from you.</p>

      <div className="mt-4 space-y-4">
        {c && (isAwaiting(c.status) || isOverdueState(c.status) || c.status === "completed") ? (
          <>
            <CheckinStatusSummary
              checkin={c}
              contact={d.contact}
              contactReachable={d.contactReachable}
              simulated={d.notificationsSimulated}
              timeZone={d.timeZone}
              tripId={trip.id}
              compact
            />
            <Link href={`/trips/${trip.id}/checkin`} className="inline-flex min-h-11 items-center font-semibold text-forest-800 underline">
              {isOverdueState(c.status) ? "Respond now: I'm okay / Finish trip" : "Check-in details and actions"}
            </Link>
            {isAwaiting(c.status) ? (
              <>
                <details className="rounded-xl border border-sand-200 p-3">
                  <summary className="min-h-11 cursor-pointer content-center font-semibold text-forest-800">Change contact, time or reminders</summary>
                  <div className="mt-3">
                    <CheckinSetupForm {...setupFormProps(d, "update")} />
                  </div>
                </details>
                <CheckinOptOutForm tripId={trip.id} />
              </>
            ) : null}
          </>
        ) : !eligible ? (
          <p>Check-ins become available once your trip is booked.</p>
        ) : !d.checkinsEnabled ? (
          <Alert tone="neutral" title="Check-ins are unavailable right now">
            Please tell someone you trust where you&apos;re going and when you expect to be back.
          </Alert>
        ) : (
          <>
            {c?.status === "cancelled" ? (
              // Shown after "Turn off check-ins" (the opt-out form and its message are gone once the page refreshes).
              <Alert tone="neutral" title="Check-ins are off for this trip" live="polite">
                No reminders or notices will be sent. You can turn them on again below.
              </Alert>
            ) : null}
            <CheckinSetupForm {...setupFormProps(d, "create")} />
          </>
        )}
        <p className="text-sm text-muted">{CHECKIN_LIMITS_NOTE}</p>
      </div>
    </Card>
  );
}
