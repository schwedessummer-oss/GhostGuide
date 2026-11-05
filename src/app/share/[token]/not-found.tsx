import Link from "next/link";
import { Container } from "@/components/ui";

/** Shown for unknown, expired and revoked share links alike (no hint which). */
export default function ShareNotFound() {
  return (
    <Container className="max-w-2xl py-16 text-center">
      <h1 className="text-3xl font-bold text-ink">This trip link isn&apos;t available</h1>
      <p className="mx-auto mt-3 max-w-prose text-lg text-muted">
        It may have expired, been turned off by the hiker, or been copied incorrectly. Ask the person who shared it for a new link.
      </p>
      <p className="mt-6 text-sm text-muted">If you are worried about someone&apos;s safety, try calling them, and if you are concerned call local emergency services (911).</p>
      <Link href="/" className="mt-6 inline-flex min-h-11 items-center font-semibold text-forest-800 underline">
        Go to Ghost Guide
      </Link>
    </Container>
  );
}
