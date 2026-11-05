import { ButtonLink, Container, EmptyState } from "@/components/ui";

export default function TrailNotFound() {
  return (
    <Container className="py-16">
      <EmptyState title="We couldn't find that trail" action={<ButtonLink href="/trails">Browse all trails</ButtonLink>}>
        It may have been unpublished, renamed, or it was never in our catalog.
      </EmptyState>
    </Container>
  );
}
