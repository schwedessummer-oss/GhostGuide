import { Ban, CircleAlert, Info, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui";
import type { Difficulty, FactKind } from "@/domain/types";

/** Text + icon (never color alone) for the most severe closure. */
export function ClosureBadge({ severity }: { severity: "closed" | "partial" | "advisory" | null }) {
  if (!severity) return null;
  if (severity === "closed")
    return (
      <Badge tone="red">
        <Ban aria-hidden className="size-3.5" />
        Closed
      </Badge>
    );
  if (severity === "partial")
    return (
      <Badge tone="amber">
        <TriangleAlert aria-hidden className="size-3.5" />
        Partial closure
      </Badge>
    );
  return (
    <Badge tone="blue">
      <Info aria-hidden className="size-3.5" />
      Advisory
    </Badge>
  );
}

const DIFFICULTY_TONE: Record<Difficulty, "forest" | "blue" | "amber" | "red"> = {
  easy: "forest",
  moderate: "blue",
  hard: "amber",
  strenuous: "red",
};

export function DifficultyBadge({ difficulty }: { difficulty: Difficulty }) {
  return <Badge tone={DIFFICULTY_TONE[difficulty]}>{difficulty[0].toUpperCase() + difficulty.slice(1)}</Badge>;
}

export function DemoBadge({ label = "Demo trail" }: { label?: string }) {
  return (
    <Badge tone="amber" title="Demonstration content: this place and route are fictional and not for navigation.">
      <CircleAlert aria-hidden className="size-3.5" />
      {label}
    </Badge>
  );
}

const FACT_LABEL: Record<FactKind, { label: string; tone: "forest" | "blue" | "neutral" | "amber" }> = {
  verified: { label: "Verified", tone: "forest" },
  estimate: { label: "Estimate", tone: "blue" },
  operator_note: { label: "Operator note", tone: "neutral" },
  demo: { label: "Demonstration", tone: "amber" },
};

export function FactKindBadge({ kind }: { kind: FactKind }) {
  const f = FACT_LABEL[kind];
  return <Badge tone={f.tone}>{f.label}</Badge>;
}
