"use client";

import { useMemo, useSyncExternalStore } from "react";
import { CheckSquare } from "lucide-react";

export const CHECKLIST_ITEMS = [
  { id: "water", label: "Water", hint: "More than you think you need, plus a way to treat more if the route has sources." },
  { id: "layers", label: "Warm and waterproof layers", hint: "Weather changes quickly, especially on ridges and passes." },
  { id: "food", label: "Food and snacks", hint: "Enough for the whole day plus a little extra." },
  { id: "navigation", label: "Backup navigation", hint: "A paper map (and compass) or another device — and know how to use it." },
  { id: "light", label: "Headlamp or flashlight", hint: "Even on short hikes: delays happen." },
  { id: "first_aid", label: "First-aid kit", hint: "Including blister care and any personal medication." },
  { id: "phone", label: "Phone charged + battery pack", hint: "GPS and keeping the screen on use a lot of battery." },
  { id: "tell_someone", label: "Told someone your plan", hint: "Where you're going and when you expect to be back." },
] as const;

const key = (tripId: string) => `gg-checklist-${tripId}`;
const EVENT = "gg-checklist-change";

function subscribe(cb: () => void) {
  window.addEventListener("storage", cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener("storage", cb);
    window.removeEventListener(EVENT, cb);
  };
}

function read(tripId: string): string | null {
  try {
    return window.localStorage.getItem(key(tripId));
  } catch {
    return null;
  }
}

/** Pre-hike checklist. Ticks are remembered on this device only (a personal convenience). */
export function PrepareChecklist({ tripId }: { tripId: string }) {
  const raw = useSyncExternalStore(
    subscribe,
    () => read(tripId),
    () => null,
  );
  const checked = useMemo(() => {
    try {
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set<string>();
    }
  }, [raw]);

  const toggle = (id: string, on: boolean) => {
    const next = new Set(checked);
    if (on) next.add(id);
    else next.delete(id);
    try {
      window.localStorage.setItem(key(tripId), JSON.stringify([...next]));
    } catch {
      /* storage unavailable: the tick just won't be remembered */
    }
    window.dispatchEvent(new Event(EVENT));
  };

  const done = CHECKLIST_ITEMS.filter((i) => checked.has(i.id)).length;
  return (
    <div>
      <p className="flex items-center gap-2 text-sm text-muted" aria-live="polite">
        <CheckSquare aria-hidden className="size-4" /> {done} of {CHECKLIST_ITEMS.length} ready
      </p>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2">
        {CHECKLIST_ITEMS.map((item) => (
          <li key={item.id}>
            <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border border-sand-200 p-3 has-[:checked]:border-forest-600 has-[:checked]:bg-forest-50">
              <input
                type="checkbox"
                className="mt-1 size-5 accent-forest-700"
                checked={checked.has(item.id)}
                onChange={(e) => toggle(item.id, e.target.checked)}
              />
              <span>
                <span className="block font-semibold">{item.label}</span>
                <span className="block text-sm text-muted">{item.hint}</span>
              </span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
