"use client";

import clsx from "clsx";
import { CheckCircle2, Circle, Pause, Play, Volume2, VolumeX } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import type { HikeEngine, HikeSnapshot } from "./engine/hike-engine";

const MODE_LABEL = {
  audio: "Recorded audio",
  device_voice: "Device voice",
  text_only: "Text only (no voice available)",
  muted: "Muted — transcript only",
  starting: "Starting…",
} as const;

/**
 * Current narration with its transcript (always visible — the transcript is
 * the accessible alternative to audio), and the list of stops with manual
 * play/replay that is always available.
 */
export function NarrationPanel({ snap, engine }: { snap: HikeSnapshot; engine: HikeEngine }) {
  const now = snap.narration;
  const muted = snap.settings.muted;
  return (
    <section aria-labelledby="narration-heading" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="narration-heading" className="text-xl font-bold">
          Audio guide
        </h2>
        <Button
          variant="secondary"
          onClick={() => engine.updateSettings({ muted: !muted })}
          aria-pressed={muted}
          data-testid="hike-mute"
        >
          {muted ? <VolumeX aria-hidden className="size-4" /> : <Volume2 aria-hidden className="size-4" />}
          {muted ? "Muted" : "Sound on"}
        </Button>
      </div>
      {!snap.audioUnlocked && (snap.phase === "active" || snap.phase === "paused") && !muted ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl bg-sand-100 p-3 text-sm">
          <span>Your browser needs a tap before it can play narration.</span>
          <Button variant="secondary" onClick={() => engine.enableAudio()}>
            Enable sound
          </Button>
        </div>
      ) : null}

      {now ? (
        <article className="rounded-2xl border border-forest-200 bg-forest-50 p-4" aria-labelledby="now-playing-title">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone="forest">{now.source === "gps" ? "Triggered by your location" : "Played by you"}</Badge>
            <Badge tone={now.mode === "device_voice" ? "blue" : "neutral"}>{MODE_LABEL[now.mode]}</Badge>
            {now.playing ? <span className="text-muted">Playing…</span> : null}
          </div>
          {now.poiName ? <p className="mt-2 text-sm font-semibold uppercase tracking-wide text-forest-700">{now.poiName}</p> : null}
          <h3 id="now-playing-title" className="mt-1 text-lg font-bold">
            {now.narration.title}
          </h3>
          <p className="mt-2 whitespace-pre-line text-[1.05rem] leading-relaxed" data-testid="narration-transcript">
            {now.narration.transcript}
          </p>
          {now.narration.sourceCitation ? <p className="mt-2 text-xs text-muted">Source: {now.narration.sourceCitation}</p> : null}
          <div className="mt-3 flex flex-wrap gap-2">
            {now.playing ? (
              <Button variant="secondary" onClick={() => engine.stopNarration()}>
                <Pause aria-hidden className="size-4" /> Stop audio
              </Button>
            ) : (
              <Button variant="secondary" onClick={() => engine.playNarration(now.narration.id)}>
                <Play aria-hidden className="size-4" /> Replay
              </Button>
            )}
          </div>
          {now.mode === "device_voice" ? (
            <p className="mt-2 text-xs text-muted">Read aloud by your device&apos;s built-in voice. Voices vary by device and some need a connection.</p>
          ) : null}
        </article>
      ) : (
        <p className="rounded-xl bg-sand-100 p-3 text-muted">Stories play automatically when you reach each stop. You can also play any stop below.</p>
      )}

      <ol className="space-y-2" aria-label="Stops on this route">
        {snap.pois.map((p) => (
          <li key={p.id} className="flex items-center justify-between gap-3 rounded-xl border border-sand-200 bg-surface p-3">
            <div className="flex min-w-0 items-start gap-2">
              {p.heard ? (
                <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0 text-forest-700" />
              ) : (
                <Circle aria-hidden className="mt-0.5 size-5 shrink-0 text-muted" />
              )}
              <div className="min-w-0">
                <p className="font-semibold">{p.name}</p>
                <p className="text-sm text-muted">
                  {p.heard ? "Heard" : "Upcoming"}
                  {p.narration ? ` · ${p.narration.title}` : " · no approved story"}
                </p>
              </div>
            </div>
            {p.narration ? (
              <Button
                variant="ghost"
                className={clsx("shrink-0")}
                onClick={() => engine.playNarration(p.narration!.id)}
                aria-label={`${p.heard ? "Replay" : "Play"} ${p.narration.title}`}
              >
                <Play aria-hidden className="size-4" /> {p.heard ? "Replay" : "Play"}
              </Button>
            ) : null}
          </li>
        ))}
        {snap.generalNarrations.map((n) => (
          <li key={n.id} className="flex items-center justify-between gap-3 rounded-xl border border-sand-200 bg-surface p-3">
            <p className="font-semibold">{n.title}</p>
            <Button variant="ghost" onClick={() => engine.playNarration(n.id)} aria-label={`Play ${n.title}`}>
              <Play aria-hidden className="size-4" /> Play
            </Button>
          </li>
        ))}
      </ol>
    </section>
  );
}
