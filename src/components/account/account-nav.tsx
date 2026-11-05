import Link from "next/link";
import clsx from "clsx";

const LINKS = [
  { key: "profile", href: "/account", label: "Profile" },
  { key: "contacts", href: "/account/emergency-contacts", label: "Emergency contacts" },
  { key: "privacy", href: "/account/privacy", label: "Privacy & location" },
] as const;

export type AccountSection = (typeof LINKS)[number]["key"];

/** Section navigation for the account area. */
export function AccountNav({ current }: { current: AccountSection }) {
  return (
    <nav aria-label="Account sections" className="mb-6">
      <ul className="flex flex-wrap gap-2">
        {LINKS.map((l) => (
          <li key={l.key}>
            <Link
              href={l.href}
              aria-current={current === l.key ? "page" : undefined}
              className={clsx(
                "inline-flex min-h-11 items-center rounded-xl border px-4 font-semibold",
                current === l.key ? "border-forest-700 bg-forest-700 text-white" : "border-sand-200 bg-surface text-forest-800 hover:bg-forest-50",
              )}
            >
              {l.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
