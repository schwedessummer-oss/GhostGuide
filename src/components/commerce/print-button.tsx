"use client";

import { Printer } from "lucide-react";
import { Button } from "@/components/ui";

export function PrintButton({ label = "Print receipt" }: { label?: string }) {
  return (
    <Button type="button" variant="secondary" onClick={() => window.print()} className="print:hidden">
      <Printer aria-hidden className="size-4" />
      {label}
    </Button>
  );
}
