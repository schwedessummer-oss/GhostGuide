import "server-only";
import { refresh } from "next/cache";
import { requirePermission, type SessionUser } from "@/server/auth";
import type { Permission } from "@/server/auth/rbac";
import { guarded, type ActionResult } from "@/server/admin/common";

/**
 * Shared body of every admin server action: re-check the permission (server
 * actions are public endpoints), run the use-case (which validates input with
 * zod and re-checks authorization), convert thrown errors into a form result,
 * and refresh the page on success.
 */
export async function runAction<D>(permission: Permission, path: string, fn: (user: SessionUser) => Promise<ActionResult<D>>): Promise<ActionResult<D>> {
  const user = await requirePermission(permission, path);
  const result = await guarded(() => fn(user), "admin.action");
  if (result.ok) refresh();
  return result;
}

/** String value of a form field ("" when missing or a file). */
export function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}

export function strs(fd: FormData, key: string): string[] {
  return fd.getAll(key).filter((v): v is string => typeof v === "string");
}

export const checked = (fd: FormData, key: string) => fd.get(key) === "on" || fd.get(key) === "true";
