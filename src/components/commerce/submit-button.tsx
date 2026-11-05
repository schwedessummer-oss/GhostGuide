"use client";

import { useFormStatus } from "react-dom";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui";

/** Submit button that disables itself and announces progress while the form action runs. */
export function SubmitButton({
  children,
  pendingLabel = "Working…",
  ...props
}: ComponentProps<typeof Button> & { children: ReactNode; pendingLabel?: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending || props.disabled} aria-disabled={pending || props.disabled} {...props}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
