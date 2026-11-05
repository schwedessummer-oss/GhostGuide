import clsx from "clsx";
import { AlertTriangle, BatteryCharging, BellOff, Compass, LocateOff, Lock, ShieldAlert, Smartphone, Volume2 } from "lucide-react";
import type { ComponentType } from "react";

/**
 * Plain-language limitations of the web app. Shown on the pre-hike page and
 * on the hike screen BEFORE starting, and in full on /how-it-works. These
 * statements are product requirements: never soften them into guarantees.
 */
export interface Limitation {
  id: string;
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: string;
  body: string;
}

export const LIMITATIONS: Limitation[] = [
  {
    id: "gps-background",
    icon: LocateOff,
    title: "GPS can pause when the screen locks",
    body: "Browsers may stop or slow location updates when your screen locks or another app is in front. Narration and off-route prompts only work while Ghost Guide is open.",
  },
  {
    id: "audio-lock",
    icon: Volume2,
    title: "Audio may stop when the screen locks",
    body: "Narration plays while the app is open. Locked-screen and background audio are not guaranteed. Every story also has a written transcript.",
  },
  {
    id: "no-offline-alerts",
    icon: BellOff,
    title: "Offline reminders and notifications are not guaranteed",
    body: "Hydration and pace reminders appear inside the app while it is open. We can't promise notifications without signal or with the app closed.",
  },
  {
    id: "screen-on",
    icon: BatteryCharging,
    title: "Keep the app open with the screen on",
    body: "We ask your phone to keep the screen on (Wake Lock) where supported, which uses more battery. Bring a charged battery pack.",
  },
  {
    id: "backup-nav",
    icon: Compass,
    title: "Carry a backup way to navigate",
    body: "Bring a paper map or another navigation method and know how to use it. The offline route view has no map tiles.",
  },
  {
    id: "not-emergency",
    icon: ShieldAlert,
    title: "Ghost Guide is not an emergency service",
    body: "It does not monitor you continuously, cannot see your location in real time and cannot contact 911 or Search and Rescue for you. In an emergency call 911, or use your own satellite communicator's SOS.",
  },
  {
    id: "native-app",
    icon: Smartphone,
    title: "Dependable background tracking needs a native app",
    body: "Reliable background location, locked-screen audio and offline notifications require a future iOS/Android app. This web app cannot provide them.",
  },
];

export function LimitationsList({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <ul className={clsx("space-y-3", className)}>
      {LIMITATIONS.map((l) => (
        <li key={l.id} className="flex gap-3">
          <l.icon aria-hidden className="mt-0.5 size-5 shrink-0 text-amber-ink" />
          <div>
            <p className="font-semibold text-ink">{l.title}</p>
            {compact ? null : <p className="text-[0.95rem] text-muted">{l.body}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function LimitationsCallout({ className }: { className?: string }) {
  return (
    <div className={clsx("rounded-xl border border-[#f1d9b0] bg-amber-bg p-4 text-amber-ink", className)}>
      <p className="flex items-center gap-2 font-semibold">
        <AlertTriangle aria-hidden className="size-5" /> Read before you start
      </p>
      <p className="mt-1 flex items-start gap-2 text-[0.95rem]">
        <Lock aria-hidden className="mt-1 size-4 shrink-0" />
        Web apps can&apos;t run reliably in the background. Keep Ghost Guide open, carry a backup map, and call 911 yourself in an emergency.
      </p>
    </div>
  );
}
