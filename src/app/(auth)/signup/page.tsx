import type { Metadata } from "next";
import { Card, Container } from "@/components/ui";
import { AuthForm } from "../auth-form";

export const metadata: Metadata = { title: "Create account" };

export default async function SignupPage({ searchParams }: PageProps<"/signup">) {
  const { next } = await searchParams;
  return (
    <Container className="max-w-md py-12">
      <h1 className="mb-6 text-3xl font-bold">Create your account</h1>
      <Card>
        <AuthForm mode="signup" next={typeof next === "string" ? next : undefined} />
      </Card>
    </Container>
  );
}
