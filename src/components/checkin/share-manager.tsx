"use client";

import { useActionState, useState } from "react";
import { Link2 } from "lucide-react";
import { Alert, Badge, Button } from "@/components/ui";
import { createShareAction, revokeShareAction, type ShareFormState } from "./actions";

export interface ShareListItem {
  id: string;
  active: boolean;
  includeLastLocation: boolean;
  /** preformatted on the server in the region time zone */
  statusText: string;
}

function CopyField({ url, expires }: { url: string; expires: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-2 rounded-xl border border-forest-200 bg-forest-50 p-3">
      <label htmlFor="share-url" className="block text-sm font-semibold">
        Your new link (works until {expires})
      </label>
      <input id="share-url" readOnly value={url} className="block w-full min-h-11 rounded-xl border border-sand-300 bg-surface px-3 font-mono text-sm" onFocus={(e) => e.currentTarget.select()} />
      <Button
        type="button"
        variant="secondary"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(url);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? "Copied" : "Copy link"}
      </Button>
      <p aria-live="polite" className="sr-only">
        {copied ? "Link copied to clipboard" : ""}
      </p>
    </div>
  );
}

function RevokeButton({ tripId, shareId }: { tripId: string; shareId: string }) {
  const [state, action, pending] = useActionState<ShareFormState, FormData>(revokeShareAction.bind(null, tripId), undefined);
  return (
    <form action={action}>
      <input type="hidden" name="shareId" value={shareId} />
      <Button type="submit" variant="ghost" disabled={pending} className="px-3">
        {pending ? "Turning off…" : "Turn off"}
      </Button>
      {state?.error ? (
        <p role="alert" className="text-sm font-semibold text-red-ink">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/** Create expiring trip-share links (location off by default), list and revoke them. */
export function ShareManager({ tripId, shares }: { tripId: string; shares: ShareListItem[] }) {
  const [state, action, pending] = useActionState<ShareFormState, FormData>(createShareAction.bind(null, tripId), undefined);
  const idp = `share-${tripId.slice(0, 8)}`;
  return (
    <div className="space-y-4">
      <form action={action} className="space-y-3">
        <fieldset>
          <legend className="font-semibold">Link works for</legend>
          <div className="mt-1 grid grid-cols-3 gap-2">
            {[6, 24, 72].map((h) => (
              <label
                key={h}
                className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border border-sand-200 px-2 has-[:checked]:border-forest-600 has-[:checked]:bg-forest-50"
              >
                <input type="radio" name="hours" value={h} defaultChecked={h === 24} className="size-4 accent-forest-700" />
                <span>{h} h</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className="flex min-h-11 cursor-pointer items-start gap-3" htmlFor={`${idp}-loc`}>
          <input id={`${idp}-loc`} type="checkbox" name="includeLastLocation" className="mt-1 size-5 accent-forest-700" aria-describedby={`${idp}-loc-hint`} />
          <span>
            Include my last reported location
            <span id={`${idp}-loc-hint`} className="block text-sm text-muted">
              Off by default. Anyone with the link would see your last reported position and when it was recorded.
            </span>
          </span>
        </label>
        <Button type="submit" variant="secondary" disabled={pending} className="w-full">
          <Link2 aria-hidden className="size-4" />
          {pending ? "Creating…" : "Create share link"}
        </Button>
      </form>
      <div aria-live="polite" role="status" className="space-y-2">
        {state?.error ? <Alert tone="red">{state.error}</Alert> : null}
        {state?.ok && state.message ? <Alert tone="forest">{state.message}</Alert> : null}
        {state?.ok && state.url ? (
          // expiresLabel is formatted on the server in the trail's time zone (with its abbreviation), like the list below.
          <CopyField url={state.url} expires={state.expiresLabel ?? "it expires"} />
        ) : null}
      </div>
      {shares.length ? (
        <ul className="divide-y divide-sand-200 rounded-xl border border-sand-200" aria-label="Your share links">
          {shares.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-3">
              <div className="min-w-0">
                <p className="text-sm font-semibold">{s.statusText}</p>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Badge tone={s.active ? "forest" : "neutral"}>{s.active ? "Active" : "Not active"}</Badge>
                  <Badge tone={s.includeLastLocation ? "amber" : "neutral"}>{s.includeLastLocation ? "Includes last location" : "No location"}</Badge>
                </div>
              </div>
              {s.active ? <RevokeButton tripId={tripId} shareId={s.id} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
