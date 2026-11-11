import { Badge } from "@/components/ui";
import { bookingStatusCopy, TRIP_STATUS_COPY } from "@/domain/booking";
import type { BookingStatus, TripStatus } from "@/domain/types";

/**
 * Booking status as text + tone (never color alone). Pass `paidAt` so an ended
 * checkout that still received a (refunded) payment is not labelled as unpaid.
 */
export function BookingStatusBadge({ status, paidAt }: { status: BookingStatus; paidAt?: Date | string | null }) {
  const c = bookingStatusCopy(status, { paidAt });
  return (
    <Badge tone={c.tone}>
      <span className="sr-only">Booking status: </span>
      {c.label}
    </Badge>
  );
}

export function TripStatusBadge({ status }: { status: TripStatus }) {
  const c = TRIP_STATUS_COPY[status];
  return (
    <Badge tone={c.tone}>
      <span className="sr-only">Trip status: </span>
      {c.label}
    </Badge>
  );
}

export function DemoTrailBadge() {
  return (
    <Badge tone="amber" title="Fictional demonstration trail. Not for navigation or real trip planning.">
      Demonstration trail
    </Badge>
  );
}
