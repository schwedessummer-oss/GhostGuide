import { expect } from "vitest";
import { ForbiddenError, type ActionResult } from "@/server/admin/common";

export function expectOk<D>(r: ActionResult<D>): asserts r is { ok: true; message: string; warnings?: string[]; data?: D } {
  if (!r.ok) throw new Error(`Expected ok, got error: ${r.error}`);
}

export async function expectForbidden(p: Promise<unknown>) {
  await expect(p).rejects.toBeInstanceOf(ForbiddenError);
}
