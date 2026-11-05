import Link from "next/link";
import type { Metadata } from "next";
import { ChevronRight, Lock, Users } from "lucide-react";
import { Card, Container, PageHeader } from "@/components/ui";
import { AccountNav } from "@/components/account/account-nav";
import { ProfileForm } from "@/components/account/profile-form";
import { requireUser } from "@/server/auth";
import { getProfile } from "@/server/account/profile";
import { listContacts } from "@/server/account/contacts";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your account" };

export default async function AccountPage() {
  const user = await requireUser("/account");
  const [profile, contacts] = await Promise.all([getProfile(user), listContacts(user)]);
  const consented = contacts.filter((c) => c.hasConsent).length;

  return (
    <Container className="max-w-4xl py-8 sm:py-10">
      <PageHeader eyebrow="Account" title="Your account" description="Your details, emergency contacts and privacy choices." />
      <AccountNav current="profile" />
      <div className="grid gap-6 lg:grid-cols-3">
        <Card aria-labelledby="profile-heading" className="lg:col-span-2">
          <h2 id="profile-heading" className="text-xl font-bold">
            Profile
          </h2>
          <p className="mt-1 text-sm text-muted">
            Signed in as <span className="font-semibold text-ink">{profile.email}</span>
          </p>
          <div className="mt-5">
            <ProfileForm fullName={profile.fullName ?? ""} phone={profile.phone ?? ""} units={profile.units} />
          </div>
        </Card>
        <div className="space-y-4">
          <Link href="/account/emergency-contacts" className="block rounded-[var(--radius-card)] border border-sand-200 bg-surface p-5 hover:border-forest-600">
            <span className="flex items-center justify-between gap-2 font-bold text-ink">
              <span className="flex items-center gap-2">
                <Users aria-hidden className="size-5 text-forest-700" /> Emergency contacts
              </span>
              <ChevronRight aria-hidden className="size-5" />
            </span>
            <span className="mt-1 block text-sm text-muted">
              {contacts.length === 0
                ? "No contacts yet. Add someone who agreed to receive check-in notices."
                : `${contacts.length} saved · ${consented} with consent (can be used for check-ins)`}
            </span>
          </Link>
          <Link href="/account/privacy" className="block rounded-[var(--radius-card)] border border-sand-200 bg-surface p-5 hover:border-forest-600">
            <span className="flex items-center justify-between gap-2 font-bold text-ink">
              <span className="flex items-center gap-2">
                <Lock aria-hidden className="size-5 text-forest-700" /> Privacy & location
              </span>
              <ChevronRight aria-hidden className="size-5" />
            </span>
            <span className="mt-1 block text-sm text-muted">
              Location history kept {profile.locationRetentionDays} day{profile.locationRetentionDays === 1 ? "" : "s"} · last location in notices:{" "}
              {profile.shareLocationWithContacts ? "on" : "off"}
            </span>
          </Link>
        </div>
      </div>
    </Container>
  );
}
