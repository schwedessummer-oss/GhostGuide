# Launch checklist

Ghost Guide must not take real customers until every item below is done and signed off.
Owners are suggestions; adapt them to your organization.

## 1. Provider credentials & configuration
- [ ] Supabase production project (separate from preview); point-in-time recovery / backups enabled; region chosen.
- [ ] Migrations applied with `supabase db push`; `db/local/*` never applied to Supabase.
- [ ] No demo seed in production (no `*@demo.ghostguide.test` accounts, no `is_demo` trails published).
- [ ] Supabase Auth: site URL, redirect URLs, email templates, SMTP provider, rate limits, leaked-password protection.
- [ ] Private Storage bucket created (`scripts/setup-supabase-storage.ts`); confirm not public.
- [ ] Vercel production env vars set; `APP_MODE=live`; strong unique `AUTH_SECRET` and `CRON_SECRET`.
- [ ] Per-minute job trigger (Supabase pg_cron script or Vercel Pro cron) running; alert if `/api/cron/jobs` has not succeeded in 5 minutes.
- [ ] Stripe: live account activated, business verification complete, live keys + live webhook endpoint/secret, Radar rules reviewed, statement descriptor, refund policy published, test-mode end-to-end run (incl. duplicate webhook replay from the Stripe dashboard).
- [ ] Mapbox: token URL-restricted; usage alerts; terms reviewed for your use (no offline tile caching in the PWA).
- [ ] AI provider: API key in server env only; spend limits; prompt/guard reviewed; `ai_explanations` flag decision.
- [ ] Notifications: Twilio A2P 10DLC or toll-free verification approved; Resend domain verified (SPF/DKIM/DMARC); STOP/HELP handling; test delivery to real phones/inboxes; failure alerting on `notifications.status = failed`.
- [ ] Weather: NWS User-Agent with operator contact; fallback behavior reviewed.
- [ ] Error monitoring/alerting (e.g. Sentry or Vercel log drains) with the redacting logger; uptime checks for `/status` and `/api/cron/jobs`.

## 2. Content & data
- [ ] Every launch trail: real route geometry from an authoritative source (land manager or professional survey), uploaded via Admin → Trails, validated, and **field-verified by walking it**.
- [ ] Every trail fact has provenance (verified vs estimate) with source links and verification dates; estimates labeled.
- [ ] Access rights confirmed (public land / easements); commercial-use or outfitter/guide permits obtained where required by the land manager.
- [ ] Closures process: who monitors land-manager alerts, how fast closures are entered, how affected bookings are handled.
- [ ] Narration: every script fact-checked against cited sources, approved in Admin → Content, recorded audio reviewed; cultural/tribal history reviewed with the relevant communities where applicable.
- [ ] Permits: official links, requirements and lead times verified per trail; reminder cadence decided.
- [ ] POI trigger radii tuned in the field (GPS accuracy under canopy / in canyons).

## 3. Field testing (real devices, real trails)
- [ ] iOS Safari (installed PWA and browser) and Android Chrome, recent and 3-year-old devices.
- [ ] GPS accuracy, geofence triggering, drift/no-repeat behavior, deviation prompt false-alarm rate on every launch trail.
- [ ] Screen-lock / app-background behavior documented per platform (expect GPS/audio to pause); wake-lock behavior.
- [ ] Offline: full download in airplane mode, start/finish offline, queue + sync on reconnect, help screen offline.
- [ ] Battery drain over a full hike; storage usage of downloads.
- [ ] Accessibility: VoiceOver/TalkBack walkthrough of plan → book → hike → finish; captions/transcripts; contrast in sunlight; large text.
- [ ] Check-in drills: late finish, extension, "I'm okay" offline then online, overdue notice content received by a test contact.

## 4. Operating procedures
- [ ] Safety desk runbook: what staff do when a check-in becomes overdue (notice already sent to the contact; staff may call the customer/contact; staff never claim to dispatch rescue; when staff should advise contacting 911).
- [ ] Hours of operation for the safety desk stated honestly in the product (no "24/7 monitoring" claims).
- [ ] Partner runbooks: gear locker failures, access-code resets, maintenance, shuttle no-shows, meal-pack failures, satellite-device returns; escalation contacts.
- [ ] Payments runbook: needs_attention bookings, refunds, disputes/chargebacks, reconciliation review cadence.
- [ ] Integration failure triage: dead jobs, failed notifications, failed webhooks (Admin → Jobs).
- [ ] Customer support: response targets, ticket handling, data-deletion requests.
- [ ] Incident response & on-call; status communication.
- [ ] Staff access reviews (roles least-privilege; quarterly review of `staff_roles` and audit logs).

## 5. Business & legal approvals
- [ ] Terms of service, liability waiver/assumption-of-risk, and refund/cancellation policy reviewed by counsel for each launch jurisdiction.
- [ ] Privacy policy covering precise location, emergency contacts, retention, deletion; consent language for emergency contacts; COPPA/age policy.
- [ ] Insurance (general liability, professional/outfitter as applicable).
- [ ] Land-manager permits / commercial use authorizations; partner contracts and API access approvals (lockers, shuttles, meal packs, satellite rentals) with documented API terms.
- [ ] Marketing claims reviewed (no "guaranteed", "monitoring", "rescue", "SOS" claims); marketing drafts approved in Admin before publication.
- [ ] Accessibility statement and WCAG 2.2 AA audit.
- [ ] Tax collection/registration for sales of experiences and add-ons.
