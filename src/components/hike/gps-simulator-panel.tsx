"use client";

import { FlaskConical } from "lucide-react";
import { Button, Checkbox, Field, Select, SimulatedBadge } from "@/components/ui";
import type { HikeEngine, HikeSnapshot } from "./engine/hike-engine";

const SPEEDS_KMH = [2, 3, 4.7, 6, 8];
const SPEED_UPS = [1, 5, 10, 20, 50];
const NOISE = [
  { label: "Low (open sky)", noiseM: 2, driftM: 2, poorFixChance: 0.01 },
  { label: "Medium (forest)", noiseM: 4, driftM: 5, poorFixChance: 0.05 },
  { label: "High (canyon)", noiseM: 9, driftM: 10, poorFixChance: 0.15 },
];

/**
 * DEMO MODE ONLY. Drives the hike with a deterministic simulated walk along
 * the route so the experience can be demonstrated (and end-to-end tested)
 * without walking it. Everything here is labelled "Simulated GPS".
 */
export function GpsSimulatorPanel({ snap, engine }: { snap: HikeSnapshot; engine: HikeEngine }) {
  if (!snap.demoMode) return null;
  const { enabled, config } = snap.simulator;
  const noiseIdx = Math.max(0, NOISE.findIndex((n) => n.noiseM === config.noiseM));
  return (
    <section aria-labelledby="sim-heading" className="rounded-2xl border-2 border-dashed border-amber-ink/50 bg-amber-bg/50 p-4" data-testid="gps-simulator">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="sim-heading" className="flex items-center gap-2 text-lg font-bold">
          <FlaskConical aria-hidden className="size-5" /> Simulated GPS
        </h2>
        <SimulatedBadge label="Demo only" />
      </div>
      <p className="mt-1 text-sm text-muted">
        Walks the route for demonstrations. Locations from the simulator are fake and are labelled as simulated when synced.
      </p>
      <div className="mt-3 space-y-3">
        <Checkbox
          label="Use simulated GPS instead of this device's location"
          checked={enabled}
          onChange={(e) => engine.setSimulator({ enabled: e.target.checked })}
          data-testid="sim-toggle"
        />
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Walking speed" htmlFor="sim-speed">
            <Select
              id="sim-speed"
              data-testid="sim-speed"
              value={String(Math.round(config.speedMps * 3.6 * 10) / 10)}
              onChange={(e) => engine.setSimulator({ config: { speedMps: Number(e.target.value) / 3.6 } })}
            >
              {SPEEDS_KMH.map((k) => (
                <option key={k} value={String(k)}>
                  {k} km/h
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Speed-up" htmlFor="sim-speedup">
            <Select id="sim-speedup" data-testid="sim-speedup" value={String(config.speedUp)} onChange={(e) => engine.setSimulator({ config: { speedUp: Number(e.target.value) } })}>
              {SPEED_UPS.map((k) => (
                <option key={k} value={String(k)}>
                  {k}× real time
                </option>
              ))}
            </Select>
          </Field>
          <Field label="GPS noise" htmlFor="sim-noise">
            <Select
              id="sim-noise"
              value={String(noiseIdx)}
              onChange={(e) => {
                const n = NOISE[Number(e.target.value)];
                engine.setSimulator({ config: { noiseM: n.noiseM, driftM: n.driftM, poorFixChance: n.poorFixChance } });
              }}
            >
              {NOISE.map((n, i) => (
                <option key={n.label} value={String(i)}>
                  {n.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="secondary" onClick={() => engine.simulateDetour()} disabled={!enabled} data-testid="sim-detour">
            Wander off the route
          </Button>
          <Button variant="secondary" onClick={() => engine.setSimulator({ config: { detour: null } })} disabled={!enabled || !config.detour}>
            Return to route
          </Button>
          <Button
            variant="secondary"
            onClick={() => engine.setSimulator({ config: { signalLost: !config.signalLost } })}
            disabled={!enabled}
            aria-pressed={config.signalLost}
            data-testid="sim-signal"
          >
            {config.signalLost ? "Restore GPS signal" : "Lose GPS signal"}
          </Button>
        </div>
        <p className="text-xs text-muted">
          To demonstrate the offline queue, also switch your browser or device to offline mode; queued items sync when you reconnect.
        </p>
      </div>
    </section>
  );
}
