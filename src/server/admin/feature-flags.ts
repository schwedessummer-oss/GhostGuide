import "server-only";
import { z } from "zod";
import type { SessionUser } from "@/server/auth";
import { FLAGS } from "@/server/flags";
import { assertCan, auditInStaffTx, fail, guarded, ok, staffTx, type ActionResult } from "./common";

export interface FlagRow {
  key: string;
  enabled: boolean;
  description: string;
  known: boolean;
  updatedAt: Date;
  updatedByEmail: string | null;
}

export async function listFlags(user: SessionUser): Promise<FlagRow[]> {
  assertCan(user, "flags.manage");
  const rows = await staffTx(user, (tx) => tx<Omit<FlagRow, "known">[]>`
    select f.key, f.enabled, f.description, f.updated_at, p.email as updated_by_email
    from public.feature_flags f left join public.profiles p on p.id = f.updated_by order by f.key`);
  return rows.map((r) => ({ ...r, known: Object.hasOwn(FLAGS, r.key) }));
}

export async function setFlag(user: SessionUser, key: unknown, enabled: unknown): Promise<ActionResult> {
  assertCan(user, "flags.manage");
  const k = z.string().regex(/^[a-z0-9_]{1,64}$/).safeParse(key);
  if (!k.success) return fail("Unknown flag.");
  if (typeof enabled !== "boolean") return fail("Choose on or off.");
  return guarded(() =>
    staffTx(user, async (tx) => {
      const [before] = await tx<{ enabled: boolean }[]>`select enabled from public.feature_flags where key = ${k.data} for update`;
      if (!before) return fail("Unknown flag.");
      if (before.enabled === enabled) return ok(`${k.data} is already ${enabled ? "on" : "off"}.`);
      await tx`update public.feature_flags set enabled = ${enabled}, updated_by = ${user.id}, updated_at = now() where key = ${k.data}`;
      await auditInStaffTx(tx, user, "flag.toggled", "feature_flag", k.data, { from: before.enabled, to: enabled });
      return ok(`${k.data} turned ${enabled ? "on" : "off"}. The change applies to new requests immediately.`);
    }),
  );
}
