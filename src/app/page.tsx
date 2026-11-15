import type { Metadata } from "next";
import { Container } from "@/components/ui";

export const metadata: Metadata = {
  title: { absolute: "Ghost Guide — the world's best hikes, coming soon" },
  description: "Ghost Guide is being rebuilt as a guide to the world's best hikes. The catalog is coming soon.",
};

/** Decorative ridgelines (solid fills, no images). */
function Ridges({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 1200 240" preserveAspectRatio="xMidYMax slice" aria-hidden focusable="false" className={className}>
      <path d="M0 150 L110 95 L210 130 L330 55 L450 120 L560 75 L670 125 L790 45 L910 115 L1020 80 L1120 120 L1200 95 L1200 240 L0 240 Z" fill="#2a5a3e" opacity="0.55" />
      <path d="M0 190 L95 150 L200 178 L310 130 L430 172 L545 138 L655 182 L770 140 L890 186 L1005 150 L1110 182 L1200 160 L1200 240 L0 240 Z" fill="#1f4630" />
      <path d="M0 240 L0 214 Q220 186 430 208 T840 202 T1200 196 L1200 240 Z" fill="#173524" />
    </svg>
  );
}

/**
 * Placeholder home page while the hike catalog is rebuilt (docs/PLAN.md):
 * it says what Ghost Guide is becoming and nothing more. No hikes, numbers
 * or features are shown until the curated catalog is loaded and reviewed.
 */
export default function HomePage() {
  return (
    <section className="relative overflow-hidden bg-forest-900 text-white">
      <Ridges className="pointer-events-none absolute inset-x-0 bottom-0 h-40 w-full sm:h-52" />
      <Container className="relative pt-16 pb-48 sm:pt-24 sm:pb-64">
        <p className="text-sm font-semibold tracking-wide text-forest-100 uppercase">Coming soon</p>
        <h1 className="mt-3 max-w-3xl text-4xl leading-[1.1] font-bold tracking-tight sm:text-5xl lg:text-6xl">The world&apos;s best hikes.</h1>
        <p className="mt-5 max-w-2xl text-lg text-forest-100 sm:text-xl">
          Ghost Guide is being rebuilt as a guide to the world&apos;s best hikes. The catalog is coming soon.
        </p>
      </Container>
    </section>
  );
}
