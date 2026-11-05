# Partner integrations (logistics)

Ghost Guide sells optional add-ons that a logistics partner fulfills:

| Add-on kind        | Interface                        | Adapter today                         |
|--------------------|----------------------------------|---------------------------------------|
| `gear_locker`      | `GearLockerProvider`             | `gear-locker/demo.ts` (**simulated**) |
| `shuttle`          | `ShuttleProvider`                | `shuttle/demo.ts` (**simulated**)     |
| `meal_pack`        | `MealPackProvider`               | `meal-pack/demo.ts` (**simulated**)   |
| `satellite_device` | `SatelliteDeviceRentalProvider`  | `satellite-device/demo.ts` (**simulated**) |

**No real partner API is integrated.** We deliberately do not invent vendor
APIs (no smart-locker, rideshare/shuttle, kitchen or satellite-messenger
vendor endpoints). Each demo adapter:

- calls `assertSimulationAllowed(...)`, so it refuses to run when `APP_MODE=live`;
- records every call with `recordIntegrationEvent` (outcome `simulated`, or `failure`);
- is idempotent per fulfillment (retries return the same reservation / order / ride);
- is labeled "Simulated partner" everywhere customers or staff see its output.

The registry (`index.ts`) resolves `addons.provider_key`. Any key other than
`demo` raises a permanent `PartnerRejectedError`, so a misconfigured add-on is
flagged `needs_attention` for an operator instead of silently pretending.

## Fulfillment model

Booking status and fulfillment status are separate. When a payment is
confirmed, one `fulfillments` row is created per booked add-on and a
`fulfillment.process` job is enqueued (dedup key `fulfill:<fulfillmentId>`).

- Transient errors (`PartnerTransientError`, timeouts) are retried by the job
  queue with backoff, up to 3 attempts; then the fulfillment becomes
  `needs_attention` and shows on the trip page ("failed — our team is on it")
  and in admin. The booking itself stays `confirmed`.
- Permanent rejections (`PartnerRejectedError`) go to `needs_attention` at once.
- One failing add-on never affects the booking or the other add-ons.
- Staff can retry or set a status via `src/server/commerce/staff-actions.ts`.

### Shuttle safety rule
A shuttle fulfillment first obtains a **quote** (status `awaiting_customer`).
The customer must explicitly confirm the pickup location, the price and the
pickup time on `/trips/[id]/shuttle/[fulfillmentId]` before a ride is
requested. `requestRide` itself throws `ShuttleConfirmationRequiredError`
when `customerConfirmedAt` is missing. Expired quotes must be re-quoted.

### Locker access codes
Codes are derived as 6 digits from `HMAC-SHA256(AUTH_SECRET, reservationId)`;
only a SHA-256 hash, the last two digits and an expiry are stored. The owner's
trip page re-derives the code after checking ownership.

### Satellite communicator rental
Reserves a `gear_items` row of kind `satellite_communicator`. Customer copy
must state that **the device's own satellite subscription / SOS service
applies and Ghost Guide does not provide SOS**.

## Failure injection (demo and tests only)

Deterministic, set per booked add-on in `booking_addons.details.simulate`
(the checkout page exposes it under "Demo controls" only in demo mode):

| Value        | Effect |
|--------------|--------|
| `fail`       | every partner call fails transiently → retried → `needs_attention` after 3 attempts |
| `fail_once`  | the first attempt fails, the automatic retry succeeds |
| `reject`     | the partner declines → `needs_attention` immediately |

Adapter rule: the demo meal-pack kitchen rejects any order for a **party of
exactly 7**.

## What a live adapter needs

Before writing a live adapter for any partner:

1. **Official documentation and a written agreement.** Use only the partner's
   published, supported API (no scraping, no reverse-engineered apps).
2. **Approval / onboarding.** Many partners require a commercial contract,
   sandbox access, and a review of how bookings are presented to customers.
3. **Credentials** stored as server-side secrets (never in the client bundle),
   added to `src/config/env.ts` with validation, and reflected in
   `integrationStatus()` so `/status` shows the integration as live.
4. **Idempotency** using the partner's idempotency keys (use the fulfillment
   id) and **webhooks / polling** for asynchronous status changes, verified
   with the partner's signature scheme.
5. **Semantics review**: cancellation windows, fees, and — for shuttles —
   the rule that no paid ride is requested before customer confirmation.
6. Register the adapter in `index.ts` under a new `provider_key` and set that
   key on the relevant `addons` rows.
