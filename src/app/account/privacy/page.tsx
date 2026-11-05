import type { Metadata } from "next";
import { Card, Container, PageHeader } from "@/components/ui";
import { AccountNav } from "@/components/account/account-nav";
import { DeleteLocationHistoryForm, PrivacyForm } from "@/components/account/privacy-form";
import { requireUser } from "@/server/auth";
import { getProfile, locationHistoryStats } from "@/server/account/profile";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Privacy & location" };

const COLLECTED: { what: string; why: string }[] = [
  { what: "Account details (name, email, optional phone)", why: "To sign you in, send your receipts and your own check-in reminders." },
  { what: "Trip plans and bookings", why: "To build your itinerary and provide what you booked." },
  {
    what: "Precise location while a hike is in progress (only when you start a hike and allow location)",
    why: "To trigger audio at points of interest, show your progress and, if you opt in, include your last reported location in a check-in notice.",
  },
  { what: "Emergency contacts you add", why: "Only to send check-in notices you set up, after you confirm they agreed." },
  { what: "Check-in activity and notices sent", why: "So you (and our safety staff, if needed) can see exactly what was sent and when." },
];

export default async function PrivacyPage() {
  const user = await requireUser("/account/privacy");
  const [profile, stats] = await Promise.all([getProfile(user), locationHistoryStats(user)]);
  const hasData = stats.points + stats.lastFixes > 0;

  return (
    <Container className="max-w-4xl py-8 sm:py-10">
      <PageHeader eyebrow="Account" title="Privacy & location" description="What Ghost Guide collects, who can see it, and how long we keep it." />
      <AccountNav current="privacy" />

      <div className="space-y-6">
        <Card aria-labelledby="collect-heading">
          <h2 id="collect-heading" className="text-xl font-bold">
            What we collect and why
          </h2>
          <ul className="mt-4 space-y-3">
            {COLLECTED.map((c) => (
              <li key={c.what}>
                <p className="font-semibold">{c.what}</p>
                <p className="text-muted">{c.why}</p>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm text-muted">
            Ghost Guide does not track you in the background outside a hike you start, does not sell your data, and does not monitor you continuously. Browsers may
            pause location updates when the screen is locked or the app is in the background.
          </p>
        </Card>

        <Card aria-labelledby="who-heading">
          <h2 id="who-heading" className="text-xl font-bold">
            Who can see your precise location
          </h2>
          <ul className="mt-3 list-disc space-y-2 pl-5">
            <li>
              <span className="font-semibold">You.</span> Your trip pages show your own progress and last reported position.
            </li>
            <li>
              <span className="font-semibold">Ghost Guide safety staff, only when needed</span> — for example to look into a check-in notice. Only staff with
              the safety or administrator role can open precise locations and your contacts&apos; details; support, content and operations staff cannot.
            </li>
            <li>
              <span className="font-semibold">Your emergency contact</span>, only inside a check-in notice when we haven&apos;t heard from you — and only if the
              setting below is on.
            </li>
            <li>
              <span className="font-semibold">People you send a trip-share link to</span>, only if you tick “Include my last reported location” when creating that
              link. Links expire and you can turn them off at any time.
            </li>
          </ul>
        </Card>

        <Card aria-labelledby="settings-heading">
          <h2 id="settings-heading" className="text-xl font-bold">
            Your settings
          </h2>
          <div className="mt-4">
            <PrivacyForm retentionDays={profile.locationRetentionDays} shareLocation={profile.shareLocationWithContacts} />
          </div>
        </Card>

        <Card aria-labelledby="delete-heading">
          <h2 id="delete-heading" className="text-xl font-bold">
            Delete my location history now
          </h2>
          <p className="mt-2" aria-live="polite">
            {hasData
              ? `You have ${stats.points} stored location point${stats.points === 1 ? "" : "s"}${stats.oldest ? ` (oldest from ${formatDate(stats.oldest)})` : ""} and ${stats.lastFixes} last-known location${stats.lastFixes === 1 ? "" : "s"}.`
              : "No location history is stored for your account."}
          </p>
          <div className="mt-4">
            <DeleteLocationHistoryForm hasData={hasData} />
          </div>
        </Card>
      </div>
    </Container>
  );
}
