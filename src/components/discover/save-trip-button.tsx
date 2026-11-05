"use client";

import { useFormStatus } from "react-dom";
import { BookmarkPlus, LogIn } from "lucide-react";
import { Button } from "@/components/ui";

/** Submit button with a pending state (the form itself works without JS). */
export function SaveTripButton({ signedIn, trailName }: { signedIn: boolean; trailName: string }) {
  const { pending } = useFormStatus();
  return (
    <>
      <Button type="submit" size="lg" disabled={pending} className="w-full sm:w-auto">
        {signedIn ? <BookmarkPlus aria-hidden className="size-5" /> : <LogIn aria-hidden className="size-5" />}
        {pending ? "Saving…" : signedIn ? "Save this trip" : "Sign in to save this trip"}
        <span className="sr-only"> ({trailName})</span>
      </Button>
      <span aria-live="polite" className="sr-only">
        {pending ? `Saving ${trailName}…` : ""}
      </span>
    </>
  );
}
