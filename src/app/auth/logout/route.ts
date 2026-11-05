import { signOut } from "@/server/auth";
import { env } from "@/config/env";

export async function POST(request: Request) {
  // Same-origin check: logout is state-changing.
  const origin = request.headers.get("origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return new Response("Forbidden", { status: 403 });
  }
  await signOut();
  return Response.redirect(new URL("/", env().NEXT_PUBLIC_APP_URL ?? request.url), 303);
}
