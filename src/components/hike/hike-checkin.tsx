"use client";

import { useState } from "react";
import { Clock, HeartPulse } from "lucide-react";
import { Button, Card, Field, Input, SimulatedBadge } from "@/components/ui";
import { EXTEND_PRESETS_MIN, extendedReturnAt, isOverdueState } from "@/domain/checkin";
import { formatInZone, localDateInZone, localTimeInZone, zonedTimeToUtc } from "@/lib/time";
import type { HikeEngine, HikeSnapshot } from "./engine/hike-engine";
import { MAX_EXTEND_AHEAD_MS, MIN_EXTEND_LEAD_MS } from "./engine/hike-engine";

/**
 * Check-in on the active hike screen: when we expect the hiker back, when the
 * contact would be notified, and "Extend my trip" (+30 / +60 / +120 min or a
 * chosen time). Works offline: the extension is queued on the device and
 * takes effect only once it reaches Ghost Guide — the card says so plainly.
 * Shown only while the trip's check-in is open.
 */
export function HikeCheckinCard({ snap, engine }: { snap: HikeSnapshot; engine: HikeEngine }) {
  const c = snap.checkin;
  const [error, setError] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [busy, setBusy] = useState(false);
  if (!c || !c.open || !snap.bundle) return null;
  const tz = snap.bundle.region.timezone;
  const now = snap.now;
  const fmt = (ms: number) => formatInZone(new Date(ms), tz, { weekday: "short", hour: "numeric", minute: "2-digit" });
  const toLocalInput = (ms: number) => `${localDateInZone(new Date(ms), tz)}T${localTimeInZone(new Date(ms), tz)}`;
  const ext = c.extension;
  const online = snap.sync.online;

  const submit = async (at: number) => {
    setBusy(true);
    setError(await engine.extendCheckin(at));
    setBusy(false);
  };
  const submitCustom = () => {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(custom);
    if (!m) {
      setError("Choose a date and time.");
      return;
    }
    void submit(zonedTimeToUtc(m[1], m[2], tz).getTime());
  };

  let extStatus: string | null = null;
  if (ext) {
    const to = fmt(ext.newExpectedReturnAt);
    if (ext.state === "queued") {
      extStatus = online
        ? `Sending your extension to ${to}…`
        : `Your extension to ${to} is saved on this device and will be sent when you're back online. Until it reaches Ghost Guide, your contact may still be notified after ${fmt(c.serverExpectedReturnAt + c.graceMinutes * 60_000)}.`;
    } else if (ext.state === "sent") {
      extStatus = `Your extension to ${to} reached Ghost Guide.`;
    } else if (ext.state === "applied") {
      extStatus = `Extended: we now expect you back by ${to}.`;
    } else {
      extStatus = `Your extension to ${to} was not applied${ext.reason ? ` (${ext.reason})` : ""}. Try again, or use "I'm okay".`;
    }
  }

  return (
    <Card aria-labelledby="hike-checkin-heading" data-testid="hike-checkin">
      <h2 id="hike-checkin-heading" className="flex items-center gap-2 text-lg font-bold">
        <HeartPulse aria-hidden className="size-5 text-forest-700" /> Your check-in
      </h2>
      <p className="mt-2" data-testid="hike-checkin-expected">
        Expected back by <strong>{fmt(c.expectedReturnAt)}</strong>. If we haven&apos;t heard from you by{" "}
        <strong>{fmt(c.notifyAfter)}</strong> (your {c.graceMinutes}-minute grace period), your contact is told we haven&apos;t heard from you — it
        doesn&apos;t mean we know something is wrong, and nobody calls 911 automatically.
        {snap.bundle.notificationsSimulated ? (
          <>
            {" "}
            <SimulatedBadge label="Simulated notices (demo)" />
          </>
        ) : null}
      </p>
      {isOverdueState(c.status) ? (
        <p className="mt-2 rounded-lg bg-amber-bg p-2 text-sm text-amber-ink">
          When this trip data was loaded we hadn&apos;t heard from you after your expected return. Tap &quot;I&apos;m okay&quot; or extend your
          trip below.
        </p>
      ) : null}

      <div className="mt-4">
        <p className="flex items-center gap-2 font-semibold" id="hike-extend-label">
          <Clock aria-hidden className="size-4" /> Extend my trip
        </p>
        <div className="mt-2 grid grid-cols-3 gap-2" role="group" aria-labelledby="hike-extend-label">
          {EXTEND_PRESETS_MIN.map((m) => (
            <Button
              key={m}
              variant="secondary"
              disabled={busy}
              onClick={() => void submit(extendedReturnAt(new Date(c.expectedReturnAt), m, new Date(now)).getTime())}
              data-testid={`hike-extend-${m}`}
            >
              +{m >= 60 ? `${m / 60} h` : `${m} min`}
            </Button>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-1">
            <Field label="Or choose a new return time" htmlFor="hike-extend-until" hint={`${snap.bundle.region.name} time`}>
              <Input
                id="hike-extend-until"
                type="datetime-local"
                value={custom}
                min={toLocalInput(now + MIN_EXTEND_LEAD_MS)}
                max={toLocalInput(now + MAX_EXTEND_AHEAD_MS)}
                onChange={(e) => setCustom(e.target.value)}
                aria-describedby="hike-extend-until-hint"
              />
            </Field>
          </div>
          <Button variant="secondary" disabled={busy || !custom} onClick={submitCustom} data-testid="hike-extend-custom">
            Extend
          </Button>
        </div>
        <div aria-live="polite" className="mt-2 space-y-1 text-sm">
          {error ? (
            <p className="font-semibold text-red-ink" role="alert">
              {error}
            </p>
          ) : null}
          {extStatus ? (
            <p className={ext?.state === "not_applied" ? "font-semibold text-red-ink" : ext?.state === "queued" && !online ? "text-amber-ink" : "text-forest-800"} data-testid="hike-extend-status">
              {extStatus}
            </p>
          ) : null}
        </div>
        <p className="mt-2 text-xs text-muted">
          An extension made without signal only counts once it reaches Ghost Guide. If you can, tell your contact yourself too.
        </p>
      </div>
    </Card>
  );
}
