/**
 * Screen Wake Lock (keep the screen on during an active hike) where the
 * browser supports it. The OS can still release it (low battery, tab
 * hidden); the status is shown honestly and re-requested when the page
 * becomes visible again.
 */
export type WakeLockStatus = "unsupported" | "off" | "active" | "released" | "error";

interface WakeLockSentinelLike {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: "release", cb: () => void): void;
}

export function wakeLockSupported(): boolean {
  return typeof navigator !== "undefined" && "wakeLock" in navigator;
}

export class WakeLockController {
  status: WakeLockStatus = wakeLockSupported() ? "off" : "unsupported";
  private sentinel: WakeLockSentinelLike | null = null;
  private wanted = false;
  private readonly onVisible = () => {
    if (document.visibilityState === "visible" && this.wanted && !this.sentinel) void this.acquire();
  };

  constructor(private readonly onChange: () => void) {
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisible);
  }

  private set(status: WakeLockStatus) {
    this.status = status;
    this.onChange();
  }

  private async acquire() {
    if (!wakeLockSupported() || document.visibilityState !== "visible") return;
    try {
      const s = (await (navigator as unknown as { wakeLock: { request(t: "screen"): Promise<WakeLockSentinelLike> } }).wakeLock.request(
        "screen",
      )) as WakeLockSentinelLike;
      this.sentinel = s;
      s.addEventListener("release", () => {
        this.sentinel = null;
        this.set(this.wanted ? "released" : "off");
      });
      this.set("active");
    } catch {
      this.set("error");
    }
  }

  request() {
    this.wanted = true;
    if (this.status === "unsupported") return;
    if (!this.sentinel) void this.acquire();
  }

  release() {
    this.wanted = false;
    const s = this.sentinel;
    this.sentinel = null;
    if (s && !s.released) void s.release().catch(() => undefined);
    if (this.status !== "unsupported") this.set("off");
  }

  dispose() {
    this.release();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisible);
  }
}
