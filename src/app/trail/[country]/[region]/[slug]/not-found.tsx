import { Compass } from "lucide-react";
import { ButtonLink, Container } from "@/components/ui";

export default function TrailNotFound() {
  return (
    <Container className="max-w-xl py-16 text-center">
      <Compass aria-hidden className="mx-auto size-10 text-forest-700" />
      <h1 className="mt-4 text-2xl font-bold text-ink">We couldn&apos;t find this trail</h1>
      <p className="mt-2 text-muted">
        It may have been renamed or removed from the map data, or the link may be mistyped. Search the map to find it or another trail
        nearby.
      </p>
      <div className="mt-6 flex justify-center">
        <ButtonLink href="/explore" size="lg">
          Explore trails
        </ButtonLink>
      </div>
    </Container>
  );
}
