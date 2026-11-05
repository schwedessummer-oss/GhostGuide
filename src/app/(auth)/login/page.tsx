import type { Metadata } from "next";
import { Card, Container } from "@/components/ui";
import { env } from "@/config/env";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const { next } = await searchParams;
  const demo = env().AUTH_PROVIDER === "demo";
  return (
    <Container className="max-w-md py-12">
      <h1 className="mb-6 text-3xl font-bold">Sign in</h1>
      <Card>
        <AuthForm mode="signin" next={typeof next === "string" ? next : undefined} />
      </Card>
      {demo ? (
        <Card className="mt-6 bg-amber-bg">
          <p className="font-semibold text-amber-ink">Demo accounts (local demo only)</p>
          <ul className="mt-2 space-y-1 text-sm text-amber-ink">
            <li>
              Customer: <code>hiker@demo.ghostguide.test</code>
            </li>
            <li>
              Admin: <code>admin@demo.ghostguide.test</code>
            </li>
            <li>
              Safety desk: <code>safety@demo.ghostguide.test</code>
            </li>
            <li>
              Password for all: <code>ghostguide-demo</code>
            </li>
          </ul>
        </Card>
      ) : null}
    </Container>
  );
}
