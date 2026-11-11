"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { signInWithPassword, signUpWithPassword } from "@/server/auth";
import { checkRateLimit } from "@/server/rate-limit";
import { headers } from "next/headers";
import { createHash } from "node:crypto";
import { safeRedirectPath } from "@/lib/safe-redirect";
import { clientIpFrom } from "@/server/request";

export type AuthFormState = { error?: string } | undefined;

/** Only allow same-origin paths after sign-in (see src/lib/safe-redirect.ts). */
function safeNext(next: FormDataEntryValue | null): string {
  return safeRedirectPath(next, "/trips");
}

async function clientKey() {
  return clientIpFrom(await headers());
}

const emailKey = (email: string) => createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);

const signInSchema = z.object({ email: z.email(), password: z.string().min(1).max(200) });

export async function signInAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = signInSchema.safeParse({ email: formData.get("email"), password: formData.get("password") });
  if (!parsed.success) return { error: "Enter a valid email and password." };
  // Per-IP and per-account limits: rotating IPs cannot bypass the account limit.
  const [byIp, byAccount] = await Promise.all([
    checkRateLimit(`auth:signin:ip:${await clientKey()}`, 20, 600),
    checkRateLimit(`auth:signin:email:${emailKey(parsed.data.email)}`, 10, 900),
  ]);
  if (!byIp.allowed || !byAccount.allowed) return { error: "Too many sign-in attempts. Try again in a few minutes." };
  const result = await signInWithPassword(parsed.data.email, parsed.data.password);
  if (!result.ok) return { error: result.error };
  redirect(safeNext(formData.get("next")));
}

const signUpSchema = z.object({
  fullName: z.string().trim().min(1).max(120),
  email: z.email(),
  password: z.string().min(10).max(200),
});

export async function signUpAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = signUpSchema.safeParse({
    fullName: formData.get("fullName"),
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) return { error: "Enter your name, a valid email, and a password of at least 10 characters." };
  const limit = await checkRateLimit(`auth:signup:ip:${await clientKey()}`, 10, 3600);
  if (!limit.allowed) return { error: "Too many sign-up attempts. Try again later." };
  const result = await signUpWithPassword(parsed.data.email, parsed.data.password, parsed.data.fullName);
  if (!result.ok) return { error: result.error };
  redirect(safeNext(formData.get("next")));
}
