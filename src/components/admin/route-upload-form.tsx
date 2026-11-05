"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";
import { Button } from "@/components/ui";
import { FormResult, type AdminFormState } from "./action-form";

/**
 * Route-file upload. Posts multipart data to the upload route handler
 * (works without JavaScript too: the form falls back to a normal POST).
 */
export function RouteUploadForm({ trailId }: { trailId: string }) {
  const router = useRouter();
  const id = useId();
  const [state, setState] = useState<AdminFormState>(undefined);
  const [pending, startTransition] = useTransition();
  const action = `/admin/trails/${trailId}/geometry/upload`;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    const file = data.get("file");
    if (!(file instanceof File) || file.size === 0) {
      setState({ ok: false, error: "Choose a .geojson or .gpx file." });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setState({ ok: false, error: "The file is larger than 2 MB." });
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch(action, { method: "POST", body: data, headers: { "x-gg-upload": "1" } });
        const json = (await res.json().catch(() => null)) as AdminFormState | { error?: string } | null;
        if (json && "ok" in json) setState(json as AdminFormState);
        else setState({ ok: false, error: (json as { error?: string } | null)?.error ?? `Upload failed (HTTP ${res.status}).` });
        if (res.ok) {
          form.reset();
          router.refresh();
        }
      } catch {
        setState({ ok: false, error: "Upload failed. Check your connection and try again." });
      }
    });
  }

  return (
    <form action={action} method="post" encType="multipart/form-data" onSubmit={onSubmit} className="space-y-3" aria-busy={pending}>
      <div className="space-y-1">
        <label htmlFor={`${id}-file`} className="block text-sm font-semibold">
          Route file (.geojson, .json or .gpx, max 2 MB)
        </label>
        <p id={`${id}-hint`} className="text-xs text-muted">
          GeoJSON: a LineString, or a Feature / FeatureCollection with exactly one LineString. GPX: track points (or route points). Files with DOCTYPE
          or ENTITY declarations are rejected.
        </p>
        <input
          id={`${id}-file`}
          name="file"
          type="file"
          required
          accept=".geojson,.json,.gpx,application/geo+json,application/gpx+xml"
          aria-describedby={`${id}-hint`}
          className="block w-full min-h-11 rounded-xl border border-sand-300 bg-surface px-3 py-2 file:mr-3 file:min-h-9 file:rounded-lg file:border-0 file:bg-forest-100 file:px-3 file:font-semibold file:text-forest-900"
        />
      </div>
      <Button type="submit" disabled={pending}>
        {pending ? "Uploading and validating…" : "Upload and validate"}
      </Button>
      <FormResult state={state} />
    </form>
  );
}
