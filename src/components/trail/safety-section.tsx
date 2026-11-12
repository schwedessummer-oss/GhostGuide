import { Phone, TriangleAlert, WifiOff } from "lucide-react";
import type { EmergencyNumbersDto, TrailDetailDto } from "@/domain/catalog";
import { countryName, isPoorVisibility, sacGrade, trailVisibilityLabel } from "./format";

/** Hazards stated only from stored data (demanding SAC grade, poor visibility); empty otherwise. */
export function knownHazards(t: Pick<TrailDetailDto, "sacScale" | "trailVisibility">): string[] {
  const out: string[] = [];
  const g = sacGrade(t.sacScale);
  if (g && g.rank >= 2) {
    out.push(`Demanding terrain: mapped as SAC ${g.grade} (${g.name.toLowerCase()}) — ${g.summary}.`);
  }
  if (isPoorVisibility(t.trailVisibility)) {
    out.push(
      `The path can be hard to follow: trail visibility is mapped as “${trailVisibilityLabel(t.trailVisibility).split(" — ")[0].toLowerCase()}”.`,
    );
  }
  return out;
}

const SERVICE_LABEL: Record<"police" | "ambulance" | "fire", string> = { police: "Police", ambulance: "Ambulance", fire: "Fire" };

export function SafetySection({ trail, emergency }: { trail: TrailDetailDto; emergency: EmergencyNumbersDto }) {
  const hazards = knownHazards(trail);
  const country = countryName(trail.countryCode);
  const others = (["police", "ambulance", "fire"] as const).filter((k) => emergency[k]);

  return (
    <div className="space-y-4">
      {emergency.primary ? (
        <div>
          <p className="text-sm text-muted">Emergency number{country ? ` in ${country}` : ""}</p>
          <a
            href={`tel:${emergency.primary}`}
            className="mt-1.5 flex min-h-13 items-center gap-3 rounded-xl bg-red-ink px-4 py-3 text-white hover:brightness-110"
          >
            <Phone aria-hidden className="size-5" />
            <span className="text-2xl font-bold tabular-nums tracking-wide">{emergency.primary}</span>
            <span className="text-sm font-semibold">Call</span>
          </a>
          {others.length ? (
            <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {others.map((k) => (
                <li key={k}>
                  <span className="text-muted">{SERVICE_LABEL[k]} </span>
                  <a
                    href={`tel:${emergency[k]}`}
                    className="inline-flex min-h-11 items-center font-semibold tabular-nums text-ink underline underline-offset-2 sm:min-h-0"
                  >
                    {emergency[k]}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {emergency.notes.length ? (
        <ul className="space-y-1 text-sm text-ink">
          {emergency.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      ) : null}

      <p className="flex gap-2.5 rounded-xl bg-sand-100 px-3 py-2.5 text-sm text-ink">
        <WifiOff aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
        Cell service may be unavailable on trails — save an offline map in your maps app before you go.
      </p>

      {hazards.length ? (
        <div className="rounded-xl border border-[#f1d9b0] bg-amber-bg px-3 py-2.5 text-sm text-amber-ink">
          <p className="flex items-center gap-2 font-semibold">
            <TriangleAlert aria-hidden className="size-4" /> Known from map data
          </p>
          <ul className="mt-1 space-y-1">
            {hazards.map((h) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-xs text-muted">Ghost Guide does not contact emergency services.</p>
    </div>
  );
}
