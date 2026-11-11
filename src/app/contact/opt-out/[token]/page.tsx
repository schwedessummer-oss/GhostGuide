import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { Alert, Button, Card, Container } from "@/components/ui";
import { clientIpFrom } from "@/server/request";
import { lookupOptOutLink } from "@/server/account/contact-optout";
import { contactOptOutAction } from "./actions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Stop check-in notices",
  description: "Stop receiving Ghost Guide check-in notices as someone's emergency contact.",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

function Help() {
  return (
    <p className="mt-6 text-sm text-muted">
      Ghost Guide is not an emergency service and never contacts emergency services. If you are worried about someone&apos;s safety, try calling
      them, and if you are concerned call your local emergency number.
    </p>
  );
}

/**
 * Public page for the opt-out link in every notice to an emergency contact
 * (no sign-in). It never shows the hiker's location, trip or check-in
 * status — only their first name, which the notice already contained.
 * Opening the link changes nothing; the button does.
 */
export default async function ContactOptOutPage({ params, searchParams }: PageProps<"/contact/opt-out/[token]">) {
  const { token } = await params;
  const sp = await searchParams;
  const result = typeof sp.result === "string" ? sp.result : null;
  const lookup = await lookupOptOutLink(token, clientIpFrom(await headers()));

  if (lookup.rateLimited || result === "busy") {
    return (
      <Container className="max-w-2xl py-12">
        <Alert tone="amber" title="Too many requests" live="polite">
          Please wait a few minutes and open the link again.
        </Alert>
      </Container>
    );
  }

  const v = lookup.view;
  if (v.state === "invalid") {
    return (
      <Container className="max-w-2xl py-16">
        <h1 className="text-3xl font-bold text-ink">This link isn&apos;t valid or has expired</h1>
        <p className="mt-3 max-w-prose text-lg text-muted">
          Check that you opened the whole link from the message. If you keep getting Ghost Guide check-in notices you don&apos;t want, use the link in
          the most recent one, or ask the person who listed you to remove you as their emergency contact.
        </p>
        <Help />
        <Link href="/" className="mt-6 inline-flex min-h-11 items-center font-semibold text-forest-800 underline">
          Go to Ghost Guide
        </Link>
      </Container>
    );
  }

  const who = v.hikerFirstName ?? "the hiker who listed you";
  return (
    <Container className="max-w-2xl py-10 sm:py-14">
      <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-forest-700">Emergency contact settings</p>
      <h1 className="text-3xl font-bold text-ink sm:text-4xl">Stop check-in notices</h1>
      <Card className="mt-6 space-y-4">
        {v.state === "opted_out" ? (
          <Alert tone="forest" title={result === "done" ? "Done — you won't get any more notices" : "You're already opted out"} live="polite">
            Ghost Guide won&apos;t send you check-in notices about {who} any more. We&apos;ve let them know, so they can choose someone else as their
            emergency contact.
          </Alert>
        ) : (
          <>
            <p className="text-[0.95rem]">
              {v.hikerFirstName ? <strong>{v.hikerFirstName}</strong> : "A Ghost Guide hiker"} listed you as their emergency contact. Ghost Guide sends
              you a notice only if they haven&apos;t confirmed they&apos;re back by the time they planned.
            </p>
            <p className="text-[0.95rem]">
              If you don&apos;t want these notices, stop them here. This takes effect immediately, and we&apos;ll let {who} know so they can choose
              someone else.
            </p>
            {result === "invalid" ? (
              <Alert tone="amber" title="That didn't work" live="polite">
                Please try again.
              </Alert>
            ) : null}
            <form action={contactOptOutAction}>
              <input type="hidden" name="token" value={token} />
              <Button type="submit" variant="secondary" className="w-full sm:w-auto">
                Stop sending me notices
              </Button>
            </form>
          </>
        )}
      </Card>
      <Help />
    </Container>
  );
}
