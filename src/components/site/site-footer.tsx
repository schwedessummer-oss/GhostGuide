import Link from "next/link";
import { MAP_ATTRIBUTION } from "@/config/public";
import { HiddenOnFullscreen } from "./route-visibility";
import { SiteUnitsToggle } from "./units-toggle";

const linkClass = "inline-flex min-h-11 items-center underline underline-offset-2 hover:text-ink";

/**
 * Site footer. Rendered by the root layout, so it reads no cookies or
 * headers (that would make every page dynamic): the units switch picks up
 * the visitor's choice in the browser.
 */
export function SiteFooter() {
  return (
    <HiddenOnFullscreen>
      <footer className="mt-16 border-t border-sand-200 bg-sand-100 print:hidden">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-10 text-sm text-muted sm:grid-cols-[1.2fr_1.5fr_1fr] sm:px-6">
          <div>
            <p className="font-semibold text-ink">Ghost Guide</p>
            <p className="mt-2">Find a hike, plan the day, and get home safely.</p>
            <div className="mt-4 flex items-center gap-3">
              <span className="font-medium text-ink">Units</span>
              <SiteUnitsToggle size="sm" />
            </div>
          </div>
          <div>
            <p className="font-semibold text-ink">Safety</p>
            <p className="mt-2">
              Ghost Guide is not an emergency service, does not monitor you continuously, and cannot contact Search and Rescue for you. In an
              emergency, call your local emergency number (911 in the US) or use a satellite communicator.
            </p>
            <p className="mt-3">
              Trail and map data{" "}
              <a className="underline underline-offset-2 hover:text-ink" href={MAP_ATTRIBUTION.osm.url} target="_blank" rel="noopener noreferrer">
                {MAP_ATTRIBUTION.osm.label}
              </a>{" "}
              ({MAP_ATTRIBUTION.osm.license}). Times, climbs and difficulty are estimates.
            </p>
          </div>
          <ul>
            <li>
              <Link className={linkClass} href="/how-it-works">
                How it works &amp; limitations
              </Link>
            </li>
            <li>
              <Link className={linkClass} href="/account/privacy">
                Privacy &amp; location data
              </Link>
            </li>
            <li>
              <Link className={linkClass} href="/status">
                Integration status
              </Link>
            </li>
          </ul>
        </div>
      </footer>
    </HiddenOnFullscreen>
  );
}
