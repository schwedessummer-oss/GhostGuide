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
import { DEFAULT_GEOFENCE_SETTINGS, geofenceStep, mergeHeardPois, recordManualPlay, type GeofencePoi } from "@/domain/geofence";
import { DEFAULT_DEVIATION_SETTINGS, deviationStep, dismissDeviation, type DeviationState } from "@/domain/deviation";
import { clearReminders, dueReminders, nextReminderInMs, reminderMessage, type ReminderKind } from "@/domain/reminders";
import { isSafetyEventKind, shouldSamplePoint } from "@/domain/outbox";
import { DEFAULT_SIMULATOR_CONFIG, createSimulatorState, simulatorStep, type SimulatorConfig } from "@/domain/gps-simulator";
import { closureVerdict } from "@/domain/booking";
import { isOpen } from "@/domain/checkin";
import type { CheckinStatus } from "@/domain/types";
import { localDateInZone } from "@/lib/time";
import { BundleFetchError, fetchBundleDetailed, getStoredBundle, putStoredBundle, type FetchedBundle } from "@/lib/offline/bundle-store";
import { refreshDownloadedTrip } from "@/lib/offline/download-manager";
import {
  applySyncResponse,
  beginSaveHikeState,
  initialHikeState,
  loadHikeState,
  recordDropped,
  type HikeSettings,
  type PersistedHikeState,
} from "@/lib/offline/hike-state";
import { SIGN_IN_AGAIN, currentOwnerHint, enforceDeviceOwner, purgeTripFromDevice } from "@/lib/offline/owner";
import { hikeStartWindow, startAllowed, type StartWindow } from "@/lib/offline/start-window";
import { enqueueEvent, enqueuePoint, OutboxSyncer, queuedSafetyEventIds, type SyncSnapshot } from "@/lib/offline/outbox";
import { uuid } from "@/lib/offline/hash";
import type { BundleClosure, BundleNarration, BundlePoi, HikeEventData, HikeEventKind, SyncResponse, TripBundle } from "@/lib/offline/wire";
import { NarrationPlayer, vibrate, type PlaybackMode } from "./audio";
import { WakeLockController, type WakeLockStatus } from "./wake-lock";

export type HikePhase = "loading" | "no_bundle" | "error" | "ready" | "active" | "paused" | "finished";
/**
 * Why the hike can't open: offline without a download; signed out / another
 * account on this browser (on-device data removed); session expired (401);
 * not yours (404); not booked (409); server error (5xx); too slow; storage.
 */
export type HikeErrorKind = "offline" | "signed_out" | "auth" | "not_found" | "not_bookable" | "server" | "slow" | "storage";
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

/** The trip's check-in as known on this device (bundle + extensions made here). */
export interface CheckinView {
  status: CheckinStatus;
  /** open (not finished or cancelled) when the trip data was loaded */
  open: boolean;
  /** effective expected return: the latest extension made here unless it was refused, else the server's */
  expectedReturnAt: number;
  /** the expected return Ghost Guide had when this trip data was loaded */
  serverExpectedReturnAt: number;
  graceMinutes: number;
  /** when the contact is notified if we haven't heard from the hiker */
  notifyAfter: number;
  /** the latest "Extend my trip" made on this device */
  extension: {
    id: string;
    at: number;
    newExpectedReturnAt: number;
    /** queued: on this device; sent: reached the server (outcome unknown); applied / not_applied: the check-in's answer */
    state: "queued" | "sent" | "applied" | "not_applied";
    reason: string | null;
  } | null;
}

export interface ClosureView {
  /** closures in the downloaded trip data (active now or scheduled for the booked date) */
  list: BundleClosure[];
  /** a full closure on today's date (region time zone): the hike can't be started */
  closedToday: BundleClosure | null;
  /** a full closure on the booked date */
  closedOnBookedDate: BundleClosure | null;
}

