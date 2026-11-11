/**
 * Narration playback for the hike screen.
 *  - An approved recording plays from the offline cache (fetched as a blob,
 *    which avoids media range-request problems with service-worker caches).
 *  - Otherwise the approved transcript is read by the DEVICE VOICE
 *    (SpeechSynthesis) — labelled as such in the UI.
 *  - The transcript is always shown, so audio is never the only channel.
 * Browsers only allow audio after a user gesture: call unlock() from a tap.
 * Audio may stop when the screen locks; that is a browser limitation.
 */
import { audioCacheKey } from "@/domain/offline-manifest";
import type { BundleNarration } from "@/lib/offline/wire";

/**
 * Where to fetch a narration's recording, in order: the stable on-device key
 * the download stored it under (answered only by the service worker, from the
 * trip cache — unaffected by the bundle re-signing audio URLs), then the
 * signed URL from the bundle.
 */
export function audioSources(n: Pick<BundleNarration, "id" | "version" | "audioUrl">, swControlled: boolean): string[] {
  if (!n.audioUrl) return [];
  return swControlled ? [audioCacheKey(n.id, n.version), n.audioUrl] : [n.audioUrl];
}

async function fetchFirstAudio(urls: string[]): Promise<Blob> {
  for (const url of urls) {
    try {
      const res = await fetch(url, { credentials: "same-origin" });
      if (res.ok) return await res.blob();
    } catch {
      /* try the next source */
    }
  }
  throw new Error("audio unavailable");
}

export type PlaybackMode = "audio" | "device_voice" | "text_only" | "muted";

export function speechAvailable(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";
}

// 0.1 s of silence (WAV) used to unlock HTMLAudioElement playback on iOS.
const SILENCE =
  "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";

export class NarrationPlayer {
  private el: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;
  private token = 0;
  unlocked = false;

  /** Must be called synchronously inside a user gesture (tap). */
  unlock() {
    try {
      if (!this.el) this.el = new Audio();
      this.el.src = SILENCE;
      void this.el.play().catch(() => undefined);
      if (speechAvailable()) {
        const u = new SpeechSynthesisUtterance("");
        u.volume = 0;
        window.speechSynthesis.speak(u);
      }
      this.unlocked = true;
    } catch {
      /* ignore: playback will report text-only */
    }
  }

  stop() {
    this.token++;
    try {
      if (this.el) {
        this.el.onended = null;
        this.el.onerror = null;
        this.el.pause();
      }
      if (speechAvailable()) window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
  }

  /**
   * Play a narration. Resolves with the mode actually used once playback has
   * STARTED; `onEnd` fires when it finishes (or fails).
   */
  async play(n: BundleNarration, opts: { muted: boolean; onEnd: () => void }): Promise<PlaybackMode> {
    this.stop();
    const token = ++this.token;
    if (opts.muted) {
      opts.onEnd();
      return "muted";
    }
    if (n.audioUrl) {
      try {
        const swControlled = typeof navigator !== "undefined" && !!navigator.serviceWorker?.controller;
        const blob = await fetchFirstAudio(audioSources(n, swControlled));
        if (token !== this.token) return "audio";
        this.objectUrl = URL.createObjectURL(blob);
        if (!this.el) this.el = new Audio();
        const el = this.el;
        el.src = this.objectUrl;
        el.onended = () => token === this.token && opts.onEnd();
        el.onerror = () => token === this.token && opts.onEnd();
        await el.play();
        return "audio";
      } catch {
        /* fall back to the device voice */
      }
    }
    if (speechAvailable()) {
      try {
        const u = new SpeechSynthesisUtterance(`${n.title}. ${n.transcript}`);
        u.rate = 1;
        u.onend = () => token === this.token && opts.onEnd();
        u.onerror = () => token === this.token && opts.onEnd();
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
        return "device_voice";
      } catch {
        /* fall through */
      }
    }
    opts.onEnd();
    return "text_only";
  }
}

/** Short test tone (Web Audio). Resolves true if it could play. */
export async function playTestTone(): Promise<boolean> {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return false;
    const ctx = new Ctx();
    await ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.6);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.65);
    setTimeout(() => void ctx.close().catch(() => undefined), 1000);
    return true;
  } catch {
    return false;
  }
}

/** Speak a short test phrase with the device voice. */
export function speakTest(text: string): boolean {
  if (!speechAvailable()) return false;
  try {
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
    return true;
  } catch {
    return false;
  }
}

export function vibrate(pattern: number[]) {
  try {
    if (typeof navigator !== "undefined" && "vibrate" in navigator) navigator.vibrate(pattern);
  } catch {
    /* unsupported */
  }
}
