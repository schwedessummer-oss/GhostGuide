import Link from "next/link";
import { Alert } from "@/components/ui";
import type { ContactView } from "@/server/account/contacts";
import type { CheckinView } from "@/server/checkins/manage";
import { describeCheckinForOwner, formatCheckinTime, formatWhen, isAwaiting, isOpen, overdueDueAt } from "@/domain/checkin";
import { minutesLabel, remindersLabel } from "./copy";

/** Plain-language status + the key facts of a check-in (server component, no client JS). */
export function CheckinStatusSummary({
  checkin,
  contact,
  contactReachable,
  simulated,
  timeZone,
  tripId,
  compact = false,
}: {
  checkin: CheckinView;
  contact: ContactView | null;
  /** the contact can receive a notice now (selected, consent on file, phone or email) */
  contactReachable: boolean;
  /** demo notification provider: notices are simulated */
  simulated: boolean;
  timeZone: string;
  tripId: string;
  compact?: boolean;
}) {
  const copy = describeCheckinForOwner(checkin, timeZone, { contactReachable, simulated, closedByStaff: checkin.closedByStaff });
  const open = isOpen(checkin.status);
  // The contact can only be changed while the check-in is awaiting; while a
  // notice is pending the change form isn't shown, so point to the contacts page.
  const canChange = isAwaiting(checkin.status);
  const reach = contact ? [contact.phoneMasked, contact.emailMasked].filter(Boolean).join(" · ") : "";
  return (
    <div className="space-y-4">
      <Alert tone={copy.tone} title={copy.title} live="polite">
        {copy.detail}
      </Alert>
      {open && !contact ? (
        <Alert tone="amber" title="No emergency contact on this check-in">
          {canChange ? (
            <>
              Nobody else will be notified if we don&apos;t hear from you.{" "}
              <Link className="font-semibold underline" href={`/trips/${tripId}/checkin#change`}>
                Choose a contact
              </Link>
            </>
          ) : (
            <>
              Nobody else is being notified. Tap “I&apos;m okay” or “Finish trip” below; after “I&apos;m okay” you can choose a contact for this trip.{" "}
              <Link className="font-semibold underline" href={`/account/emergency-contacts?trip=${tripId}`}>
                Set up an emergency contact
              </Link>
            </>
          )}
        </Alert>
      ) : null}
      {open && contact && !contact.hasConsent && contact.contactOptedOutAt ? (
        <Alert tone="amber" title={`${contact.name} opted out of Ghost Guide notices`}>
          They used the link in one of our notices on {formatCheckinTime(contact.contactOptedOutAt, timeZone)} to stop receiving check-in notices, so
          they won&apos;t be notified if we don&apos;t hear from you.{" "}
          {canChange ? (
            <Link className="font-semibold underline" href={`/trips/${tripId}/checkin#change`}>
              Choose another contact
            </Link>
          ) : (
            <Link className="font-semibold underline" href={`/account/emergency-contacts?trip=${tripId}`}>
              Update your contacts
            </Link>
          )}
        </Alert>
      ) : open && contact && !contact.hasConsent ? (
        <Alert tone="amber" title={`${contact.name} has no consent on file`}>
          They won&apos;t be notified.{" "}
          <Link className="font-semibold underline" href={`/account/emergency-contacts?trip=${tripId}`}>
            Update your contacts
          </Link>
        </Alert>
      ) : null}
      {checkin.status !== "cancelled" ? (
        <dl className={compact ? "space-y-2 text-[0.95rem]" : "grid gap-3 text-[0.95rem] sm:grid-cols-2"}>
          {checkin.status !== "completed" ? (
            <>
              <div>
                <dt className="text-sm text-muted">Expected return</dt>
                <dd className="font-semibold">{formatCheckinTime(checkin.expectedReturnAt, timeZone)}</dd>
              </div>
              <div>
                <dt className="text-sm text-muted">Contact notice if no word by</dt>
                <dd className="font-semibold">{formatCheckinTime(overdueDueAt(checkin), timeZone)}</dd>
                <dd className="text-sm text-muted">Grace period: {minutesLabel(checkin.graceMinutes)}</dd>
              </div>
            </>
          ) : null}
          <div>
            <dt className="text-sm text-muted">Last “I&apos;m okay”</dt>
            <dd className="font-semibold">{checkin.lastOkAt ? formatWhen(checkin.lastOkAt, timeZone) : "Not yet"}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">Emergency contact</dt>
            <dd className="font-semibold">{contact ? contact.name : "None selected"}</dd>
            {reach ? <dd className="text-sm text-muted">{reach}</dd> : null}
          </div>
          {!compact && checkin.status !== "completed" ? (
            <div className="sm:col-span-2">
              <dt className="text-sm text-muted">Reminders to you</dt>
              <dd>{remindersLabel(checkin.reminderOffsetsMin)}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}
