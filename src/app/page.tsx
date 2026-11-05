import { ButtonLink, Container } from "@/components/ui";

// Placeholder landing page — replaced by the discovery slice.
export default function HomePage() {
  return (
    <Container className="py-16">
      <h1 className="text-4xl font-bold">Ghost Guide</h1>
      <p className="mt-4 text-lg text-muted">Self-guided hikes with an audio companion.</p>
      <ButtonLink href="/trails" className="mt-6">
        Browse trails
      </ButtonLink>
    </Container>
  );
}
