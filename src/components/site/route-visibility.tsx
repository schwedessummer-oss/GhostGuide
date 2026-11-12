"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { isFullscreenRoute } from "./nav";

/** Renders its children except on full-height app routes (Explore), where page chrome like the footer is hidden. */
export function HiddenOnFullscreen({ children }: { children: ReactNode }) {
  return isFullscreenRoute(usePathname()) ? null : <>{children}</>;
}
