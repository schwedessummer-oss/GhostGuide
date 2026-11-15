import Link from "next/link";

const linkClass = "inline-flex min-h-11 items-center underline underline-offset-2 hover:text-ink";

/**
 * Site footer. Rendered by the root layout, so it reads no cookies or
 * headers (that would make every page dynamic).
 */
export function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-sand-200 bg-sand-100 print:hidden">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-10 text-sm text-muted sm:flex-row sm:items-start sm:justify-between sm:px-6">
        <div>
          <p className="font-semibold text-ink">Ghost Guide</p>
          <p className="mt-2">A guide to the world&apos;s best hikes, being rebuilt.</p>
        </div>
        <ul>
          <li>
            <Link className={linkClass} href="/status">
              Integration status
            </Link>
          </li>
        </ul>
      </div>
    </footer>
  );
}
