"use client";

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, CloudDownload, RefreshCw, Trash2, XCircle } from "lucide-react";
import { Alert, Button } from "@/components/ui";
import { getStoredBundle, type DownloadVerification } from "@/lib/offline/bundle-store";
import { downloadTrip, removeTripDownload, verifyTrip, type DownloadProgress } from "@/lib/offline/download-manager";
import { serviceWorkerSupported } from "@/lib/offline/sw-client";
import { useOnline } from "./use-online";

interface LocalState {
  sw: boolean;
  storedAt: number | null;
  source: "download" | "online" | null;
  verification: DownloadVerification | null;
}

const fmt = (ms: number) => new Date(ms).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * Download the trip for offline use, show progress, verify completeness
 * (missing / corrupted items, with retry) and remove the download.
 */
export function DownloadPanel({ tripId, serverLastDownload }: { tripId: string; serverLastDownload: { at: string; complete: boolean } | null }) {
  const online = useOnline();
  const [local, setLocal] = useState<LocalState | null>(null);
  const [progress, setProgress] = useState<DownloadProgress | null>(null);
  const [busy, setBusy] = useState<"download" | "verify" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await getStoredBundle(tripId);
      const sw = serviceWorkerSupported();
      setLocal(s ? { sw, storedAt: s.storedAt, source: s.source, verification: s.verification } : { sw, storedAt: null, source: null, verification: null });
    } catch {
      setLocal({ sw: serviceWorkerSupported(), storedAt: null, source: null, verification: null });
      setError("This browser's offline storage is unavailable (private browsing can block it).");
    }
  }, [tripId]);

  useEffect(() => {
    let alive = true;
    // Re-check the cache on open: browsers can evict offline data.
    (async () => {
      const s = await getStoredBundle(tripId).catch(() => undefined);
      if (s?.source === "download") await verifyTrip(tripId).catch(() => null);
      if (alive) await refresh();
    })();
    return () => {
      alive = false;
    };
  }, [tripId, refresh]);

  const run = async (kind: "download" | "verify" | "remove") => {
    setBusy(kind);
    setError(null);
    setMessage(null);
    try {
      if (kind === "download") {
        const v = await downloadTrip(tripId, setProgress);
        setMessage(v.complete ? "Your trip is downloaded and verified for offline use." : "Download finished but some items are missing — see below.");
      } else if (kind === "verify") {
        const v = await verifyTrip(tripId);
        setMessage(v?.complete ? "Everything is still on this device." : "Some items are missing — download again.");
      } else {
        await removeTripDownload(tripId);
        setMessage("Removed the offline copy from this device. Any hike data waiting to sync is kept until it's sent.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(null);
      setProgress(null);
      await refresh();
    }
  };

  const v = local?.verification ?? null;
  const downloaded = local?.source === "download";
  const pct = progress && progress.total ? Math.round((progress.done / progress.total) * 100) : null;
  return (
    <div className="space-y-4">
      {local && !local.sw ? (
        <Alert tone="red">This browser can&apos;t save pages for offline use. The trip data can be stored, but the hike screen may not open without signal.</Alert>
      ) : null}

      <div aria-live="polite" className="space-y-3">
        {local === null ? (
          <p className="text-muted">Checking this device…</p>
        ) : downloaded && v ? (
          v.complete ? (
            <p className="flex items-start gap-2 font-semibold text-forest-800" data-testid="download-status">
              <CheckCircle2 aria-hidden className="mt-0.5 size-5 shrink-0" /> Downloaded and verified on this device ({v.itemCount} items, checked {fmt(v.checkedAt)}).
            </p>
          ) : (
            <div className="rounded-xl border border-[#f5c6c1] bg-red-bg p-3 text-red-ink" data-testid="download-status">
              <p className="flex items-center gap-2 font-semibold">
                <XCircle aria-hidden className="size-5" /> Download incomplete
              </p>
              <ul className="mt-1 list-disc pl-5 text-sm">
                {v.details.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
              <p className="mt-1 text-sm">Retry while you have a good connection.</p>
            </div>
          )
        ) : (
          <p className="text-muted" data-testid="download-status">
            Not downloaded on this device yet.
          </p>
        )}
        {local?.storedAt ? <p className="text-sm text-muted">Last downloaded on this device: {fmt(local.storedAt)}</p> : null}
        {serverLastDownload ? (
          <p className="text-sm text-muted">
            Last recorded download (any device): {fmt(Date.parse(serverLastDownload.at))} — {serverLastDownload.complete ? "verified complete" : "incomplete"}.
          </p>
        ) : null}

        {progress ? (
          <div>
            <p className="text-sm">{progress.message}</p>
            <div
              role="progressbar"
              aria-label="Download progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct ?? undefined}
              className="mt-1 h-3 w-full overflow-hidden rounded-full bg-sand-200"
            >
              <div className="h-full bg-forest-600 transition-[width]" style={{ width: `${pct ?? 10}%` }} />
            </div>
          </div>
        ) : null}
        {message ? <p className="text-sm font-semibold">{message}</p> : null}
        {error ? <Alert tone="red">{error}</Alert> : null}
      </div>

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => run("download")} disabled={!!busy || !online} data-testid="download-trip">
          <CloudDownload aria-hidden className="size-4" />
          {busy === "download" ? "Downloading…" : downloaded ? (v && !v.complete ? "Retry download" : "Download again") : "Download trip"}
        </Button>
        {downloaded ? (
          <>
            <Button variant="secondary" onClick={() => run("verify")} disabled={!!busy} data-testid="verify-download">
              <RefreshCw aria-hidden className="size-4" /> {busy === "verify" ? "Checking…" : "Check download"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                if (window.confirm("Remove the offline copy of this trip from this device?")) void run("remove");
              }}
              disabled={!!busy}
            >
              <Trash2 aria-hidden className="size-4" /> Remove download
            </Button>
          </>
        ) : null}
      </div>
      {!online ? <p className="text-sm text-muted">You&apos;re offline. Connect to download.</p> : null}
      <p className="text-xs text-muted">
        Saves the hike and help screens, your route, story stops, approved narration, emergency info and your booking details (add-ons, locker
        access code, pickup times, permit status) on this device. No map tiles are stored.
        Browsers can clear offline data under storage pressure — check again on the morning of your hike.
      </p>
    </div>
  );
}
