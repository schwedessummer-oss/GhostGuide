import { describe, expect, it } from "vitest";
import { checkLicence, LICENCES, normaliseLicence } from "../../../ingest/src/lib/licence";

describe("licence mapper", () => {
  it.each([
    ["CC0-1.0", "CC0-1.0"],
    ["CC0", "CC0-1.0"],
    ["cc-by-sa-4.0", "CC-BY-SA-4.0"],
    ["CC BY-SA 4.0", "CC-BY-SA-4.0"],
    ["CC BY 2.0", "CC-BY-2.0"],
    ["CC BY 3.0 AU", "CC-BY-3.0-AU"],
    ["Creative Commons Attribution-ShareAlike 3.0 Unported", "CC-BY-SA-3.0"],
    ["Creative Commons Attribution 4.0 International", "CC-BY-4.0"],
    ["Public domain", "PD-other"],
    ["PD-USGov-NPS", "PD-USGov"],
    ["ODbL", "ODbL-1.0"],
    ["OGL-Canada-2.0", "OGL-CA-2.0"],
    ["Open Government Licence v3.0", "OGL-UK-3.0"],
    ["Licence Ouverte 2.0", "Etalab-2.0"],
    ["dl-de/by-2-0", "DL-DE-BY-2.0"],
    ["KOGL Type 1", "KOGL-1"],
    ["CITED-FACT", "CITED-FACT"],
    ["https://creativecommons.org/licenses/by-sa/4.0/", "CC-BY-SA-4.0"],
    ["https://creativecommons.org/licenses/by/3.0/au/", "CC-BY-3.0-AU"],
    ["http://creativecommons.org/publicdomain/zero/1.0/deed.en", "CC0-1.0"],
    ["https://creativecommons.org/publicdomain/mark/1.0/", "PD-other"],
    ["https://opendatacommons.org/licenses/odbl/1-0/", "ODbL-1.0"],
    ["https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/", "OGL-UK-3.0"],
    ["https://open.canada.ca/en/open-government-licence-canada", "OGL-CA-2.0"],
    ["https://data.norge.no/nlod/en/2.0", "NLOD-2.0"],
  ])("maps %s to %s and allows it", (input, code) => {
    expect(normaliseLicence(input)).toBe(code);
    expect(checkLicence(input)).toEqual({ ok: true, code, input });
  });

  it.each([
    ["CC BY-NC 4.0", "CC-BY-NC-4.0"],
    ["CC BY-NC-SA 4.0", "CC-BY-NC-SA-4.0"],
    ["cc-by-nd-3.0", "CC-BY-ND-3.0"],
    ["https://creativecommons.org/licenses/by-nc-nd/4.0/", "CC-BY-NC-ND-4.0"],
    ["Creative Commons Attribution-NonCommercial-ShareAlike 2.0 Generic", "CC-BY-NC-SA-2.0"],
    ["All rights reserved", "PROPRIETARY"],
    ["© Example Tours", "PROPRIETARY"],
  ])("rejects %s as not allowed (NC, ND or proprietary)", (input, code) => {
    expect(checkLicence(input)).toEqual({ ok: false, code, reason: "license_not_allowed", input });
  });

  it("rejects NC and ND variants it has no code for, without guessing a code", () => {
    expect(checkLicence("CC BY-NC 2.5")).toEqual({ ok: false, code: null, reason: "license_not_allowed", input: "CC BY-NC 2.5" });
    expect(checkLicence("KOGL Type 3")).toMatchObject({ ok: false, reason: "license_not_allowed" });
  });

  it.each(["", "   ", "GFDL", "Some licence", "UNKNOWN", "CC BY-SA 3.0 DE", "https://example.org/terms", "GG-USER-GRANT-1"])(
    "treats %j as unknown",
    (input) => {
      expect(checkLicence(input)).toMatchObject({ ok: false, code: null, reason: "license_unknown" });
    },
  );

  it("applies the stricter photo list", () => {
    expect(checkLicence("CC BY-SA 4.0", { photo: true })).toMatchObject({ ok: true });
    expect(checkLicence("ODbL", { photo: true })).toMatchObject({ ok: false, code: "ODbL-1.0", reason: "photo_license_not_allowed" });
    expect(checkLicence("OGL-UK-3.0", { photo: true })).toMatchObject({ ok: false, reason: "photo_license_not_allowed" });
  });

  it("never allows an NC, ND, proprietary or unknown code", () => {
    for (const [code, info] of Object.entries(LICENCES)) {
      if (/-N[CD](-|$)/.test(code) || code === "PROPRIETARY" || code === "UNKNOWN") expect(info.allowed, code).toBe(false);
      if (info.photoOk) expect(info.allowed, code).toBe(true);
    }
  });
});
