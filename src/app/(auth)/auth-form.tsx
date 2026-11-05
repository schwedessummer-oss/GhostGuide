"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Alert, Button, Field, Input } from "@/components/ui";
import { signInAction, signUpAction, type AuthFormState } from "./actions";

export function AuthForm({ mode, next }: { mode: "signin" | "signup"; next?: string }) {
  const [state, action, pending] = useActionState<AuthFormState, FormData>(mode === "signin" ? signInAction : signUpAction, undefined);
  return (
    <form action={action} className="space-y-5" noValidate>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {state?.error ? (
        <Alert tone="red" live="assertive">
          {state.error}
        </Alert>
      ) : null}
      {mode === "signup" ? (
        <Field label="Full name" htmlFor="fullName" required>
          <Input id="fullName" name="fullName" autoComplete="name" required />
        </Field>
      ) : null}
      <Field label="Email" htmlFor="email" required>
        <Input id="email" name="email" type="email" autoComplete="email" required />
      </Field>
      <Field label="Password" htmlFor="password" required hint={mode === "signup" ? "At least 10 characters." : undefined}>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete={mode === "signup" ? "new-password" : "current-password"}
          required
          aria-describedby={mode === "signup" ? "password-hint" : undefined}
        />
      </Field>
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending ? "Please wait…" : mode === "signin" ? "Sign in" : "Create account"}
      </Button>
      <p className="text-center text-sm text-muted">
        {mode === "signin" ? (
          <>
            New here?{" "}
            <Link className="font-semibold text-forest-800 underline" href={`/signup${next ? `?next=${encodeURIComponent(next)}` : ""}`}>
              Create an account
            </Link>
          </>
        ) : (
          <>
            Already have an account?{" "}
            <Link className="font-semibold text-forest-800 underline" href={`/login${next ? `?next=${encodeURIComponent(next)}` : ""}`}>
              Sign in
            </Link>
          </>
        )}
      </p>
    </form>
  );
}
