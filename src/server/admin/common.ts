import "server-only";
import { z } from "zod";
import { withSystem, withUser, type JsonValue, type Tx } from "@/server/db";
import { can, type Permission } from "@/server/auth/rbac";
import type { SessionUser } from "@/server/auth";
import { log, redact, redactString } from "@/server/log";
import { localDateInZone, localTimeInZone, zonedTimeToUtc } from "@/lib/time";

/**
 * Shared plumbing for admin use-cases.
 *
 * Every admin use-case takes an explicit `user: SessionUser`, checks the
 * RBAC permission first (throws ForbiddenError), then runs:
 *  - `staffTx(user, fn)`  — as the `authenticated` role (RLS applies), for
 *                           catalog/config tables whose policies admit staff;
 *  - `systemTx(fn)`       — as the owner role, ONLY for lifecycle / server-only
 *                           tables (jobs, gear_reservations, trip_permits,
 *                           weather_snapshots…) after the permission check.
 * Audit entries are appended in the same transaction as the change.
 */
export class ForbiddenError extends Error {
  readonly permission: Permission | string;
  constructor(permission: Permission | string, message?: string) {
    super(message ?? "You do not have permission to do that.");
    this.name = "ForbiddenError";
    this.permission = permission;
  }
}

export function assertCan(user: SessionUser | null | undefined, permission: Permission): asserts user is SessionUser {
  if (!user?.id || !can(user.roles, permission)) throw new ForbiddenError(permission);
}

export function hasRole(user: SessionUser, ...roles: string[]): boolean {
  return user.roles.some((r) => roles.includes(r));
}

export type ActionResult<D = undefined> =
  | { ok: true; message: string; warnings?: string[]; data?: D }
  | { ok: false; error: string; fieldErrors?: Record<string, string[]> };

export type FormState<D = unknown> = ActionResult<D> | undefined;

export const ok = <D = undefined>(message: string, extra: { warnings?: string[]; data?: D } = {}): ActionResult<D> => ({
  ok: true,
  message,
  ...extra,
});
export const fail = (error: string, fieldErrors?: Record<string, string[]>): { ok: false; error: string; fieldErrors?: Record<string, string[]> } => ({
  ok: false,
  error,
  ...(fieldErrors ? { fieldErrors } : {}),
});

/** "sourceId" → "Source", "effectiveTo" → "Effective to" (never shows internal keys). */
export function fieldLabel(path: readonly PropertyKey[]): string {
  const key = [...path].reverse().find((p): p is string => typeof p === "string") ?? "";
  const words = key
    .replace(/Id$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words[0].toUpperCase() + words.slice(1) : "";
}

/** zod's built-in (non-custom) messages need the field name for context. */
const GENERIC_ZOD_MESSAGE = /^(Invalid|Too (small|big)|Expected|Required)\b/;

/**
 * Form result for a failed zod parse. Messages are plain language: custom
 * messages are used as written; zod's generic ones get a readable field
 * label ("Capacity: Too small…"), never an internal key like "sourceId:".
 * `fieldErrors` stays keyed by path for programmatic use.
 */
export function zodFail(err: z.ZodError): { ok: false; error: string; fieldErrors: Record<string, string[]> } {
  const fieldErrors: Record<string, string[]> = {};
  const readable = (issue: z.core.$ZodIssue) => {
    const label = issue.path.length ? fieldLabel(issue.path) : "";
    return label && GENERIC_ZOD_MESSAGE.test(issue.message) ? `${label}: ${issue.message}` : issue.message;
  };
  for (const issue of err.issues) {
    const key = issue.path.length ? issue.path.join(".") : "_form";
    (fieldErrors[key] ??= []).push(readable(issue));
  }
  const first = err.issues[0];
  return { ok: false, error: first ? readable(first) : "Invalid input", fieldErrors };
}

/** Run as the signed-in staff member (RLS applies). */
export function staffTx<T>(user: SessionUser, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withUser(user, fn);
}

/** Trusted transaction for lifecycle/server-only tables. Call only after assertCan. */
export function systemTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withSystem(fn);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})?)?$/;

/**
 * Audit-metadata sanitizer. Same key-based redaction as the shared logger
 * (secrets, contact details, coordinates, bodies are dropped), but ids and
 * ISO dates are kept intact: the shared string scrubber treats long digit
 * runs as phone numbers, which would corrupt UUIDs and dates in the audit
 * trail. Other strings still go through the shared scrubber.
 */
export function sanitizeAuditMetadata(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string") return UUID_RE.test(value) || ISO_DATE_RE.test(value) ? value : redactString(value);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitizeAuditMetadata(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keySensitive = (redact({ [k]: 1 }) as Record<string, unknown>)[k] === "[redacted]";
      out[k] = keySensitive ? "[redacted]" : sanitizeAuditMetadata(v, depth + 1);
    }
    return out;
  }
  return value;
}

