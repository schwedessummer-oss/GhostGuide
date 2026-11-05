import { Badge } from "@/components/ui";
import { BOOKING_STATUS_COPY, TRIP_STATUS_COPY } from "@/domain/booking";
import type { BookingStatus, TripStatus } from "@/domain/types";

/** Booking status as text + tone (never color alone). */
export function BookingStatusBadge({ status }: { status: BookingStatus }) {
  const c = BOOKING_STATUS_COPY[status];
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
