import { ButtonLink, Container, EmptyState } from "@/components/ui";

export const metadata = { title: "Access denied" };

export default function ForbiddenPage() {
  return (
    <Container className="py-16">
      <h1 className="sr-only">Access denied</h1>
      <EmptyState title="You don't have access to this page" action={<ButtonLink href="/">Go home</ButtonLink>}>
        Your account doesn&apos;t have the role this page requires. Ask an administrator if you think this is a mistake.
      </EmptyState>
    </Container>
  );
}
