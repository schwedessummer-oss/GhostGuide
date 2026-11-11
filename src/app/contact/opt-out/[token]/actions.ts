"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { clientIpFrom } from "@/server/request";
import { optOutWithLink } from "@/server/account/contact-optout";
import { OPT_OUT_TOKEN } from "@/server/notifications/optout";

const input = z.object({ token: z.string().regex(OPT_OUT_TOKEN) });

/**
 * Public action (no sign-in): the emergency contact confirms they want no
 * more notices. The token is the only credential; it is validated, the call
 * is rate limited per client, and the page is re-rendered with the outcome.
 */
export async function contactOptOutAction(formData: FormData): Promise<void> {
  const parsed = input.safeParse({ token: formData.get("token") });
  if (!parsed.success) redirect("/contact/opt-out/invalid?result=invalid");
  const token = parsed.data.token;
  const result = await optOutWithLink(token, clientIpFrom(await headers()));
  redirect(`/contact/opt-out/${token}?result=${result.ok ? "done" : result.rateLimited ? "busy" : "invalid"}`);
}