export interface HikeSnapshot {
  phase: HikePhase;
  error: string | null;
  errorKind: HikeErrorKind | null;
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
  /** latest "I'm okay": sent = no longer queued on this device (the server accepted it); failed = refused and removed */
  okTap: { at: number; sent: boolean; failed: boolean } | null;
  checkin: CheckinView | null;
  closures: ClosureView;
  /** sync problems to tell the hiker about */
  syncIssues: { dropped: number; droppedAt: number | null; reason: string | null; clockSkewMs: number };
  simulator: { enabled: boolean; config: SimulatorConfig };
  limitationsAcknowledged: boolean;
  startError: string | null;
  finishPending: boolean;
  finishSynced: boolean;
  gapWarning: string | null;
  /** may the hike start now (booked date in the region's time zone)? null until the bundle is loaded */
  startWindow: StartWindow | null;
}

const EMPTY_SYNC: SyncSnapshot = { online: true, status: "idle", queued: 0, lastSyncAt: null, nextAttemptAt: null, message: null, dropped: 0 };
const NO_CLOSURES: ClosureView = { list: [], closedToday: null, closedOnBookedDate: null };
/** An extension may move the expected return at most this far ahead (the check-in service enforces it too). */
export const MAX_EXTEND_AHEAD_MS = 24 * 3600_000;
/** ...and must be at least this far after the moment it is made. */
export const MIN_EXTEND_LEAD_MS = 5 * 60_000;
/** Routine fixes are saved at most this often; state transitions (stops heard, prompts, controls) are saved at once. */
const SAVE_EVERY_MS = 5_000;
const ONLINE_BUNDLE_TIMEOUT_MS = 6_000;
const OFFLINE_NO_DOWNLOAD = "This trip isn't downloaded on this device and you appear to be offline.";
const SLOW_NO_DOWNLOAD = "Ghost Guide's server is taking too long to respond, and this trip isn't downloaded on this device. Try again in a moment.";

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
  private errorKind: HikeErrorKind | null = null;
  private gps: HikeSnapshot["gps"] = { source: "device", state: "idle", message: null };
  private distanceFromRouteM: number | null = null;
  private reminder: ReminderNotice | null = null;
  private narration: NarrationNow | null = null;
  private narrationQueue: { narration: BundleNarration; poiName: string | null; source: "gps" | "manual" }[] = [];
  private announcement = "";
  private gapWarning: string | null = null;
  private hiddenAt: number | null = null;
  /** ids of "I'm okay" / extend / finish events still queued on this device */
  private pendingSafety = new Set<string>();
  private lastQueued = -1;
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
    const failed = new Set(s?.failedSafetyIds ?? []);
    return {
      phase: this.phase,
      error: this.error,
      errorKind: this.errorKind,
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
      okTap: lastOk ? { at: lastOk.at, sent: !this.pendingSafety.has(lastOk.id) && !failed.has(lastOk.id), failed: failed.has(lastOk.id) } : null,
      checkin: this.checkinView(),
      closures: this.closureView(now),
      syncIssues: { dropped: s?.droppedCount ?? 0, droppedAt: s?.droppedAt ?? null, reason: s?.droppedReason ?? null, clockSkewMs: s?.clockSkewMs ?? 0 },
      simulator: { enabled: !!s?.simulator.enabled, config: s?.simulator.config ?? DEFAULT_SIMULATOR_CONFIG },
      limitationsAcknowledged: !!s?.limitationsAckAt,
      startError: s?.startError ?? null,
      finishPending: !!s?.finishPending,
      finishSynced: !!s?.finishSynced,
      gapWarning: this.gapWarning,
      startWindow: this.startWindowAt(now),
    };
  }

  private checkinView(): CheckinView | null {
    const c = this.bundle?.checkin;
    if (!c) return null;
    const s = this.s;
    const serverAt = Date.parse(c.expectedReturnAt);
    const failed = new Set(s?.failedSafetyIds ?? []);
    const stateOf = (x: NonNullable<PersistedHikeState["extensions"]>[number]): NonNullable<CheckinView["extension"]>["state"] =>
      this.pendingSafety.has(x.id) ? "queued" : failed.has(x.id) ? "not_applied" : x.result === null ? "sent" : x.result.applied ? "applied" : "not_applied";
    const all = s?.extensions ?? [];
    const latest = all[all.length - 1] ?? null;
    const extension: CheckinView["extension"] = latest
      ? {
          id: latest.id,
          at: latest.at,
          newExpectedReturnAt: latest.newExpectedReturnAt,
          state: stateOf(latest),
          reason: latest.result?.reason ?? (failed.has(latest.id) ? "not accepted by the server" : null),
        }
      : null;
    // The newest extension made after this trip data was loaded (and not refused) is the newest schedule we know of.
    const generatedAt = Date.parse(this.bundle?.generatedAt ?? "") || 0;
    const current = [...all].reverse().find((x) => x.at >= generatedAt && stateOf(x) !== "not_applied");
    const effective = current ? current.newExpectedReturnAt : serverAt;
    return {
      status: c.status,
      open: isOpen(c.status),
      expectedReturnAt: effective,
      serverExpectedReturnAt: serverAt,
      graceMinutes: c.graceMinutes,
      notifyAfter: effective + c.graceMinutes * 60_000,
      extension,
    };
  }

  private closureView(now: number): ClosureView {
    const b = this.bundle;
    if (!b?.trail.closures?.length) return NO_CLOSURES;
    // Closures downloaded before `startsAt` existed were active at download time.
    const dayClosures = b.trail.closures.map((c) => ({
      severity: c.severity as "closed" | "partial" | "advisory",
      reason: c.reason,
      startsAt: new Date(c.startsAt ?? 0),
      endsAt: c.endsAt ? new Date(c.endsAt) : null,
    }));
    const tz = b.region.timezone;
    const today = localDateInZone(new Date(now), tz);
    const booked = b.trip.bookedDate ?? b.trip.plannedDate;
    const ofDay = (day: string) => {
      const closed = closureVerdict(dayClosures, day, tz).closed;
      return closed ? (b.trail.closures.find((c) => c.reason === closed.reason && c.severity === closed.severity) ?? null) : null;
    };
    return { list: b.trail.closures, closedToday: ofDay(today), closedOnBookedDate: booked ? ofDay(booked) : null };
  }

  private startWindowAt(now: number): StartWindow | null {
    const b = this.bundle;
    if (!b) return null;
    return hikeStartWindow(b.trip.bookedDate ?? b.trip.plannedDate, b.region.timezone, now);
  }

  // ---------------------------------------------------------------- lifecycle
  async init() {
    const gen = ++this.generation;
    this.phase = "loading";
    this.error = null;
    this.errorKind = null;
    this.emit();
    try {
      const stored = await getStoredBundle(this.tripId).catch(() => undefined);
      let fresh: FetchedBundle | null = null;
      let fetchError: { kind: HikeErrorKind; message: string } | null = null;
      if (typeof navigator === "undefined" || navigator.onLine) {
        try {
          fresh = await withTimeout(fetchBundleDetailed(this.tripId), ONLINE_BUNDLE_TIMEOUT_MS);
        } catch (err) {
          fetchError = err instanceof BundleFetchError ? { kind: err.kind, message: err.message } : { kind: "slow", message: SLOW_NO_DOWNLOAD };
        }
      } else {
        fetchError = { kind: "offline", message: OFFLINE_NO_DOWNLOAD };
      }
      if (gen !== this.generation) return;

      // Shared-device privacy: only data tagged for the account signed in on this
      // browser is used; anything else is removed before it can be shown.
      const confirmed = fresh?.source === "network" ? { tripId: this.tripId, ownerHint: fresh.bundle.ownerHint } : undefined;
      const check = await enforceDeviceOwner({ confirmed }).catch(() => ({ owner: currentOwnerHint(), purged: [] as string[] }));
      if (gen !== this.generation) return;
      const owner = check.owner;
      const localOk = !!stored && !check.purged.includes(this.tripId) && !!owner && (stored.bundle.ownerHint === owner || !!confirmed);
      const refused = fetchError?.kind === "not_bookable" || fetchError?.kind === "not_found";

      let bundle: TripBundle | null = null;
      if (fresh && confirmed) bundle = fresh.bundle;
      else if (refused) bundle = null; // the server says this trip can't be hiked by this account
      else if (fresh && owner && fresh.bundle.ownerHint === owner) bundle = fresh.bundle; // the service worker's offline copy
      else if (localOk) bundle = stored!.bundle;

      this.bundleSource = localOk ? stored!.source : fresh?.source === "cache" ? "download" : fresh ? "online" : null;
      this.downloadComplete = localOk ? (stored!.verification?.complete ?? null) : null;
      let reverify = false;
      if (fresh && confirmed) {
        // Keep the offline copy current. Narration audio is stored under stable keys (narration id +
        // version), so audio downloaded earlier stays usable; the download is re-verified against the
        // new data (and anything missing is fetched while online) below.
        const saved = await putStoredBundle(
          localOk
            ? { ...stored!, bundle: fresh.bundle }
            : { tripId: this.tripId, bundle: fresh.bundle, storedAt: Date.now(), source: "online", assetUrls: [], verification: null },
        ).then(
          () => true,
          () => false,
        );
        if (saved && localOk && stored!.source === "download") {
          reverify = true;
          this.downloadComplete = null; // re-checking
        }
      }
      if (gen !== this.generation) return;
      if (!bundle) {
        let removed = check.purged.includes(this.tripId) || (!!stored && !localOk);
        if (fresh?.source === "cache") {
          // The service worker still had another account's copy: remove it too.
          await purgeTripFromDevice(this.tripId);
          removed = true;
        }
        if (gen !== this.generation) return;
        let e: { kind: HikeErrorKind; message: string };
        if (fetchError && fetchError.kind !== "offline") e = fetchError.kind === "auth" && removed ? { kind: "auth", message: `${SIGN_IN_AGAIN}.` } : fetchError;
        else if (removed) e = { kind: "signed_out", message: `${SIGN_IN_AGAIN}.` };
        else e = { kind: "offline", message: OFFLINE_NO_DOWNLOAD };
        this.phase = "no_bundle";
        this.errorKind = e.kind;
        this.error = e.message;
        this.emit();
        return;
      }
      this.applyBundle(bundle);
      if (reverify) {
        void refreshDownloadedTrip(this.tripId)
          .then((v) => {
            if (gen !== this.generation) return;
            this.downloadComplete = v?.complete ?? false;
            this.emit();
          })
          .catch(() => {
            if (gen === this.generation) this.downloadComplete = false;
            this.emit();
          });
      }
      this.pendingSafety = await queuedSafetyEventIds(this.tripId).catch(() => new Set<string>());
      let s = await loadHikeState(this.tripId).catch(() => null);
      if (s && !confirmed && s.ownerHint !== bundle.ownerHint) s = null; // never resume someone else's hike
      s = { ...(s ?? initialHikeState(this.tripId, bundle.trip.itinerary)), ownerHint: bundle.ownerHint };
      s = this.reconcile(s, bundle);
      if (gen !== this.generation) return;
      this.s = s;
      this.lastSavedFixAt = s.lastFix?.timestamp ?? null;
      this.wake = new WakeLockController(() => this.emit());
      this.syncer = new OutboxSyncer(this.tripId, this.syncHost(), s.lastSyncAt);
      this.syncer.subscribe((snap) => {
        // The queue changed (sent here, by another tab or by the service worker): re-read what is still pending.
        if (snap.queued !== this.lastQueued) {
          this.lastQueued = snap.queued;
          void this.refreshPendingSafety();
        }
        this.emit();
      });
      this.syncer.start();
      this.tickTimer = setInterval(() => this.tick(), 1000);
      document.addEventListener("visibilitychange", this.onVisibility);
      window.addEventListener("pagehide", this.onPageHide);
      this.phase = this.phaseFromStatus();
      // State is restored (and saved) before any new fix is processed.
      await this.save(true);
      if (gen !== this.generation) return;
      if (s.status === "active" || s.status === "paused") {
        this.startLocation();
        if (s.status === "active") this.wake.request();
      }
      this.emit();
    } catch (err) {
      if (gen !== this.generation) return;
      this.phase = "error";
      this.errorKind = "storage";
      this.error = err instanceof Error ? err.message : "Could not load this hike.";
      this.emit();
    }
  }

  /** Try loading again (after a server error, a slow response or signing in). */
  retry() {
    if (this.phase !== "no_bundle" && this.phase !== "error") return;
    void this.init();
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
    // Stops already narrated in this session (reported by the server) are never auto-played again.
    if (session?.heardPoiIds?.length && (s.serverSessionId === session.id || s.localSessionId === session.id)) {
      s = { ...s, geofence: mergeHeardPois(s.geofence, session.heardPoiIds, Date.now()) };
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
          demoStartAnyway: !!s.demoStartAnyway,
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
        void this.markCompletedOnDevice();
      },
      onSynced: (at: number) => {
        this.mutate((s) => ({ ...s, lastSyncAt: at }));
      },
      onSyncResponse: (res: SyncResponse) => {
        for (const id of [...res.acceptedEventIds, ...res.rejected.map((r) => r.id)]) this.pendingSafety.delete(id);
        this.mutate((s) => applySyncResponse(s, res), true);
      },
      onDropped: (info: { count: number; safety: number; reason: string; ids: string[] }) => {
        for (const id of info.ids) this.pendingSafety.delete(id);
        this.mutate((s) => recordDropped(s, info), true);
      },
    };
  }

  private async refreshPendingSafety() {
    try {
      this.pendingSafety = await queuedSafetyEventIds(this.tripId);
      this.emit();
    } catch {
      /* storage unavailable: keep what we have */
    }
  }

  private mutate(fn: (s: PersistedHikeState) => PersistedHikeState, saveNow = false) {
    if (!this.s) return;
    this.s = fn(this.s);
    this.dirty = true;
    if (saveNow) void this.save(true);
    this.emit();
  }

  /**
   * Persist the hike state: a synchronous localStorage mirror first (it
   * survives a reload or navigation that interrupts IndexedDB), then
   * IndexedDB. Routine saves are throttled; `force` saves at once.
   */
  private async save(force = false) {
    if (!this.s) return;
    const now = Date.now();
    if (!force && now - this.lastSaveAt < SAVE_EVERY_MS) return;
    this.lastSaveAt = now;
    this.dirty = false;
    const state = this.s;
    const savedFix = state.lastFix?.timestamp ?? null;
    let save: ReturnType<typeof beginSaveHikeState>;
    try {
      save = beginSaveHikeState(state, now); // the mirror is written before this returns
    } catch {
      this.dirty = true;
      return;
    }
    if (save.mirrored) this.markSaved(savedFix);
    try {
      await save.committed;
      this.markSaved(savedFix);
    } catch {
      this.dirty = true;
    }
  }

  /** "Saved on device" only moves forward, and only once a copy really is on the device. */
  private markSaved(fixAt: number | null) {
    if (fixAt === null || (this.lastSavedFixAt !== null && fixAt <= this.lastSavedFixAt)) return;
    this.lastSavedFixAt = fixAt;
    this.emit();
  }

  /** The trip is finished on the server: the offline copy says so too (the offline list leaves it out). */
  private async markCompletedOnDevice() {
    if (this.bundle) this.bundle = { ...this.bundle, trip: { ...this.bundle.trip, status: "completed" } };
    const stored = await getStoredBundle(this.tripId).catch(() => undefined);
    if (stored) await putStoredBundle({ ...stored, bundle: { ...stored.bundle, trip: { ...stored.bundle.trip, status: "completed" } } }).catch(() => undefined);
    this.emit();
  }

  private readonly onVisibility = () => {
    if (document.visibilityState === "hidden") {
      this.hiddenAt = Date.now();
      void this.save(true);
      return;
    }
    void this.refreshPendingSafety();
    const gapSince = Math.max(this.hiddenAt ?? 0, this.s?.lastFix?.timestamp ?? 0);
    if ((this.s?.status === "active" || this.s?.status === "paused") && this.hiddenAt && Date.now() - gapSince > 60_000) {
      this.gapWarning =
        "Location updates may have paused while the screen was off or the app was in the background. Narration and off-route prompts could not run during that time.";
    }
    this.hiddenAt = null;
    void this.syncer?.maybeFlush();
    this.emit();
  };

  // Reload, the Help link and offline navigations are full page loads: save synchronously (mirror) on the way out.
  private readonly onPageHide = () => {
    void this.save(true);
  };

  // ---------------------------------------------------------------- queueing
  private async queueEvent(kind: HikeEventKind, payload: HikeEventData = {}, at = new Date()): Promise<string | null> {
    try {
      const id = await enqueueEvent(this.tripId, kind, payload, at);
      if (isSafetyEventKind(kind)) this.pendingSafety.add(id);
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
      if (this.s.status === "paused") {
        // A paused (simulated) hiker stands still: repeat the current position, don't walk on.
        const last = this.s.lastFix;
        if (last && !cfg.signalLost) {
          this.gps = { source: "simulator", state: "tracking", message: "Simulated GPS" };
          this.onFix({ ...last, timestamp: Date.now() });
        }
        return;
      }
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
    // A stop heard or an off-route prompt must never be lost to a reload: save those at once.
    let important = this.lastSavedFixAt === null;
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
      if (g.triggered.length || d.event) important = true;
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
    void this.save(important);
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
      void this.save(true); // heard now: a reload must not make it "Upcoming" (and auto-play it) again
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

  /**
   * Start the hike — on the booked date only (region time zone). In demo mode
   * the hiker may explicitly choose "Start anyway (demo)" on another day.
   */
  start(opts: { demoStartAnyway?: boolean } = {}) {
    if (!this.s || this.s.status !== "not_started" || !this.s.limitationsAckAt) return;
    const now = Date.now();
    // A trail fully closed today can never be started — not even in a demo.
    if (this.closureView(now).closedToday) return;
    const w = this.startWindowAt(now);
    const offDate = !!w && !startAllowed(w);
    const anyway = !!opts.demoStartAnyway && this.demoMode;
    if (offDate && !anyway) return;
    this.player.unlock(); // inside the tap: allows narration later
    this.mutate(
      (s) => ({
        ...s,
        status: "active",
        localSessionId: s.localSessionId ?? uuid(),
        startedAt: now,
        startSynced: false,
        startError: null,
        demoStartAnyway: offDate && anyway,
      }),
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

  /**
   * "Extend my trip": queue a checkin_extend event with the new expected return
   * (works offline; it takes effect only once it reaches Ghost Guide). Returns
   * an error message, or null when queued.
   */
  async extendCheckin(newExpectedReturnAt: number): Promise<string | null> {
    const c = this.checkinView();
    if (!this.s || !c || !c.open) return "There is no active check-in for this trip.";
    if (this.s.status !== "active" && this.s.status !== "paused") return "Start the hike first.";
    const now = Date.now();
    if (!Number.isFinite(newExpectedReturnAt) || newExpectedReturnAt < now + MIN_EXTEND_LEAD_MS) return "Choose a time at least 5 minutes from now.";
    if (newExpectedReturnAt > now + MAX_EXTEND_AHEAD_MS) return "Choose a time within the next 24 hours.";
    const id = await this.queueEvent("checkin_extend", { newExpectedReturnAt: new Date(newExpectedReturnAt).toISOString() }, new Date(now));
    if (!id) return "Couldn't save this on the device. Try again.";
    this.mutate((s) => ({ ...s, extensions: [...(s.extensions ?? []).slice(-9), { id, at: now, newExpectedReturnAt, result: null }] }), true);
    this.announcement = this.syncer?.getSnapshot().online
      ? "Extension saved. Sending it to Ghost Guide."
      : "Extension saved on this device. It will be sent when you're back online.";
    this.emit();
    return null;
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
