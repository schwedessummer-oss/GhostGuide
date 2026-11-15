# Launch checklist

Ghost Guide must not take real customers until every item below is done and signed off.
Owners are suggestions; adapt them to your organization.

## 1. Provider credentials & configuration
- [ ] Supabase production project (separate from preview); point-in-time recovery / backups enabled; region chosen.
- [ ] Migrations applied with `supabase db push`; `db/local/*` never applied to Supabase.
- [ ] No demo seed in production (no `*@demo.ghostguide.test` accounts).
- [ ] Supabase Auth: site URL, redirect URLs, email templates, SMTP provider, rate limits, leaked-password protection.
- [ ] Vercel production env vars set; `APP_MODE=live`; strong unique `AUTH_SECRET` and `CRON_SECRET`.
- [ ] Per-minute job trigger (Supabase pg_cron script or Vercel Pro cron) running; alert if `/api/cron/jobs` has not succeeded in 5 minutes.
- [ ] Stripe: live account activated, business verification complete, live keys + live webhook endpoint/secret, Radar rules reviewed, statement descriptor, refund policy published, test-mode end-to-end run (incl. duplicate webhook replay from the Stripe dashboard).
- [ ] Maps: confirm OpenFreeMap (or your chosen tile provider) terms for your traffic; no tile caching.
- [ ] Data providers: set `DATA_PROVIDER_USER_AGENT` with a real contact; review Overpass/Nominatim usage in Admin → Trail data and move to self-hosted or commercial instances before heavy traffic; ODbL attribution present on maps and trail pages.
- [ ] Weather: NWS User-Agent with operator contact; fallback behavior reviewed.
- [ ] Error monitoring/alerting (e.g. Sentry or Vercel log drains) with the redacting logger; uptime checks for `/status` and `/api/cron/jobs`.

## 2. Content & data
- [ ] Every published hike: route and facts reviewed on the admin data-review page, each value with its source, licence and check date (`docs/PLAN.md` §3–4); estimates labeled.
- [ ] Access rights confirmed (public land / easements); commercial-use or outfitter/guide permits obtained where required by the land manager.
- [ ] Closures process: who monitors land-manager alerts, how fast closures are entered, how affected orders are handled.
- [ ] Permits: official links, requirements and lead times verified per hike.

## 3. Field testing (real devices, real trails)
- [ ] iOS Safari and Android Chrome, recent and 3-year-old devices.
- [ ] Browsers that installed the old offline service worker pick up the kill switch (`public/sw.js`): caches cleared, worker unregistered, fresh pages served.
- [ ] Accessibility: VoiceOver/TalkBack walkthrough of explore → plan → book; contrast in sunlight; large text.

## 4. Operating procedures
- [ ] Partner booking runbooks (Phase 6 providers): failed or late partner bookings, cancellations; escalation contacts.
- [ ] Payments runbook: orders needing attention, refunds, disputes/chargebacks, reconciliation review cadence.
- [ ] Integration failure triage: dead jobs and integration failures (Admin → Jobs).
- [ ] Customer support: response targets, ticket handling, data-deletion requests.
- [ ] Incident response & on-call; status communication.
- [ ] Staff access reviews (roles least-privilege; quarterly review of `staff_roles` and audit logs).

## 5. Business & legal approvals
- [ ] Terms of service, liability waiver/assumption-of-risk, and refund/cancellation policy reviewed by counsel for each launch jurisdiction.
- [ ] Privacy policy covering accounts, orders, retention and deletion; COPPA/age policy.
- [ ] Insurance (general liability, professional/outfitter as applicable).
- [ ] Land-manager permits / commercial use authorizations; partner contracts and API access approvals with documented API terms.
- [ ] Marketing claims reviewed (no "guaranteed", "monitoring", "rescue", "SOS" claims).
- [ ] Accessibility statement and WCAG 2.2 AA audit.
- [ ] Tax collection/registration for sales of experiences and partner items.
