import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-sand-200 bg-sand-100">
      <div className="mx-auto grid max-w-6xl gap-6 px-4 py-10 text-sm text-muted sm:grid-cols-3 sm:px-6">
        <div>
          <p className="font-semibold text-ink">Ghost Guide</p>
          <p className="mt-2">Self-guided hiking itineraries with an audio companion.</p>
        </div>
        <div>
          <p className="font-semibold text-ink">Safety</p>
          <p className="mt-2">
            Ghost Guide is not an emergency service, does not monitor you continuously, and cannot contact Search and Rescue for you. In an
            emergency, call 911 or use a satellite communicator.
          </p>
        </div>
        <ul className="space-y-2">
          <li>
            <Link className="underline underline-offset-2 hover:text-ink" href="/how-it-works">
              How it works &amp; limitations
            </Link>
          </li>
          <li>
            <Link className="underline underline-offset-2 hover:text-ink" href="/account/privacy">
              Privacy &amp; location data
            </Link>
          </li>
          <li>
            <Link className="underline underline-offset-2 hover:text-ink" href="/status">
              Integration status
            </Link>
          </li>
        </ul>
      </div>
    </footer>
  );
}
