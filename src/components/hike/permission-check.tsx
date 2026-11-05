"use client";

import { useEffect, useState } from "react";
import { Bell, HardDrive, LocateFixed, MonitorSmartphone, Sun, Volume2 } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { accuracyGrade } from "@/domain/location-quality";
import { playTestTone, speakTest, speechAvailable } from "./engine/audio";
import { wakeLockSupported } from "./engine/wake-lock";

type PermState = "granted" | "prompt" | "denied" | "unsupported" | "unknown";

function Row({ icon: Icon, title, status, tone, children }: { icon: typeof Bell; title: string; status: string; tone: "forest" | "amber" | "red" | "neutral"; children?: React.ReactNode }) {
  return (
    <li className="rounded-xl border border-sand-200 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="flex items-center gap-2 font-semibold">
          <Icon aria-hidden className="size-5 text-forest-700" /> {title}
        </p>
        <Badge tone={tone}>{status}</Badge>
      </div>
      {children ? <div className="mt-2 space-y-2 text-[0.95rem]">{children}</div> : null}
    </li>
  );
}

const fmtBytes = (n: number) => (n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

/**
 * Pre-hike permission & capability check: location, audio, screen wake
 * lock, notifications (optional) and offline storage. Results are honest
 * about what each capability can and cannot do.
 */
export function PermissionCheck() {
  const [geo, setGeo] = useState<PermState>("unknown");
  const [fix, setFix] = useState<{ accuracyM: number; tookMs: number } | null>(null);
  const [gpsMsg, setGpsMsg] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [audioMsg, setAudioMsg] = useState<string | null>(null);
  const [notif, setNotif] = useState<PermState>("unknown");
  const [storage, setStorage] = useState<{ usage: number; quota: number; persisted: boolean | null } | null>(null);
  const [storageMsg, setStorageMsg] = useState<string | null>(null);
  const [caps, setCaps] = useState<{ wakeLock: boolean; sw: boolean; tts: boolean } | null>(null);

  useEffect(() => {
    let alive = true;
    let status: PermissionStatus | null = null;
    const onChange = () => status && alive && setGeo(status.state as PermState);
    (async () => {
      if (!("geolocation" in navigator)) setGeo("unsupported");
      else if (navigator.permissions?.query) {
        try {
          status = await navigator.permissions.query({ name: "geolocation" });
          if (!alive) return;
          setGeo(status.state as PermState);
          status.addEventListener("change", onChange);
        } catch {
          setGeo("unknown");
        }
      }
      setNotif(typeof Notification === "undefined" ? "unsupported" : Notification.permission === "default" ? "prompt" : (Notification.permission as PermState));
      setCaps({ wakeLock: wakeLockSupported(), sw: "serviceWorker" in navigator, tts: speechAvailable() });
      if (navigator.storage?.estimate) {
        const est = await navigator.storage.estimate().catch(() => null);
        const persisted = navigator.storage.persisted ? await navigator.storage.persisted().catch(() => null) : null;
        if (alive && est) setStorage({ usage: est.usage ?? 0, quota: est.quota ?? 0, persisted });
      }
    })();
    return () => {
      alive = false;
      status?.removeEventListener("change", onChange);
    };
  }, []);

  const testGps = () => {
    if (!("geolocation" in navigator)) return;
    setTesting(true);
    setGpsMsg("Getting a fix… go outside or near a window for the best result.");
    const t0 = performance.now();
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setTesting(false);
        setGeo("granted");
        setFix({ accuracyM: pos.coords.accuracy, tookMs: performance.now() - t0 });
        setGpsMsg(null);
      },
      (err) => {
        setTesting(false);
        if (err.code === err.PERMISSION_DENIED) {
          setGeo("denied");
          setGpsMsg("Location is blocked for this site. Allow it in your browser's site settings, then test again.");
        } else setGpsMsg("No fix yet. GPS can take a minute outdoors; try again with a view of the sky.");
      },
      { enableHighAccuracy: true, timeout: 45_000, maximumAge: 0 },
    );
  };

  const testAudio = async () => {
    const tone = await playTestTone();
    const voice = speakTest("This is Ghost Guide's device voice.");
    setAudioMsg(
      tone || voice
        ? `${tone ? "Played a test tone" : "Couldn't play a tone"}${voice ? " and spoke a test phrase with the device voice" : " (no device voice available — transcripts will be shown instead)"}. Didn't hear it? Check your volume and silent switch.`
        : "This browser could not play audio. Transcripts will still be shown.",
    );
  };

  const askNotifications = async () => {
    if (typeof Notification === "undefined") return;
    const r = await Notification.requestPermission().catch(() => "denied" as NotificationPermission);
    setNotif(r === "default" ? "prompt" : (r as PermState));
  };

  const askPersist = async () => {
    if (!navigator.storage?.persist) {
      setStorageMsg("This browser can't promise to keep offline data.");
      return;
    }
    const ok = await navigator.storage.persist().catch(() => false);
    setStorage((s) => (s ? { ...s, persisted: ok } : s));
    setStorageMsg(ok ? "Your browser agreed to keep Ghost Guide's offline data." : "Your browser didn't agree. Downloads can still be removed under storage pressure — re-check on the morning of your hike.");
  };

  const geoTone = geo === "granted" ? "forest" : geo === "denied" || geo === "unsupported" ? "red" : "amber";
  const geoLabel = { granted: "Allowed", prompt: "Will ask", denied: "Blocked", unsupported: "Not available", unknown: "Unknown" }[geo];
  return (
    <div aria-live="polite">
      <ul className="space-y-3">
        <Row icon={LocateFixed} title="Location (GPS)" status={geoLabel} tone={geoTone}>
          <p className="text-muted">Needed for progress, story triggers and off-route prompts. Only used while the hike screen is open.</p>
          <Button variant="secondary" onClick={testGps} disabled={testing || geo === "unsupported"} data-testid="perm-test-gps">
            {testing ? "Testing GPS…" : "Test GPS"}
          </Button>
          {fix ? (
            <p data-testid="perm-gps-result">
              Got a fix in {(fix.tookMs / 1000).toFixed(1)} s with accuracy ± {Math.round(fix.accuracyM)} m ({accuracyGrade(fix.accuracyM)}).
              {fix.accuracyM > 35 ? " That's not precise enough for story triggers yet — accuracy usually improves outdoors after a minute." : ""}
            </p>
          ) : null}
          {gpsMsg ? <p className="text-muted">{gpsMsg}</p> : null}
        </Row>
        <Row icon={Volume2} title="Sound" status={caps ? (caps.tts ? "Device voice available" : "No device voice") : "Checking…"} tone={caps?.tts ? "forest" : "amber"}>
          <p className="text-muted">Stories play through your speaker or headphones. Every story also has a written transcript.</p>
          <Button variant="secondary" onClick={testAudio}>
            Play test sound
          </Button>
          {audioMsg ? <p>{audioMsg}</p> : null}
        </Row>
        <Row icon={Sun} title="Keep screen on" status={caps ? (caps.wakeLock ? "Supported" : "Not supported") : "Checking…"} tone={caps?.wakeLock ? "forest" : "amber"}>
          <p className="text-muted">
            {caps?.wakeLock
              ? "We'll ask your phone to keep the screen on during the hike. Your phone can still turn it off (for example on low battery)."
              : "This browser can't keep the screen on. Set a longer auto-lock time in your phone settings for the hike."}
          </p>
        </Row>
        <Row
          icon={Bell}
          title="Notifications (optional)"
          status={{ granted: "Allowed", prompt: "Not set", denied: "Blocked", unsupported: "Not available", unknown: "Unknown" }[notif]}
          tone={notif === "granted" ? "forest" : "neutral"}
        >
          <p className="text-muted">
            Not required. Reminders appear inside the app while it&apos;s open; notifications without signal or with the app closed are not
            guaranteed, and Ghost Guide never relies on them for safety.
          </p>
          {notif === "prompt" ? (
            <Button variant="secondary" onClick={askNotifications}>
              Allow notifications
            </Button>
          ) : null}
        </Row>
        <Row
          icon={HardDrive}
          title="Offline storage"
          status={storage ? (storage.persisted ? "Kept by browser" : "May be cleared") : "Checking…"}
          tone={storage?.persisted ? "forest" : "amber"}
        >
          {storage ? (
            <p className="text-muted">
              Using {fmtBytes(storage.usage)} of about {fmtBytes(storage.quota)} available to this site.
            </p>
          ) : null}
          {storage && !storage.persisted ? (
            <Button variant="secondary" onClick={askPersist}>
              Ask browser to keep offline data
            </Button>
          ) : null}
          {storageMsg ? <p>{storageMsg}</p> : null}
        </Row>
        <Row
          icon={MonitorSmartphone}
          title="Offline pages"
          status={caps ? (caps.sw ? "Supported" : "Not supported") : "Checking…"}
          tone={caps?.sw ? "forest" : "red"}
        >
          {caps && !caps.sw ? <p>This browser can&apos;t save pages for offline use. Use a current version of Chrome, Safari, Edge or Firefox.</p> : null}
        </Row>
      </ul>
    </div>
  );
}
