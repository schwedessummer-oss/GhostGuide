"use client";

import { Settings } from "lucide-react";
import { Checkbox, Field, Select } from "@/components/ui";
import { HYDRATION_CHOICES, PACE_CHOICES, REMINDER_DISCLAIMER } from "@/domain/reminders";
import { RADIUS_OVERRIDE_MAX_M, RADIUS_OVERRIDE_MIN_M } from "@/domain/geofence";
import type { HikeEngine, HikeSnapshot } from "./engine/hike-engine";
import { formatMinutes } from "./format";

const MULTIPLIERS = [0.5, 0.75, 1, 1.5, 2];
const OVERRIDES = [20, 30, 50, 75, 100, 150];

/** Hiker-adjustable settings: trigger distance, reminders, sound, vibration, contrast. */
export function HikeSettingsPanel({ snap, engine }: { snap: HikeSnapshot; engine: HikeEngine }) {
  const s = snap.settings;
  const next = snap.nextReminders;
  return (
    <details className="group rounded-2xl border border-sand-200 bg-surface p-4">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 font-semibold [&::-webkit-details-marker]:hidden">
        <Settings aria-hidden className="size-5" /> Settings
        <span className="text-sm font-normal text-muted">trigger distance, reminders, sound, contrast</span>
      </summary>
      <div className="mt-4 grid gap-5 sm:grid-cols-2">
        <Field
          label="Story trigger distance"
          htmlFor="trigger-mult"
          hint="How close you need to be for a story to start. Larger helps with weak GPS; smaller avoids early starts."
        >
          <Select
            id="trigger-mult"
            value={s.triggerOverrideM !== null ? `fixed:${s.triggerOverrideM}` : `mult:${s.triggerMultiplier}`}
            onChange={(e) => {
              const [kind, v] = e.target.value.split(":");
              if (kind === "fixed") engine.updateSettings({ triggerOverrideM: Number(v) });
              else engine.updateSettings({ triggerOverrideM: null, triggerMultiplier: Number(v) });
            }}
          >
            {MULTIPLIERS.map((m) => (
              <option key={m} value={`mult:${m}`}>
                {m === 1 ? "Standard (as set for each stop)" : `${m}× each stop's distance`}
              </option>
            ))}
            {OVERRIDES.filter((o) => o >= RADIUS_OVERRIDE_MIN_M && o <= RADIUS_OVERRIDE_MAX_M).map((o) => (
              <option key={o} value={`fixed:${o}`}>
                Fixed {o} m for every stop
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Water reminder"
          htmlFor="hydration"
          hint={next.hydration !== null ? `Next in about ${formatMinutes(Math.ceil(next.hydration / 60_000))} of hiking (pauses don't count).` : "Off"}
        >
          <Select
            id="hydration"
            value={s.hydrationEveryMin ?? "off"}
            onChange={(e) => engine.updateSettings({ hydrationEveryMin: e.target.value === "off" ? null : Number(e.target.value) })}
          >
            <option value="off">Off</option>
            {HYDRATION_CHOICES.map((m) => (
              <option key={m} value={m}>
                Every {m} min
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Pace check"
          htmlFor="pace"
          hint={next.pace_check !== null ? `Next in about ${formatMinutes(Math.ceil(next.pace_check / 60_000))} of hiking.` : "Off"}
        >
          <Select
            id="pace"
            value={s.paceCheckEveryMin ?? "off"}
            onChange={(e) => engine.updateSettings({ paceCheckEveryMin: e.target.value === "off" ? null : Number(e.target.value) })}
          >
            <option value="off">Off</option>
            {PACE_CHOICES.map((m) => (
              <option key={m} value={m}>
                Every {m} min
              </option>
            ))}
          </Select>
        </Field>
        <div className="space-y-1">
          <Checkbox className="[&>input]:shrink-0" label="Mute narration (show transcript only)" checked={s.muted} onChange={(e) => engine.updateSettings({ muted: e.target.checked })} />
          <Checkbox className="[&>input]:shrink-0" label="Vibrate on arrivals, prompts and reminders" checked={s.vibrate} onChange={(e) => engine.updateSettings({ vibrate: e.target.checked })} />
          <Checkbox
            className="[&>input]:shrink-0"
            label="High-contrast display (bright sunlight)"
            checked={s.highContrast}
            onChange={(e) => engine.updateSettings({ highContrast: e.target.checked })}
            data-testid="hike-high-contrast"
          />
        </div>
      </div>
      <p className="mt-4 text-xs text-muted">{REMINDER_DISCLAIMER}</p>
    </details>
  );
}
