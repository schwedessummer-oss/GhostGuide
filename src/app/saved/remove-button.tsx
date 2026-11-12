"use client";

import { useFormStatus } from "react-dom";
import { X } from "lucide-react";
import { buttonClass } from "@/components/ui";

/** Submit button for the remove form (the form works without JavaScript). */
export function RemoveSavedButton({ trailName }: { trailName: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={buttonClass("ghost", "md", "text-muted hover:text-red-ink")}>
      <X aria-hidden className="size-4" />
      {pending ? "Removing…" : "Remove"}
      <span className="sr-only"> {trailName} from saved trails</span>
    </button>
  );
}
