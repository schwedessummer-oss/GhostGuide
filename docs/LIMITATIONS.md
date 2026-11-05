# Known mobile, offline & platform limitations

Ghost Guide's customer app is an installable **Progressive Web App**. A PWA runs inside the mobile
browser's sandbox, so several capabilities a hiking companion would ideally have are **not reliably
available**. The product says this to customers on the pre-hike screen and on `/how-it-works`, and
never presents these as guaranteed.

## Location (GPS)
- **Foreground only.** Browsers deliver `watchPosition` updates while the page is visible. When the
  screen locks or another app is in front, iOS Safari and Android Chrome may pause or throttle
  location updates. There is no web API for dependable background location.
- **Accuracy varies** (canopy, canyons, cold starts). The app filters poor-accuracy fixes, requires
  persistence before deviation prompts, and gates geofences on accuracy, but it cannot make a weak
  fix accurate.
- **Wake Lock** (keep screen on) is requested during an active hike where supported; support and
  battery cost vary, and the OS can still release it.

## Audio
- Narration plays while the page is in the foreground. **Screen-locked/background audio is not
  guaranteed**, especially on iOS. Device text-to-speech voices vary and may be missing offline.
- Every narration has a visible transcript; audio is never the only channel.

## Offline
- After "Download trip", the bundle (route geometry, POIs, approved narration, emergency info) is in
  IndexedDB and the hike/help pages are in the service-worker cache. The download screen verifies
  completeness (presence + checksums) and offers retry.
- **Storage can be evicted** by the browser under storage pressure (persistent storage is requested
  but may be denied). Re-check the download on the morning of the hike.
- **No offline basemap.** The offline view draws the route and POIs without map tiles. Mapbox tiles
  are not cached (licensing); offline maps need a native client using Mapbox's mobile SDK offline
  features under its terms.
- Location points and events recorded offline are **queued and synced** when connectivity returns.
  Until then, the server (and therefore check-in notices) only knows the last location it received.
- **Offline notifications are not guaranteed.** Reminders are shown in-app while the page is open;
  web push needs connectivity and OS permission and is not used for safety-critical delivery.

## Check-ins
- Overdue detection runs on the server and needs the per-minute job trigger (see DEPLOYMENT.md).
- A notice to the emergency contact includes the **last location the server received** with its
  timestamp and accuracy, and is labeled stale when old. If the hiker was offline, it may be far
  from their current position.
- SMS/email delivery depends on carriers and providers; failures are retried and shown to staff.

## What a native client would add (deferred)
- Dependable background location (iOS Core Location background modes / Android foreground service).
- Background and lock-screen audio sessions.
- Local notifications for reminders without connectivity.
- Licensed offline map packs.
- Satellite-messenger integrations via vendor SDKs, if and when partner access is approved.

The API surface (`/api/trips/[id]/bundle`, `/api/hike/start|sync|finish`, idempotent client event IDs,
outbox semantics) is designed so a native client can reuse it unchanged.
