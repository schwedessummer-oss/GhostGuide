"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult, FormState } from "@/server/admin/common";
import { hideCatalogTrail, requestTileRetry, unhideCatalogTrail } from "@/server/admin/catalog";
import { runAction, str } from "../_lib/action";

/*
 * Trail data mutations. Each re-checks "catalog.manage" (server actions are
 * public endpoints); the use-cases validate input, re-check the permission
 * and write the audit entry in the same transaction as the change.
 */

export async function retryTileAction(layer: string, provider: string, tileKey: string, _prev: FormState, fd: FormData): Promise<FormState> {
  return runAction("catalog.manage", "/admin/data", (user) => requestTileRetry(user, { layer, provider, tileKey, reason: str(fd, "reason") || undefined }));
}

/**
 * Trail pages are cached (ISR). After a hide/unhide, expire every cached trail
 * page, not just the current path: old paths the trail has left (still cached
 * as a page or a redirect) and mixed-case variants hold copies too. Moderation
 * is rare, and pages rebuild on their next visit.
 */
function revalidateTrailPage(result: ActionResult<{ id: string; path: string }>) {
  if (result.ok) revalidatePath("/trail/[country]/[region]/[slug]", "page");
  return result;
}

export async function hideTrailAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return revalidateTrailPage(
    await runAction("catalog.manage", "/admin/data", (user) => hideCatalogTrail(user, { trail: str(fd, "trail"), reason: str(fd, "reason") })),
  );
}

export async function unhideTrailAction(_prev: FormState, fd: FormData): Promise<FormState> {
  return revalidateTrailPage(
    await runAction("catalog.manage", "/admin/data", (user) => unhideCatalogTrail(user, { trail: str(fd, "trail"), reason: str(fd, "reason") })),
  );
}
