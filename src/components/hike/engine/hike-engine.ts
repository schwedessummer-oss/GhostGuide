/**
 * Client-side active-hike engine. Glue only: every decision is made by the
 * pure modules in src/domain (location quality → progress → geofence →
 * deviation → reminders); this class feeds them fixes, persists state to
 * IndexedDB, queues data in the outbox, plays narration and exposes an
 * immutable snapshot for React (useSyncExternalStore).
 *
 * Works fully offline once the trip bundle is in IndexedDB.
 */
import { projectOntoLine } from "@/domain/geo";
import { DEFAULT_LOCATION_QUALITY, assessFix, classifyStaleness, type GeoFix, type Staleness } from "@/domain/location-quality";
import {
  DEFAULT_PROGRESS_OPTIONS,
  activeElapsedMs,
  buildRouteModel,
  estimateRemainingMin,
  poiAlongPositions,
  progressFraction,
  progressStep,
  remainingM,
  vertexIndexAt,
  type RouteModel,
} from "@/domain/progress";
import { DEFAULT_GEOFENCE_SETTINGS, geofenceStep, recordManualPlay, type GeofencePoi } from "@/domain/geofence";
import { DEFAULT_DEVIATION_SETTINGS, deviationStep, dismissDeviation, type DeviationState } from "@/domain/deviation";
import { clearReminders, dueReminders, nextReminderInMs, reminderMessage, type ReminderKind } from "@/domain/reminders";
import { shouldSamplePoint } from "@/domain/outbox";
import { DEFAULT_SIMULATOR_CONFIG, createSimulatorState, simulatorStep, type SimulatorConfig } from "@/domain/gps-simulator";
import { fetchBundle, getStoredBundle, putStoredBundle } from "@/lib/offline/bundle-store";
import { initialHikeState, loadHikeState, saveHikeState, type HikeSettings, type PersistedHikeState } from "@/lib/offline/hike-state";
import { enqueueEvent, enqueuePoint, OutboxSyncer, type SyncSnapshot } from "@/lib/offline/outbox";
import { uuid } from "@/lib/offline/hash";
import type { BundleNarration, BundlePoi, HikeEventData, HikeEventKind, TripBundle } from "@/lib/offline/wire";
import { NarrationPlayer, vibrate, type PlaybackMode } from "./audio";
import { WakeLockController, type WakeLockStatus } from "./wake-lock";

export type HikePhase = "loading" | "no_bundle" | "error" | "ready" | "active" | "paused" | "finished";
export type GpsState = "idle" | "waiting" | "tracking" | "denied" | "unavailable" | "unsupported";

export interface PoiView extends BundlePoi {
  alongM: number;
  heard: boolean;
  narration: BundleNarration | null;
}

export interface ReminderNotice {
  id: string;
  kind: ReminderKind;
  title: string;
  body: string;
  at: number;
}

export interface NarrationNow {
  narration: BundleNarration;
  poiName: string | null;
  mode: PlaybackMode | "starting";
  playing: boolean;
  source: "gps" | "manual";
  at: number;
}

export interface HikeSnapshot {
  phase: HikePhase;
  error: string | null;
  tripId: string;
  demoMode: boolean;
  bundle: TripBundle | null;
  bundleSource: "download" | "online" | null;
  downloadComplete: boolean | null;
  route: RouteModel | null;
  pois: PoiView[];
  generalNarrations: BundleNarration[];
  now: number;
  startedAt: number | null;
  finishedAt: number | null;
  activeElapsedMs: number;
  lastFix: GeoFix | null;
  staleness: Staleness;
  gps: { source: "device" | "simulator"; state: GpsState; message: string | null };
  progress: {
    alongM: number;
    fraction: number;
    remainingM: number;
    vertexIndex: number;
    distanceFromRouteM: number | null;
    remainingMin: number | null;
    remainingBasis: "observed" | "planned" | "none";
  };
  deviation: DeviationState;
  reminder: ReminderNotice | null;
  nextReminders: Record<ReminderKind, number | null>;
  narration: NarrationNow | null;
  queuedNarrations: number;
  announcement: string;
  settings: HikeSettings;
  sync: SyncSnapshot;
  lastSavedAt: number | null;
  wakeLock: WakeLockStatus;
  audioUnlocked: boolean;
  okTap: { at: number; sent: boolean } | null;
  simulator: { enabled: boolean; config: SimulatorConfig };
  limitationsAcknowledged: boolean;
  startError: string | null;
  finishPending: boolean;
  finishSynced: boolean;
  gapWarning: string | null;
}

