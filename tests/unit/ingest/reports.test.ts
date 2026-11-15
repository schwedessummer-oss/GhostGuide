import { describe, expect, it } from "vitest";
import { renderSkipSection, replaceSection } from "../../../ingest/src/commands/report-skipped";
import { renderCoverage } from "../../../ingest/src/commands/report";

describe("report-skipped", () => {
  const section = renderSkipSection([
    {
      source: "commons",
      reason: "license_not_allowed",
      external_id: "File:Example.jpg",
      source_url: "https://commons.wikimedia.org/wiki/File:Example.jpg",
      license_text: "CC BY-NC 4.0",
      detail: "licence CC-BY-NC-4.0",
      first_seen: "2026-11-15",
      last_seen: "2026-11-15",
    },
  ]);

  it("renders a table of skips", () => {
    expect(section).toContain("## Run-time skips");
    expect(section).toContain(
      "| commons | license_not_allowed | [File:Example.jpg](https://commons.wikimedia.org/wiki/File:Example.jpg) | CC BY-NC 4.0 | licence CC-BY-NC-4.0 | 2026-11-15 | 2026-11-15 |",
    );
    expect(renderSkipSection([])).toContain("No records skipped at run time yet.");
  });

  it("replaces only its own section", () => {
    const doc = "# Skipped sources\n\n## Source decisions\n\n- kept\n\n## Run-time skips\n\n_old_\n";
    const updated = replaceSection(doc, section);
    expect(updated.startsWith("# Skipped sources\n\n## Source decisions\n\n- kept\n\n## Run-time skips\n")).toBe(true);
    expect(updated).not.toContain("_old_");
    expect(replaceSection(updated, section)).toBe(updated);

    const withTail = "# T\n\n## Run-time skips\n\nold\n\n## Later\n\ntail\n";
    expect(replaceSection(withTail, "## Run-time skips\n\nnew\n")).toBe("# T\n\n## Run-time skips\n\nnew\n\n## Later\n\ntail\n");
    expect(replaceSection("# T\n", "## Run-time skips\n\nnew\n")).toBe("# T\n\n## Run-time skips\n\nnew\n");
  });
});

describe("coverage report", () => {
  it("renders one row per hike plus totals", () => {
    const md = renderCoverage(
      [
        {
          seed_no: 1, slug: "half-dome", name: "Half Dome", status: "draft", distance: "official", gain: "osm", duration: true,
          best_months: false, permit: true, fees: true, rules: 2, parking: false, transport: true, photos: 0, route: false,
          wikivoyage: false, sources: 7,
        },
      ],
      [{ key: "official_site", n: 7 }],
      "2026-11-15",
    );
    expect(md).toContain("| 1 | Half Dome (`half-dome`) | draft | Y | osm | Y | - | Y | Y | 2 | - | Y | - | - | - | 7 |");
    expect(md).toContain("- Hikes: 1 (1 draft)");
    expect(md).toContain("- Source records stored, by data source: official_site 7");
    expect(renderCoverage([], [], "2026-11-15")).toContain("No hikes loaded yet.");
  });
});
