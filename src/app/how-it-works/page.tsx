import Link from "next/link";
import type { Metadata } from "next";
import { CloudDownload, Compass, Headphones, ListChecks, Lock, MapPinned, ShieldCheck, Smartphone, UserRoundCheck } from "lucide-react";
import { Card, Container, PageHeader } from "@/components/ui";
import { LimitationsList } from "@/components/hike/limitations";

export const metadata: Metadata = {
  title: "How it works & limitations",
  description: "How Ghost Guide's self-guided hikes work, what the web app can and cannot do, the check-in safety model and how we handle your location.",
};

const STEPS = [
  { icon: Compass, title: "Find a hike", body: "Browse trails with clear facts — distance, climb, terrain, closures — each labelled verified, estimated or demonstration." },
  { icon: ListChecks, title: "Get a personal itinerary", body: "Tell us your pace, time and needs. We build a schedule with estimated times and a turnaround time. Estimates, not promises." },
  { icon: CloudDownload, title: "Book and download", body: "Book the self-guided experience (and optional gear, shuttle or meals), then download the trip so it works without signal." },
  { icon: Headphones, title: "Hike with the audio guide", body: "Stories play when you reach each stop, with a written transcript. You see your progress, time and an offline route view." },
  { icon: UserRoundCheck, title: "Optional check-in", body: "Choose an expected return time and a contact who agreed to be notified if we don't hear from you. Finish the hike to stop it." },
];

export default function HowItWorksPage() {
  return (
    <Container className="max-w-4xl py-10">
      <PageHeader
        eyebrow="How it works"
        title="A self-guided hike with an audio companion"
        description="What Ghost Guide does, what a web app can't do, and how our check-in safety model works."
      />

      <section aria-labelledby="steps-heading">
        <h2 id="steps-heading" className="sr-only">
          Steps
        </h2>
        <ol className="grid gap-4 sm:grid-cols-2">
          {STEPS.map((s, i) => (
            <li key={s.title} className="rounded-2xl border border-sand-200 bg-surface p-5">
              <p className="flex items-center gap-2 font-semibold text-forest-800">
                <s.icon aria-hidden className="size-5" /> {i + 1}. {s.title}
              </p>
              <p className="mt-1 text-muted">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <Card className="mt-8" aria-labelledby="limits-heading">
        <h2 id="limits-heading" className="text-2xl font-bold">
          Limitations of the web app
        </h2>
        <p className="mt-2 text-muted">
          Ghost Guide is an installable web app (PWA). It runs inside your phone&apos;s browser, which limits what it can do when you are not
          looking at it. We say this plainly because it matters on a trail:
        </p>
        <LimitationsList className="mt-5" />
      </Card>

      <Card className="mt-6" aria-labelledby="native-heading">
        <h2 id="native-heading" className="flex items-center gap-2 text-2xl font-bold">
          <Smartphone aria-hidden className="size-6" /> Web app today, native app later
        </h2>
        <div className="mt-3 grid gap-5 sm:grid-cols-2">
          <div>
            <h3 className="font-semibold">What the web app does</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[0.95rem]">
              <li>Uses GPS while the hike screen is open and visible.</li>
              <li>Plays narration from downloaded audio or your device&apos;s voice while open.</li>
              <li>Asks the screen to stay on (Wake Lock) where the browser supports it.</li>
              <li>Works offline after download: route, stops, stories, help info.</li>
              <li>Saves your location and taps on the device and sends them when you reconnect.</li>
            </ul>
          </div>
          <div>
            <h3 className="font-semibold">What needs a native iOS/Android app</h3>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-[0.95rem]">
              <li>Dependable background location (iOS background location modes, Android foreground services).</li>
              <li>Narration that keeps playing with the screen locked.</li>
              <li>Local reminders and notifications without signal.</li>
              <li>Licensed offline map tiles.</li>
            </ul>
          </div>
        </div>
        <p className="mt-4 text-[0.95rem] text-muted">
          The server side is ready for a native client: the trip bundle, start/sync/finish APIs and the device outbox use client-generated ids and
          timestamps, so data recorded offline is accepted exactly once, in order, whenever it arrives. A native app can reuse them unchanged.
        </p>
      </Card>

      <Card className="mt-6" aria-labelledby="safety-heading">
        <h2 id="safety-heading" className="flex items-center gap-2 text-2xl font-bold">
          <ShieldCheck aria-hidden className="size-6" /> Our safety model
        </h2>
        <ul className="mt-3 space-y-3 text-[0.98rem]">
          <li>
            <strong>Ghost Guide is not an emergency service.</strong> It does not monitor you continuously and cannot see where you are in real time.
          </li>
          <li>
            <strong>Check-ins are opt-in reminders.</strong> You set an expected return time; you can tap &quot;I&apos;m okay&quot;, extend, or finish.
          </li>
          <li>
            <strong>&quot;Overdue&quot; means we haven&apos;t received your confirmation</strong> by your expected return time plus a grace period. It is
            not proof of an emergency — phones die and signal drops. We then notify the contact you chose, with the last location we received and how
            old it is.
          </li>
          <li>
            <strong>We never call 911 or Search and Rescue automatically.</strong> Your contact decides what to do.
          </li>
          <li>
            <strong>No satellite SOS.</strong> Ghost Guide does not send SOS messages. If you carry a satellite communicator, use its own SOS service.
          </li>
          <li>
            <strong>Reminders are general.</strong> Water and pace prompts are general reminders, not medical advice.
          </li>
          <li>
            <strong>Stories are reviewed.</strong> Narration is approved by our editors with a cited source; AI-written text is labelled and never decides
            routes, safety or emergency actions.
          </li>
        </ul>
      </Card>

      <Card className="mt-6" aria-labelledby="privacy-heading">
        <h2 id="privacy-heading" className="flex items-center gap-2 text-2xl font-bold">
          <Lock aria-hidden className="size-6" /> Privacy &amp; your location
        </h2>
        <ul className="mt-3 list-disc space-y-2 pl-5 text-[0.98rem]">
          <li>Location is collected only while a hike is in progress and the hike screen is open.</li>
          <li>We store sampled points (about every 30 seconds or 50 m) to show your last known location and to support check-ins.</li>
          <li>Precise location is visible only to you and to our safety staff; support staff and other users never see it.</li>
          <li>Location history is deleted automatically after your chosen retention period.</li>
          <li>Your emergency contact receives your last location only if a check-in becomes overdue and you allowed sharing it.</li>
          <li>
            A downloaded trip (with your last location on this device) opens offline only for the account that downloaded it. Signing out removes
            downloaded trips from this browser; on a shared device, sign out when you&apos;re done.
          </li>
        </ul>
        <p className="mt-4">
          <Link href="/account/privacy" className="inline-flex min-h-11 items-center font-semibold text-forest-800 underline">
            <MapPinned aria-hidden className="mr-1 size-4" /> Privacy &amp; location settings
          </Link>
        </p>
      </Card>
    </Container>
  );
}
