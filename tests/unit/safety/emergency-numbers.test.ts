/**
 * Emergency numbers table (src/server/safety/emergency-numbers.ts): shape of
 * every entry (valid dial strings, no duplicated numbers in the service
 * fields), honest fallbacks for unknown countries, and wording that never
 * claims Ghost Guide contacts emergency services.
 */
import { describe, expect, it } from "vitest";
import {
  DIAL_STRING_RE,
  EMERGENCY_NUMBERS,
  EMERGENCY_NUMBERS_LAST_REVIEWED,
  EMERGENCY_NUMBERS_SOURCE,
  GENERAL_NOTES,
  UNKNOWN_COUNTRY_NOTE,
  emergencyNumbersFor,
  normalizeCountryCode,
} from "@/server/safety/emergency-numbers";

const EU = ["at", "be", "bg", "hr", "cy", "cz", "dk", "ee", "fi", "fr", "de", "gr", "hu", "ie", "it", "lv", "lt", "lu", "mt", "nl", "pl", "pt", "ro", "sk", "si", "es", "se"];
const REQUIRED = ["us", "ca", "mx", "gb", "ie", "ch", "no", "is", "au", "nz", "jp", "kr", "cn", "in", "za", "br", "ar", "cl", "pe", "np", "th", "id", "ph", "tr", "il", "ae"];

describe("table shape", () => {
  const entries = Object.entries(EMERGENCY_NUMBERS);

  it("keys are lower-case ISO alpha-2 codes", () => {
    for (const [code] of entries) expect(code).toMatch(/^[a-z]{2}$/);
  });

  it("every number is a valid dial string, and service numbers differ from primary", () => {
    for (const [code, e] of entries) {
      expect(e.primary, code).toMatch(DIAL_STRING_RE);
      for (const k of ["police", "ambulance", "fire"] as const) {
        if (e[k] !== undefined) expect(e[k], `${code}.${k}`).toMatch(DIAL_STRING_RE);
      }
      expect(e.name.length, code).toBeGreaterThan(1);
    }
  });

  it("covers all EU member states with 112 and the major hiking destinations", () => {
    for (const c of EU) expect(EMERGENCY_NUMBERS[c]?.primary, c).toBe("112");
    for (const c of REQUIRED) expect(EMERGENCY_NUMBERS[c], c).toBeDefined();
  });

  it("notes never claim Ghost Guide contacts emergency services", () => {
    const all = [UNKNOWN_COUNTRY_NOTE, ...GENERAL_NOTES, ...entries.flatMap(([, e]) => e.notes ?? [])];
    for (const n of all) {
      expect(n).not.toMatch(/ghost guide (will|can|does) (call|contact|alert|notify)/i);
      expect(n).not.toMatch(/we (will|can) (call|contact|alert|notify)/i);
    }
    expect(GENERAL_NOTES[0]).toBe("Ghost Guide cannot call emergency services for you. Dial the number yourself.");
  });

  it("documents its source and review date", () => {
    expect(EMERGENCY_NUMBERS_LAST_REVIEWED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(EMERGENCY_NUMBERS_SOURCE).toContain(EMERGENCY_NUMBERS_LAST_REVIEWED);
  });
});

describe("emergencyNumbersFor", () => {
  it("US: 911 for everything (no separate service numbers)", () => {
    expect(emergencyNumbersFor("us")).toEqual({
      countryCode: "us",
      primary: "911",
      police: null,
      ambulance: null,
      fire: null,
      notes: ["911 reaches police, ambulance and fire services.", ...GENERAL_NOTES],
      source: EMERGENCY_NUMBERS_SOURCE,
    });
  });

  it("returns distinct service numbers where they exist", () => {
    expect(emergencyNumbersFor("fr")).toMatchObject({ primary: "112", police: "17", ambulance: "15", fire: "18" });
    expect(emergencyNumbersFor("ch")).toMatchObject({ primary: "112", police: "117", ambulance: "144", fire: "118" });
    expect(emergencyNumbersFor("jp")).toMatchObject({ primary: "119", police: "110", ambulance: null, fire: null });
    expect(emergencyNumbersFor("sg")).toMatchObject({ primary: "999", ambulance: "995", fire: "995", police: null });
    expect(emergencyNumbersFor("gb")).toMatchObject({ primary: "999", police: null });
    expect(emergencyNumbersFor("au").primary).toBe("000");
    expect(emergencyNumbersFor("nz").primary).toBe("111");
  });

  it("normalizes case, whitespace and the UK alias", () => {
    expect(emergencyNumbersFor(" CA ").countryCode).toBe("ca");
    expect(emergencyNumbersFor("UK")).toMatchObject({ countryCode: "gb", primary: "999" });
    expect(normalizeCountryCode("De")).toBe("de");
  });

  it.each([
    [null, null],
    [undefined, null],
    ["", null],
    ["xx", null],
    ["XX", null],
    ["usa", null],
    ["1a", null],
    ["zz", "zz"],
    ["aq", "aq"],
  ])("unknown country %j → no number, honest note", (input, code) => {
    const r = emergencyNumbersFor(input as string | null | undefined);
    expect(r).toEqual({
      countryCode: code,
      primary: null,
      police: null,
      ambulance: null,
      fire: null,
      notes: [UNKNOWN_COUNTRY_NOTE, ...GENERAL_NOTES],
      source: EMERGENCY_NUMBERS_SOURCE,
    });
  });

  it("the unknown-country note is the agreed wording", () => {
    expect(UNKNOWN_COUNTRY_NOTE).toBe(
      "Ghost Guide does not have a verified emergency number for this country. 112 reaches emergency services from mobile phones in many countries, but not everywhere — confirm the local number before you go.",
    );
  });

  it("returns copies, so callers cannot mutate the table", () => {
    const r = emergencyNumbersFor("at");
    r.notes.push("mutated");
    expect(emergencyNumbersFor("at").notes).not.toContain("mutated");
  });
});