const EMPTY_SYNC: SyncSnapshot = { online: true, status: "idle", queued: 0, lastSyncAt: null, nextAttemptAt: null, message: null, dropped: 0 };
const SAVE_EVERY_MS = 5_000;
const ONLINE_BUNDLE_TIMEOUT_MS = 6_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export class HikeEngine {
  private s: PersistedHikeState | null = null;
  private bundle: TripBundle | null = null;
  private bundleSource: "download" | "online" | null = null;
  private downloadComplete: boolean | null = null;
  private route: RouteModel | null = null;
  private poiAlong: Record<string, number> = {};
  private gpois: GeofencePoi[] = [];
  private syncer: OutboxSyncer | null = null;
  private player = new NarrationPlayer();
  private wake: WakeLockController | null = null;
  private watchId: number | null = null;
  private simTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private generation = 0;
  private dirty = false;
  private lastSaveAt = 0;
  private lastSavedFixAt: number | null = null;
  private phase: HikePhase = "loading";
  private error: string | null = null;
  private gps: HikeSnapshot["gps"] = { source: "device", state: "idle", message: null };
  private distanceFromRouteM: number | null = null;
  private reminder: ReminderNotice | null = null;
  private narration: NarrationNow | null = null;
  private narrationQueue: { narration: BundleNarration; poiName: string | null; source: "gps" | "manual" }[] = [];
  private announcement = "";
  private gapWarning: string | null = null;
  private hiddenAt: number | null = null;
  private listeners = new Set<() => void>();
  private snap: HikeSnapshot;

  constructor(
    readonly tripId: string,
    readonly demoMode: boolean,
  ) {
    this.snap = this.build(Date.now());
  }

  // ---------------------------------------------------------------- store API
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  getSnapshot = () => this.snap;

  private emit() {
    this.snap = this.build(Date.now());
    for (const l of this.listeners) l();
  }

  private build(now: number): HikeSnapshot {
    const s = this.s;
    const route = this.route;
    const alongM = s?.progress.alongM ?? 0;
    const elapsed = s ? activeElapsedMs(s.startedAt, s.pauses, now, s.finishedAt) : 0;
    const rem = route ? remainingM(route, alongM) : 0;
    const est = route
      ? estimateRemainingMin({
          remainingM: rem,
          alongM,
          activeElapsedMs: elapsed,
          plannedTotalMin: this.bundle?.trip.itinerary.estimatedDurationMin ?? this.bundle?.trail.estimatedDurationMin ?? null,
          totalM: route.totalM,
        })
      : { minutes: null, basis: "none" as const };
    const triggered = s?.geofence.triggered ?? {};
    const narrations = this.bundle?.narrations ?? [];
    const sync = this.syncer?.getSnapshot() ?? EMPTY_SYNC;
    const lastOk = s?.okTaps[s.okTaps.length - 1] ?? null;
    return {
      phase: this.phase,
      error: this.error,
      tripId: this.tripId,
      demoMode: this.demoMode,
      bundle: this.bundle,
      bundleSource: this.bundleSource,
      downloadComplete: this.downloadComplete,
      route,
      pois: (this.bundle?.pois ?? []).map((p) => ({
        ...p,
        alongM: this.poiAlong[p.id] ?? 0,
        heard: !!triggered[p.id],
        narration: narrations.find((n) => n.poiId === p.id) ?? null,
      })),
      generalNarrations: narrations.filter((n) => !n.poiId || !(this.bundle?.pois ?? []).some((p) => p.id === n.poiId)),
      now,
      startedAt: s?.startedAt ?? null,
      finishedAt: s?.finishedAt ?? null,
      activeElapsedMs: elapsed,
      lastFix: s?.lastFix ?? null,
      staleness: classifyStaleness(s?.lastFix?.timestamp ?? null, now),
      gps: this.gps,
      progress: {
        alongM,
        fraction: route ? progressFraction(route, alongM) : 0,
        remainingM: rem,
        vertexIndex: route ? vertexIndexAt(route, alongM) : 0,
        distanceFromRouteM: this.distanceFromRouteM,
        remainingMin: est.minutes,
        remainingBasis: est.basis,
      },
      deviation: s?.deviation ?? { status: "on_route", offCount: 0, offSince: null, onCount: 0, promptVisible: false, snoozedUntil: null, lastPromptAt: null, lastDistanceM: null },
      reminder: this.reminder,
      nextReminders: s ? nextReminderInMs(s.reminders, elapsed, s.settings) : { hydration: null, pace_check: null },
      narration: this.narration,
      queuedNarrations: this.narrationQueue.length,
      announcement: this.announcement,
      settings: s?.settings ?? initialHikeState(this.tripId).settings,
      sync,
      lastSavedAt: this.lastSavedFixAt,
      wakeLock: this.wake?.status ?? "off",
      audioUnlocked: this.player.unlocked,
      okTap: lastOk ? { at: lastOk.at, sent: sync.lastSyncAt !== null && sync.lastSyncAt > lastOk.at && sync.queued === 0 } : null,
      simulator: { enabled: !!s?.simulator.enabled, config: s?.simulator.config ?? DEFAULT_SIMULATOR_CONFIG },
      limitationsAcknowledged: !!s?.limitationsAckAt,
      startError: s?.startError ?? null,
      finishPending: !!s?.finishPending,
      finishSynced: !!s?.finishSynced,
      gapWarning: this.gapWarning,
    };
  }

  // ---------------------------------------------------------------- lifecycle
  async init() {
    const gen = ++this.generation;
    this.phase = "loading";
    this.emit();
    try {
      const stored = await getStoredBundle(this.tripId).catch(() => undefined);
      let bundle = stored?.bundle ?? null;
      this.bundleSource = stored?.source ?? null;
      this.downloadComplete = stored?.verification?.complete ?? null;
      if (typeof navigator === "undefined" || navigator.onLine) {
        try {
          const fresh = await withTimeout(fetchBundle(this.tripId), ONLINE_BUNDLE_TIMEOUT_MS);
          bundle = fresh;
          // Keep the offline copy current (pages/audio caches are unaffected).
          await putStoredBundle(
            stored
              ? { ...stored, bundle: fresh }
              : { tripId: this.tripId, bundle: fresh, storedAt: Date.now(), source: "online", assetUrls: [], verification: null },
          ).catch(() => undefined);
          if (!stored) this.bundleSource = "online";
        } catch {
          /* offline or slow: use the stored copy */
        }
      }
      if (gen !== this.generation) return;
      if (!bundle) {
        this.phase = "no_bundle";
        this.error = "This trip isn't downloaded on this device and you appear to be offline.";
        this.emit();
        return;
      }
      this.applyBundle(bundle);
      let s = (await loadHikeState(this.tripId).catch(() => null)) ?? initialHikeState(this.tripId, bundle.trip.itinerary);
      s = this.reconcile(s, bundle);
      if (gen !== this.generation) return;
      this.s = s;
      this.lastSavedFixAt = s.lastFix?.timestamp ?? null;
      this.wake = new WakeLockController(() => this.emit());
      this.syncer = new OutboxSyncer(this.tripId, this.syncHost(), s.lastSyncAt);
      this.syncer.subscribe(() => this.emit());
      this.syncer.start();
      this.tickTimer = setInterval(() => this.tick(), 1000);
      document.addEventListener("visibilitychange", this.onVisibility);
      window.addEventListener("pagehide", this.onPageHide);
      this.phase = this.phaseFromStatus();
      if (s.status === "active" || s.status === "paused") {
        this.startLocation();
        if (s.status === "active") this.wake.request();
      }
      await this.save(true);
      this.emit();
    } catch (err) {
      if (gen !== this.generation) return;
      this.phase = "error";
      this.error = err instanceof Error ? err.message : "Could not load this hike.";
      this.emit();
    }
  }

  dispose() {
    this.generation++;
    this.stopLocation();
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.syncer?.stop();
    this.wake?.dispose();
    this.player.stop();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    if (typeof window !== "undefined") window.removeEventListener("pagehide", this.onPageHide);
    if (this.s && this.dirty) void this.save(true);
  }

  private applyBundle(bundle: TripBundle) {
    this.bundle = bundle;
    const geometry = JSON.parse(bundle.geometryJson) as { coordinates: [number, number][] };
    this.route = buildRouteModel(geometry.coordinates, bundle.trail.routeType);
    this.poiAlong = poiAlongPositions(this.route, bundle.pois);
    // Only POIs with approved narration can auto-trigger.
    this.gpois = bundle.pois
      .filter((p) => bundle.narrations.some((n) => n.poiId === p.id))
      .map((p) => ({ id: p.id, seq: p.seq, lat: p.lat, lng: p.lng, triggerRadiusM: p.triggerRadiusM, alongM: this.poiAlong[p.id] }));
  }

  /** Merge local state with what the server knows (other device, finished elsewhere). */
  private reconcile(s: PersistedHikeState, bundle: TripBundle): PersistedHikeState {
    const session = bundle.session;
    if (s.status === "not_started" && session && (session.status === "active" || session.status === "paused")) {
      s = {
        ...s,
        localSessionId: session.id,
        serverSessionId: session.id,
        startSynced: true,
        status: session.status === "paused" ? "paused" : "active",
        startedAt: Date.parse(session.startedAt),
        pauses: session.status === "paused" ? [{ start: Date.now(), end: null }] : [],
      };
    }
    if (bundle.trip.status === "completed") {
      s = {
        ...s,
        status: "finished",
        finishedAt: s.finishedAt ?? (session?.finishedAt ? Date.parse(session.finishedAt) : Date.now()),
        finishPending: false,
        finishSynced: true,
        reminders: clearReminders(s.reminders),
      };
    }
    return s;
  }

  private phaseFromStatus(): HikePhase {
    switch (this.s?.status) {
      case "active":
        return "active";
      case "paused":
        return "paused";
      case "finished":
        return "finished";
      default:
        return "ready";
    }
  }

  private syncHost() {
    return {
      session: () => {
        const s = this.s!;
        return {
          localSessionId: s.localSessionId,
          serverSessionId: s.serverSessionId,
          startSynced: s.startSynced,
          startedAt: s.startedAt,
          finishPending: s.finishPending,
          finishedAt: s.finishedAt,
          progressM: s.progress.alongM,
        };
      },
      onStartConfirmed: (session: { id: string }) => {
        this.mutate((s) => ({ ...s, serverSessionId: session.id, startSynced: true, startError: null }), true);
      },
      onStartRejected: (message: string) => {
        this.mutate((s) => ({ ...s, startError: message }), true);
      },
      onFinishConfirmed: () => {
        this.mutate((s) => ({ ...s, finishPending: false, finishSynced: true }), true);
      },
      onSynced: (at: number) => {
        this.mutate((s) => ({ ...s, lastSyncAt: at }));
      },
    };
  }

  private mutate(fn: (s: PersistedHikeState) => PersistedHikeState, saveNow = false) {
    if (!this.s) return;
    this.s = fn(this.s);
    this.dirty = true;
    if (saveNow) void this.save(true);
    this.emit();
  }

  private async save(force = false) {
    if (!this.s) return;
    const now = Date.now();
    if (!force && now - this.lastSaveAt < SAVE_EVERY_MS) return;
    this.lastSaveAt = now;
    this.dirty = false;
    try {
      await saveHikeState(this.s);
      this.lastSavedFixAt = this.s.lastFix?.timestamp ?? null;
    } catch {
      this.dirty = true;
    }
  }

  private readonly onVisibility = () => {
    if (document.visibilityState === "hidden") {
      this.hiddenAt = Date.now();
      void this.save(true);
      return;
    }
    const gapSince = Math.max(this.hiddenAt ?? 0, this.s?.lastFix?.timestamp ?? 0);
    if ((this.s?.status === "active" || this.s?.status === "paused") && this.hiddenAt && Date.now() - gapSince > 60_000) {
      this.gapWarning =
        "Location updates may have paused while the screen was off or the app was in the background. Narration and off-route prompts could not run during that time.";
    }
    this.hiddenAt = null;
    void this.syncer?.maybeFlush();
    this.emit();
  };

  private readonly onPageHide = () => {
    void this.save(true);
  };

  // ---------------------------------------------------------------- queueing
  private async queueEvent(kind: HikeEventKind, payload: HikeEventData = {}, at = new Date()): Promise<string | null> {
    try {
      const id = await enqueueEvent(this.tripId, kind, payload, at);
      void this.syncer?.notifyEnqueued();
      return id;
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- location
  private speedFactor(): number {
    return this.s?.simulator.enabled ? Math.max(1, this.s.simulator.config.speedUp) : 1;
  }

  private startLocation() {
    this.stopLocation();
    if (this.s?.simulator.enabled && this.demoMode) {
      this.startSimulator();
      return;
    }
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) {
      this.gps = { source: "device", state: "unsupported", message: "This browser cannot provide location." };
      this.emit();
      return;
    }
    this.gps = { source: "device", state: "waiting", message: "Waiting for a GPS fix…" };
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => {
        this.gps = { source: "device", state: "tracking", message: null };
        this.onFix({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
          altitudeM: pos.coords.altitude,
          timestamp: pos.timestamp,
        });
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) {
          this.gps = { source: "device", state: "denied", message: "Location permission is off. Turn it on in your browser settings to get narration and progress." };
        } else if (err.code === err.POSITION_UNAVAILABLE) {
          this.gps = { source: "device", state: "unavailable", message: "No GPS signal right now. Keep the app open with a view of the sky." };
        } else {
          this.gps = { ...this.gps, state: this.gps.state === "tracking" ? "tracking" : "waiting", message: "GPS is slow to respond…" };
        }
        this.emit();
      },
      { enableHighAccuracy: true, maximumAge: 5_000, timeout: 30_000 },
    );
    this.emit();
  }

  private stopLocation() {
    if (this.watchId !== null && typeof navigator !== "undefined") navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    if (this.simTimer) clearInterval(this.simTimer);
    this.simTimer = null;
    this.gps = { ...this.gps, state: "idle" };
  }

  private startSimulator() {
    if (!this.route || !this.s) return;
    this.gps = { source: "simulator", state: "waiting", message: "Simulated GPS" };
    if (!this.s.simulator.state) {
      const st = createSimulatorState(this.s.simulator.seed, this.s.progress.alongM);
      this.s = { ...this.s, simulator: { ...this.s.simulator, state: st } };
    }
    this.simTimer = setInterval(() => {
      if (!this.s?.simulator.state || !this.route) return;
      const cfg = this.s.simulator.config;
      // At high speed-up emit several fixes per second (≈ one per 12 m walked) so
      // geofences still see consecutive fixes inside each stop's radius.
      const substeps = Math.min(10, Math.max(1, Math.ceil((cfg.speedMps * Math.max(1, cfg.speedUp)) / 12)));
      const now = Date.now();
      for (let i = 0; i < substeps; i++) {
        if (!this.s?.simulator.state) return;
        const at = now - Math.round(((substeps - 1 - i) * 1000) / substeps);
        const r = simulatorStep(this.s.simulator.state, this.route, cfg, 1000 / substeps, at);
        this.s = { ...this.s, simulator: { ...this.s.simulator, state: r.state } };
        this.dirty = true;
        if (r.fix) {
          this.gps = { source: "simulator", state: "tracking", message: "Simulated GPS" };
          this.onFix(r.fix);
        } else {
          this.gps = { source: "simulator", state: "waiting", message: "Simulated signal loss" };
          this.emit();
        }
      }
    }, 1000);
  }

  /** Every location fix (device or simulator) flows through here. */
  onFix(fix: GeoFix) {
    const s = this.s;
    if (!s || !this.route) return;
    const now = Date.now();
    const factor = this.speedFactor();
    const a = assessFix(s.filter, fix, now, { ...DEFAULT_LOCATION_QUALITY, maxSpeedMps: DEFAULT_LOCATION_QUALITY.maxSpeedMps * factor });
    let next: PersistedHikeState = { ...s, filter: a.state };
    if (!a.accepted) {
      this.s = next;
      return;
    }
    next.lastFix = fix;
    const projection = projectOntoLine(fix, this.route.coords, this.route.cum, next.progress.alongM);
    this.distanceFromRouteM = projection.distanceFromRouteM;

    if (next.status === "active" && a.decisionGrade) {
      const pr = progressStep(next.progress, fix, this.route, { ...DEFAULT_PROGRESS_OPTIONS, maxSpeedMps: DEFAULT_PROGRESS_OPTIONS.maxSpeedMps * factor });
      next.progress = pr.state;
      const onRoute = projection.distanceFromRouteM <= DEFAULT_PROGRESS_OPTIONS.offRouteIgnoreM;
      // Time-based thresholds run in "walking time": a sped-up simulation scales them down.
      const g = geofenceStep(
        next.geofence,
        { ...fix, progressAlongM: onRoute ? next.progress.alongM : null },
        this.gpois,
        {
          ...DEFAULT_GEOFENCE_SETTINGS,
          radiusMultiplier: next.settings.triggerMultiplier,
          radiusOverrideM: next.settings.triggerOverrideM,
          cooldownMs: DEFAULT_GEOFENCE_SETTINGS.cooldownMs / factor,
          minDwellMs: DEFAULT_GEOFENCE_SETTINGS.minDwellMs / factor,
        },
      );
      next.geofence = g.state;
      const d = deviationStep(
        next.deviation,
        { distanceFromRouteM: projection.distanceFromRouteM, accuracyM: fix.accuracyM, timestamp: fix.timestamp },
        { ...DEFAULT_DEVIATION_SETTINGS, minDurationMs: DEFAULT_DEVIATION_SETTINGS.minDurationMs / factor },
      );
      next.deviation = d.state;
      this.s = next;
      for (const poiId of g.triggered) this.onPoiTriggered(poiId, "gps");
      if (d.event === "prompt") {
        void this.queueEvent("deviation_prompt", { distanceM: Math.round(projection.distanceFromRouteM) });
        this.announcement = "You may be off the route. Check the map.";
        if (next.settings.vibrate) vibrate([300, 150, 300]);
      } else if (d.event === "cleared") {
        void this.queueEvent("deviation_cleared", { distanceM: Math.round(projection.distanceFromRouteM) });
        this.announcement = "Back near the route.";
      }
      next = this.s;
    }

    if ((next.status === "active" || next.status === "paused") && shouldSamplePoint(next.lastSample, fix)) {
      next = { ...next, lastSample: { lat: fix.lat, lng: fix.lng, at: fix.timestamp } };
      void enqueuePoint(this.tripId, {
        lat: fix.lat,
        lng: fix.lng,
        accuracyM: Math.round(fix.accuracyM * 10) / 10,
        altitudeM: fix.altitudeM ?? null,
        recordedAt: new Date(fix.timestamp).toISOString(),
      })
        .then(() => this.syncer?.notifyEnqueued())
        .catch(() => undefined);
    }
    this.s = next;
    this.dirty = true;
    this.gapWarning = null;
    void this.save();
    this.emit();
  }

  // ---------------------------------------------------------------- narration
  private onPoiTriggered(poiId: string, source: "gps" | "manual") {
    const poi = this.bundle?.pois.find((p) => p.id === poiId);
    const narration = this.bundle?.narrations.find((n) => n.poiId === poiId);
    if (!narration) return;
    void this.queueEvent(source === "gps" ? "poi_triggered" : "poi_replayed", { poiId, narrationId: narration.id, source });
    this.enqueueNarration({ narration, poiName: poi?.name ?? null, source });
    if (source === "gps") {
      this.announcement = `Arrived at ${poi?.name ?? "a stop"}: ${narration.title}. The transcript is shown on screen.`;
      if (this.s?.settings.vibrate) vibrate([200, 100, 200]);
    }
  }

  private enqueueNarration(item: { narration: BundleNarration; poiName: string | null; source: "gps" | "manual" }) {
    if (item.source === "manual" || !this.narration?.playing) {
      // Manual plays interrupt; automatic ones wait for the current narration.
      this.narrationQueue = item.source === "manual" ? [] : this.narrationQueue;
      void this.playNow(item);
    } else {
      this.narrationQueue.push(item);
    }
    this.emit();
  }

  private async playNow(item: { narration: BundleNarration; poiName: string | null; source: "gps" | "manual" }) {
    const at = Date.now();
    this.narration = { ...item, mode: "starting", playing: true, at };
    this.emit();
    const muted = !!this.s?.settings.muted;
    const mode = await this.player.play(item.narration, {
      muted,
      onEnd: () => {
        if (this.narration?.at !== at) return;
        this.narration = { ...this.narration, playing: false };
        const next = this.narrationQueue.shift();
        if (next) void this.playNow(next);
        else this.emit();
      },
    });
    if (this.narration?.at === at) {
      this.narration = { ...this.narration, mode, playing: mode === "audio" || mode === "device_voice" ? this.narration.playing : false };
      this.emit();
    }
  }

  /** Manual replay / play: always available, no cooldown or GPS checks. */
  playNarration(narrationId: string) {
    const narration = this.bundle?.narrations.find((n) => n.id === narrationId);
    if (!narration) return;
    this.player.unlock();
    const poi = narration.poiId ? this.bundle?.pois.find((p) => p.id === narration.poiId) : undefined;
    if (poi && this.s) {
      this.s = { ...this.s, geofence: recordManualPlay(this.s.geofence, poi.id, Date.now()) };
      this.dirty = true;
      void this.queueEvent("poi_replayed", { poiId: poi.id, narrationId, source: "manual" });
    }
    this.enqueueNarration({ narration, poiName: poi?.name ?? null, source: "manual" });
  }

  stopNarration() {
    this.player.stop();
    this.narrationQueue = [];
    if (this.narration) this.narration = { ...this.narration, playing: false };
    this.emit();
  }

  enableAudio() {
    this.player.unlock();
    this.emit();
  }

  // ---------------------------------------------------------------- controls
  acknowledgeLimitations(ack: boolean) {
    this.mutate((s) => ({ ...s, limitationsAckAt: ack ? Date.now() : null }), true);
  }

  start() {
    if (!this.s || this.s.status !== "not_started" || !this.s.limitationsAckAt) return;
    this.player.unlock(); // inside the tap: allows narration later
    const now = Date.now();
    this.mutate(
      (s) => ({ ...s, status: "active", localSessionId: s.localSessionId ?? uuid(), startedAt: now, startSynced: false, startError: null }),
      true,
    );
    this.phase = "active";
    void this.queueEvent("start", { simulated: !!this.s.simulator.enabled || undefined }, new Date(now));
    if (this.s.simulator.enabled) void this.queueEvent("simulator_on", { simulated: true }, new Date(now));
    this.startLocation();
    this.wake?.request();
    this.emit();
  }

  pause() {
    if (this.s?.status !== "active") return;
    const now = Date.now();
    this.mutate((s) => ({ ...s, status: "paused", pauses: [...s.pauses, { start: now, end: null }] }), true);
    this.phase = "paused";
    this.reminder = null;
    void this.queueEvent("pause", {}, new Date(now));
    this.wake?.release();
    this.emit();
  }

  resume() {
    if (this.s?.status !== "paused") return;
    this.player.unlock();
    const now = Date.now();
    this.mutate(
      (s) => ({ ...s, status: "active", pauses: s.pauses.map((p, i) => (i === s.pauses.length - 1 && p.end === null ? { ...p, end: now } : p)) }),
      true,
    );
    this.phase = "active";
    void this.queueEvent("resume", {}, new Date(now));
    if (this.watchId === null && this.simTimer === null) this.startLocation();
    this.wake?.request();
    this.emit();
  }

  finish() {
    if (!this.s || (this.s.status !== "active" && this.s.status !== "paused")) return;
    const now = Date.now();
    const moving = Math.round(activeElapsedMs(this.s.startedAt, this.s.pauses, now) / 1000);
    this.mutate(
      (s) => ({
        ...s,
        status: "finished",
        finishedAt: now,
        pauses: s.pauses.map((p) => (p.end === null ? { ...p, end: now } : p)),
        reminders: clearReminders(s.reminders),
        deviation: { ...s.deviation, promptVisible: false },
        finishPending: true,
      }),
      true,
    );
    this.phase = "finished";
    this.reminder = null;
    void this.queueEvent("finish", { progressM: Math.round(this.s.progress.alongM), movingTimeSec: moving }, new Date(now));
    this.stopLocation();
    this.wake?.release();
    this.player.stop();
    this.narrationQueue = [];
    void this.syncer?.maybeFlush(true);
    this.emit();
  }

  imOkay() {
    if (!this.s) return;
    const at = Date.now();
    void this.queueEvent("checkin_ok", {}, new Date(at)).then((id) => {
      if (id) this.mutate((s) => ({ ...s, okTaps: [...s.okTaps.slice(-9), { id, at }] }), true);
    });
    this.announcement = "\"I'm okay\" saved.";
    this.emit();
  }

  dismissDeviation(reason: "fine" | "intentional") {
    if (!this.s) return;
    const now = Date.now();
    this.mutate((s) => ({ ...s, deviation: dismissDeviation(s.deviation, now, reason, DEFAULT_DEVIATION_SETTINGS) }), true);
    void this.queueEvent("deviation_dismissed", { reason });
  }

  dismissReminder() {
    this.reminder = null;
    this.emit();
  }

  updateSettings(patch: Partial<HikeSettings>) {
    this.mutate((s) => ({ ...s, settings: { ...s.settings, ...patch } }), true);
    if (patch.muted) this.player.stop();
  }

  syncNow() {
    void this.syncer?.maybeFlush(true);
  }

  // ---------------------------------------------------------------- simulator (demo mode only)
  setSimulator(patch: { enabled?: boolean; config?: Partial<SimulatorConfig> }) {
    if (!this.demoMode || !this.s) return;
    const wasEnabled = this.s.simulator.enabled;
    this.mutate(
      (s) => ({
        ...s,
        simulator: {
          ...s.simulator,
          enabled: patch.enabled ?? s.simulator.enabled,
          config: { ...s.simulator.config, ...(patch.config ?? {}) },
          state: patch.enabled === true && !wasEnabled ? createSimulatorState(s.simulator.seed, s.progress.alongM) : s.simulator.state,
        },
      }),
      true,
    );
    if (patch.enabled !== undefined && patch.enabled !== wasEnabled) {
      if (this.s.status === "active" || this.s.status === "paused") {
        void this.queueEvent(patch.enabled ? "simulator_on" : "simulator_off", { simulated: true });
        this.startLocation();
      }
    }
  }

  /** Demo: wander off the route starting 40 m ahead, to show the off-route prompt. */
  simulateDetour() {
    const along = this.s?.simulator.state?.alongM ?? this.s?.progress.alongM ?? 0;
    this.setSimulator({ config: { detour: { startAlongM: along + 40, lengthM: 450, offsetM: 110 } } });
  }

  // ---------------------------------------------------------------- ticker
  private tick() {
    const s = this.s;
    if (!s) return;
    const now = Date.now();
    if (s.status === "active") {
      const elapsed = activeElapsedMs(s.startedAt, s.pauses, now);
      const r = dueReminders(s.reminders, elapsed, s.settings);
      if (r.due.length) {
        this.s = { ...s, reminders: r.state };
        this.dirty = true;
        const kind = r.due[0];
        const route = this.route;
        const msg = reminderMessage(kind, {
          progress: route ? progressFraction(route, s.progress.alongM) : 0,
          elapsedMin: elapsed / 60_000,
          plannedTotalMin: this.bundle?.trip.itinerary.estimatedDurationMin ?? null,
          turnaroundBy: this.bundle?.trip.itinerary.turnaroundBy ?? null,
        });
        this.reminder = { id: uuid(), kind, ...msg, at: now };
        this.announcement = `${msg.title}. ${msg.body}`;
        for (const k of r.due) void this.queueEvent("reminder", { reminder: k });
        if (s.settings.vibrate) vibrate([150]);
      }
    }
    if (this.dirty) void this.save();
    this.emit();
  }
}