async function insertAudit(tx: Tx, user: SessionUser, action: string, entityType: string, entityId: string | null, metadata: Record<string, unknown>) {
  // Equivalent to recordAudit (src/server/audit.ts) with id/date-preserving sanitization.
  await tx`
    insert into public.audit_logs (actor_id, actor_roles, action, entity_type, entity_id, metadata)
    values (${user.id}, ${[...user.roles]}::text[], ${action}, ${entityType}, ${entityId},
            ${tx.json(sanitizeAuditMetadata(metadata) as JsonValue)})`;
}

/**
 * Append an audit entry inside a `staffTx` transaction. audit_logs is not
 * writable by API roles, so the insert runs as the owner role for this one
 * statement (same transaction, so the entry commits/rolls back with the
 * change), then the transaction switches back to `authenticated`.
 */
export async function auditInStaffTx(
  tx: Tx,
  user: SessionUser,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
) {
  await tx`set local role none`;
  await insertAudit(tx, user, action, entityType, entityId, metadata);
  await tx`set local role authenticated`;
}

/** Audit inside a `systemTx` transaction. */
export async function auditInSystemTx(
  tx: Tx,
  user: SessionUser,
  action: string,
  entityType: string,
  entityId: string | null,
  metadata: Record<string, unknown> = {},
) {
  await insertAudit(tx, user, action, entityType, entityId, metadata);
}

export function isRlsDenied(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  const msg = err instanceof Error ? err.message : "";
  return code === "42501" || /row-level security|permission denied/i.test(msg);
}

/**
 * Convert thrown errors from a mutation into a form result. Permission and
 * database-policy denials become readable messages; anything else is logged
 * and reported generically (nothing is leaked to the browser).
 */
export async function guarded<D>(fn: () => Promise<ActionResult<D>>, context = "admin.action"): Promise<ActionResult<D>> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof ForbiddenError) return fail(err.message);
    if (isRlsDenied(err)) return fail("The database refused this change for your role. Nothing was changed.");
    const code = (err as { code?: string } | null)?.code;
    if (code === "23505") return fail("That would create a duplicate. Nothing was changed.");
    if (code === "23503") return fail("This record is still referenced elsewhere, so it cannot be changed this way.");
    if (code === "23514") {
      const msg = err instanceof Error ? err.message : "";
      return fail(/last remaining admin/i.test(msg) ? "You cannot remove the last remaining admin role." : "That change breaks a data rule. Nothing was changed.");
    }
    log.error(`${context}.failed`, { error: err instanceof Error ? err.message : String(err) });
    return fail("Something went wrong. Nothing was changed.");
  }
}

// ---------------------------------------------------------------------------
// Pagination & filters
// ---------------------------------------------------------------------------
export const DEFAULT_PAGE_SIZE = 25;
export interface Page {
  limit: number;
  offset: number;
}
export interface Paged<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
}

const pageSchema = z.object({
  limit: z.coerce.number().int().min(5).max(100).catch(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().min(0).max(1_000_000).catch(0),
});

export function parsePage(input: { limit?: unknown; offset?: unknown } = {}): Page {
  return pageSchema.parse({ limit: input.limit ?? DEFAULT_PAGE_SIZE, offset: input.offset ?? 0 });
}

/** First value of a search param. */
export function sp(value: string | string[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v === undefined || v === "" ? undefined : v;
}

/** Escape LIKE wildcards in user input. */
export function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export const uuidSchema = z.uuid("Not a valid id");

export function isUuid(v: unknown): v is string {
  return uuidSchema.safeParse(v).success;
}

/** Optional trimmed text: "" -> null. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === "" ? null : v))
    .nullish()
    .transform((v) => v ?? null);

export { blankAsNull, notBlank } from "./number-fields";

export const requiredText = (min: number, max: number, label = "This field") =>
  z.string().trim().min(min, `${label} is required${min > 1 ? ` (at least ${min} characters)` : ""}.`).max(max, `${label} is too long.`);

export const httpUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  }, "Enter a full http(s) URL.");

export const httpsUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => {
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  }, "Official links must use https://.");

/** "YYYY-MM-DD" calendar date. */
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.").refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), "Not a real date.");

/** "YYYY-MM-DDTHH:MM" (datetime-local, wall clock in `timeZone`) → UTC Date. */
export function localDateTimeToUtc(value: string, timeZone: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(value.trim());
  if (!m) return null;
  try {
    const d = zonedTimeToUtc(m[1], m[2], timeZone);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

/** UTC instant → "YYYY-MM-DDTHH:MM" wall clock in `timeZone` (for datetime-local inputs). */
export function utcToLocalInput(value: Date | string | null, timeZone: string): string {
  if (!value) return "";
  const d = new Date(value);
  return `${localDateInZone(d, timeZone)}T${localTimeInZone(d, timeZone)}`;
}

export const localDateTime = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, "Use the date and time picker (YYYY-MM-DDTHH:MM).");
