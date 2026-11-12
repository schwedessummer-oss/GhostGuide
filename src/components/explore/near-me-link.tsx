"use client";

import { useRouter } from "next/navigation";
import clsx from "clsx";
import { LocateFixed } from "lucide-react";
import { Spinner } from "./bits";
import { NEAR_ME_RADIUS_KM, bboxAroundPoint } from "./geometry";
import { explorePath, EMPTY_FILTERS } from "./url-state";
import { useNearMe } from "./use-near-me";

/**
 * "Near me" outside Explore (landing page): asks for the location only when
 * tapped, then opens Explore on the area around it. Problems (denied,
 * unavailable) are explained right below the button.
 */
export function NearMeLink({ className, messageClassName }: { className?: string; messageClassName?: string }) {
  const router = useRouter();
  const nearMe = useNearMe((point) => {
    router.push(explorePath({ q: "", bbox: bboxAroundPoint(point, NEAR_ME_RADIUS_KM), filters: EMPTY_FILTERS }));
  });
  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={nearMe.locate} disabled={nearMe.status === "locating"} className={clsx("inline-flex items-center justify-center gap-2", className)}>
        {nearMe.status === "locating" ? <Spinner className="size-5" /> : <LocateFixed aria-hidden className="size-5" />}
        Trails near me
      </button>
      <p role="status" aria-live="polite" className={clsx("text-sm empty:hidden", messageClassName)}>
        {nearMe.status !== "idle" && nearMe.status !== "locating" ? nearMe.message : ""}
      </p>
    </div>
  );
}
