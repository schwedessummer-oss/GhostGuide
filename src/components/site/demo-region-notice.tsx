import Link from "next/link";
import { TriangleAlert } from "lucide-react";

/**
 * Label for pages of the fictional demo region (development fixtures, shown
 * only when SHOW_DEMO_FIXTURES is on). Points to Explore for real trails.
 */
export function DemoRegionNotice({ regionName, className }: { regionName?: string | null; className?: string }) {
  const name = regionName?.replace(/\s*\(demo region\)\s*/i, "").trim();
  return (
    <div role="note" className={`flex items-start gap-3 rounded-xl border border-[#f1d9b0] bg-amber-bg p-4 text-amber-ink ${className ?? ""}`}>
      <TriangleAlert aria-hidden className="mt-0.5 size-5 shrink-0" />
      <p>
        <strong>Demo region (fictional){name ? `: ${name}` : ""}.</strong> These trails, facts and stories are invented to show how Ghost
        Guide trips work. Not for navigation.{" "}
        <Link href="/explore" className="font-semibold underline underline-offset-2">
          Find real trails on Explore
        </Link>
      </p>
    </div>
  );
}
