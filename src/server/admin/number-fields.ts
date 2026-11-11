import { z } from "zod";

/*
 * Number form fields (pure; safe for shared/client modules). The blank check
 * runs BEFORE number coercion: Number("") and Number(null) are 0, so
 * `z.union([z.coerce.number()…, z.literal("")])` silently stores 0 — closing
 * a day, zeroing a price or lead time, putting a trailhead at 0,0 — instead
 * of "no value" or an error.
 */
const isBlank = (v: unknown) => v === undefined || v === null || (typeof v === "string" && v.trim() === "");
const trimString = (v: unknown) => (typeof v === "string" ? v.trim() : v);

/** Optional number field: blank (empty, spaces, null, undefined) → null. */
export function blankAsNull<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => (isBlank(v) ? null : trimString(v)), z.union([z.null(), schema]));
}

/** Required number field: blank is an error with `message`, never coerced to 0. */
export function notBlank<T extends z.ZodType>(schema: T, message = "This field is required.") {
  return z.preprocess(trimString, z.unknown().refine((v) => !isBlank(v), message).pipe(schema));
}
