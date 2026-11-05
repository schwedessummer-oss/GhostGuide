import Link from "next/link";
import type { Metadata } from "next";
import { CheckCircle2, CircleAlert, ChevronLeft } from "lucide-react";
import { z } from "zod";
import { Badge, Card, Container, EmptyState, PageHeader } from "@/components/ui";
import { AccountNav } from "@/components/account/account-nav";
import { ContactForm, DeleteContactForm } from "@/components/account/contact-form";
import { requireUser } from "@/server/auth";
import { CONSENT_STATEMENT, MAX_CONTACTS, listContacts } from "@/server/account/contacts";
import { getOwnedTrip } from "@/server/trips/queries";
import { formatDate } from "@/lib/format";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Emergency contacts" };

export default async function EmergencyContactsPage({ searchParams }: PageProps<"/account/emergency-contacts">) {
  const sp = await searchParams;
  const user = await requireUser("/account/emergency-contacts");
  const tripParam = typeof sp.trip === "string" && z.uuid().safeParse(sp.trip).success ? sp.trip : null;
  const [contacts, trip] = await Promise.all([listContacts(user), tripParam ? getOwnedTrip(user, tripParam) : Promise.resolve(null)]);

  return (
    <Container className="max-w-4xl py-8 sm:py-10">
      {trip ? (
        <p className="mb-4">
          <Link href={`/trips/${trip.id}/checkin`} className="inline-flex min-h-11 items-center gap-1 font-semibold text-forest-800 hover:underline">
            <ChevronLeft aria-hidden className="size-4" /> Back to check-ins for {trip.trailName}
          </Link>
        </p>
      ) : null}
      <PageHeader
        eyebrow="Account"
        title="Emergency contacts"
        description="People who agreed to get a notice from Ghost Guide if we don't hear from you by your expected return time."
      />
      <AccountNav current="contacts" />

      <div className="grid gap-6 lg:grid-cols-5">
        <section aria-labelledby="contacts-heading" className="space-y-4 lg:col-span-3">
          <h2 id="contacts-heading" className="text-xl font-bold">
            Your contacts
          </h2>
          {contacts.length === 0 ? (
            <EmptyState title="No emergency contacts yet">Add someone you trust. Ask them first — they must agree to receive notices.</EmptyState>
          ) : (
            <ul className="space-y-4">
              {contacts.map((c) => (
                <li key={c.id}>
                  <Card className="space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <p className="text-lg font-bold">{c.name}</p>
                        {c.relationship ? <p className="text-sm text-muted">{c.relationship}</p> : null}
                      </div>
                      {c.hasConsent ? (
                        <Badge tone="forest">
                          <CheckCircle2 aria-hidden className="size-3.5" /> Consent confirmed
                        </Badge>
                      ) : (
                        <Badge tone="amber">
                          <CircleAlert aria-hidden className="size-3.5" /> Consent needed
                        </Badge>
                      )}
                    </div>
                    <dl className="grid gap-2 text-[0.95rem] sm:grid-cols-2">
                      <div>
                        <dt className="text-sm text-muted">Mobile</dt>
                        <dd>{c.phone ?? "—"}</dd>
                      </div>
                      <div>
                        <dt className="text-sm text-muted">Email</dt>
                        <dd className="break-all">{c.email ?? "—"}</dd>
                      </div>
                    </dl>
                    <p className="text-sm text-muted">
                      {c.hasConsent && c.consentConfirmedAt
                        ? `You confirmed their consent on ${formatDate(c.consentConfirmedAt)}.`
                        : "Can't be chosen for check-ins until you confirm they agreed."}
                      {c.usedByOpenCheckin ? " Used for an upcoming or active check-in." : ""}
                    </p>
                    <details className="rounded-xl border border-sand-200 p-3">
                      <summary className="min-h-11 cursor-pointer content-center font-semibold text-forest-800">Edit {c.name}</summary>
                      <div className="mt-3">
                        <ContactForm
                          consentStatement={CONSENT_STATEMENT}
                          values={{ id: c.id, name: c.name, phone: c.phone ?? "", email: c.email ?? "", relationship: c.relationship ?? "", hasConsent: c.hasConsent }}
                        />
                      </div>
                    </details>
                    <DeleteContactForm contactId={c.id} name={c.name} usedByOpenCheckin={c.usedByOpenCheckin} />
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="add-heading" className="lg:col-span-2">
          <Card>
            <h2 id="add-heading" className="text-xl font-bold">
              Add a contact
            </h2>
            {contacts.length >= MAX_CONTACTS ? (
              <p className="mt-2 text-muted">You&apos;ve saved the maximum of {MAX_CONTACTS} contacts. Delete one to add another.</p>
            ) : (
              <div className="mt-4">
                <ContactForm consentStatement={CONSENT_STATEMENT} />
              </div>
            )}
            <p className="mt-4 text-sm text-muted">
              Ghost Guide uses contact details only to send check-in notices you set up. We never contact emergency services on your behalf. Contact details
              are visible only to you and, when needed, to Ghost Guide safety staff.
            </p>
          </Card>
        </section>
      </div>
    </Container>
  );
}
