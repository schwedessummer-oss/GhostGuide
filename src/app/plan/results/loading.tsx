import { Container } from "@/components/ui";

export default function LoadingResults() {
  return (
    <Container className="py-10">
      <div role="status" aria-live="polite" className="space-y-6">
        <p className="text-lg font-semibold">Checking every trail against your answers…</p>
        <div aria-hidden className="space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-48 animate-pulse rounded-[var(--radius-card)] bg-sand-100 motion-reduce:animate-none" />
          ))}
        </div>
      </div>
    </Container>
  );
}
