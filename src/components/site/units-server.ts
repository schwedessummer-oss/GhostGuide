import "server-only";
import { cookies, headers } from "next/headers";
import { UNITS_COOKIE, parseUnits, unitsForLocale, type Units } from "@/lib/units";

/** The visitor's display units: their saved choice, else a default from Accept-Language. */
export async function getUnitsPreference(): Promise<Units> {
  const saved = parseUnits((await cookies()).get(UNITS_COOKIE)?.value);
  if (saved) return saved;
  return unitsForLocale((await headers()).get("accept-language"));
}
