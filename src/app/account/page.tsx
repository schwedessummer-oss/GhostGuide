import type { Metadata } from "next";
import { Card, Container, PageHeader } from "@/components/ui";
import { ProfileForm } from "@/components/account/profile-form";
import { requireUser } from "@/server/auth";
import { getProfile } from "@/server/account/profile";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Your account" };

export default async function AccountPage() {
  const user = await requireUser("/account");
  const profile = await getProfile(user);

  return (
    <Container className="max-w-4xl py-8 sm:py-10">
      <PageHeader eyebrow="Account" title="Your account" description="Your details and display preferences." />
      <Card aria-labelledby="profile-heading">
        <h2 id="profile-heading" className="text-xl font-bold">
          Profile
        </h2>
        <p className="mt-1 text-sm text-muted">
          Signed in as <span className="font-semibold text-ink">{profile.email}</span>
        </p>
        <div className="mt-5">
          <ProfileForm fullName={profile.fullName ?? ""} units={profile.units} />
        </div>
      </Card>
    </Container>
  );
}
