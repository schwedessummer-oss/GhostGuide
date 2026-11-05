/**
 * Hydration and pace-check reminders during an active hike (pure, no I/O).
 *
 * Reminders count ACTIVE time (pauses do not advance them), can be changed
 * or turned off by the hiker, and stop for good when the hike finishes.
 * They are general prompts, not personalised medical advice.
 */
export type ReminderKind = "hydration" | "pace_check";

export interface ReminderSettings {
  /** minutes of active hiking between hydration reminders; null = off */
  hydrationEveryMin: number | null;
  /** minutes of active hiking between pace checks; null = off */
  paceCheckEveryMin: number | null;
}

export const REMINDER_MIN_INTERVAL = 10;
export const REMINDER_MAX_INTERVAL = 180;
export const HYDRATION_CHOICES = [20, 30, 40, 45, 60, 90] as const;
export const PACE_CHOICES = [30, 45, 60, 90] as const;

export const REMINDER_DISCLAIMER = "General reminder, not medical advice. Listen to your body and your group, and turn back if you need to.";

export interface ReminderState {
  /** active-elapsed ms at which each reminder last fired (0 = hike start) */
  lastHydrationAtMs: number;
  lastPaceAtMs: number;
  cleared: boolean;
}

export const INITIAL_REMINDER_STATE: ReminderState = { lastHydrationAtMs: 0, lastPaceAtMs: 0, cleared: false };

export function normalizeInterval(min: number | null | undefined): number | null {
  if (min == null || !Number.isFinite(min) || min <= 0) return null;
  return Math.min(REMINDER_MAX_INTERVAL, Math.max(REMINDER_MIN_INTERVAL, Math.round(min)));
}

/** Defaults come from the itinerary's cadence (itinerary.reminders). */
export function defaultReminderSettings(itineraryReminders?: Partial<{ hydrationEveryMin: number; paceCheckEveryMin: number }> | null): ReminderSettings {
  return {
    hydrationEveryMin: normalizeInterval(itineraryReminders?.hydrationEveryMin ?? 40),
    paceCheckEveryMin: normalizeInterval(itineraryReminders?.paceCheckEveryMin ?? 45),
  };
}

/**
 * Which reminders are due at `activeElapsedMs`. At most one per kind; the
 * next one is counted from when this one fired (no burst after a long gap).
 */
export function dueReminders(
  state: ReminderState,
  activeElapsedMs: number,
  settings: ReminderSettings,
): { due: ReminderKind[]; state: ReminderState } {
  if (state.cleared) return { due: [], state };
  const due: ReminderKind[] = [];
  const next = { ...state };
  const h = normalizeInterval(settings.hydrationEveryMin);
  if (h !== null && activeElapsedMs - state.lastHydrationAtMs >= h * 60_000) {
    due.push("hydration");
    next.lastHydrationAtMs = activeElapsedMs;
  }
  const p = normalizeInterval(settings.paceCheckEveryMin);
  if (p !== null && activeElapsedMs - state.lastPaceAtMs >= p * 60_000) {
    due.push("pace_check");
    next.lastPaceAtMs = activeElapsedMs;
  }
  return { due, state: next };
}

/** Milliseconds of active hiking until each reminder (null when off or cleared). */
export function nextReminderInMs(state: ReminderState, activeElapsedMs: number, settings: ReminderSettings): Record<ReminderKind, number | null> {
  if (state.cleared) return { hydration: null, pace_check: null };
  const h = normalizeInterval(settings.hydrationEveryMin);
  const p = normalizeInterval(settings.paceCheckEveryMin);
  return {
    hydration: h === null ? null : Math.max(0, state.lastHydrationAtMs + h * 60_000 - activeElapsedMs),
    pace_check: p === null ? null : Math.max(0, state.lastPaceAtMs + p * 60_000 - activeElapsedMs),
  };
}

/** Finishing the hike clears every reminder permanently. */
export function clearReminders(state: ReminderState): ReminderState {
  return { ...state, cleared: true };
}

export interface PaceContext {
  /** fraction of the route completed, 0..1 */
  progress: number;
  /** active minutes so far */
  elapsedMin: number;
  /** planned total minutes (estimate), if known */
  plannedTotalMin: number | null;
  turnaroundBy?: string | null;
}

/** General, non-medical wording for a reminder. */
export function reminderMessage(kind: ReminderKind, ctx?: PaceContext): { title: string; body: string } {
  if (kind === "hydration") {
    return { title: "Water break?", body: "Consider taking a drink of water, and a snack if you need one." };
  }
  const pct = ctx ? Math.round(ctx.progress * 100) : null;
  let body = "Check your pace against your plan and the time of day.";
  if (ctx && pct !== null) {
    body = `You're about ${pct}% along the route after ${Math.round(ctx.elapsedMin)} min of hiking.`;
    if (ctx.plannedTotalMin) {
      const plannedPct = Math.min(100, Math.round((ctx.elapsedMin / ctx.plannedTotalMin) * 100));
      body += ` Your plan estimated about ${plannedPct}% by now.`;
    }
    body += " Consider whether you have enough time and energy to finish.";
  }
  if (ctx?.turnaroundBy) body += ` Your itinerary suggests turning around by ${ctx.turnaroundBy}.`;
  return { title: "Pace check", body };
}
