/**
 * Pure parts of the coverage service (src/server/trails/coverage.ts): the
 * honest status when work could not be queued (global queue full, client
 * budget spent), supplementary POI-only providers never deciding trail
 * coverage, row states, and the inline fetch cap that keeps a slot for the
 * job runner. The database paths are in tests/integration/trails/coverage*.test.ts.
 */
import { describe, expect, it } from "vitest";
import {
  CLIENT_LOAD_BUDGET,
  MAX_NEW_TILES_PER_REQUEST,
  MAX_QUEUED_TILE_LOADS,
  INLINE_FETCH_BUDGET_MS,
  INLINE_INGEST_BUDGET_MS,
  inlineConcurrencyCap,
  isSupplementaryProvider,
  rowState,
  summarizeCoverage,
} from "@/server/trails/coverage";
import { CLIENT_TIMEOUT_MARGIN_SEC } from "@/server/trails/providers/osm";
import { DEFAULT_OVERPASS_TIMEOUT_SEC } from "@/server/trails/providers/osm/query";
import { fetchConcurrencyFor } from "@/server/trails/providers/registry";

const base = {
  layer: "outdoor" as const,
  tilesTotal: 4,
  ready: 0,
  loading: 0,
  failed: 0,
  missing: 0,
  oldestSyncAt: null,
  tooLarge: false,
  sources: "OpenStreetMap",
};

describe("summarizeCoverage: work that could not be queued", () => {
  it("nothing loaded and the queue is full: failed, saying why and when to retry (never 'no trails here')", () => {
    const c = summarizeCoverage({ ...base, missing: 4, deferred: "busy" });
    expect(c.state).toBe("failed");
    expect(c.message).toBe("Many areas are waiting to be loaded right now, so this one was not queued. Please try again in a few minutes.");
  });

  it("part loaded and the client's budget is spent: partial, showing what is loaded", () => {
    const c = summarizeCoverage({ ...base, ready: 1, missing: 3, deferred: "client_budget" });
    expect(c.state).toBe("partial");
    expect(c.message).toBe(
      "Many new areas were requested from your network in the last few minutes, so this one was not queued. Showing what is already loaded; please try again in a few minutes.",
    );
  });

  it("while some tiles are loading, the loading status wins (polling continues)", () => {
    expect(summarizeCoverage({ ...base, loading: 2, missing: 2, deferred: "busy" }).state).toBe("loading");
  });

  it("a deferral with nothing missing changes nothing", () => {
    expect(summarizeCoverage({ ...base, ready: 4, deferred: "busy" })).toMatchObject({ state: "ready", message: "Trails for this area are loaded from OpenStreetMap." });
  });
});

describe("summarizeCoverage: supplementary providers", () => {
  it("notes a supplementary failure without degrading trail coverage or blaming the trail source", () => {
    const c = summarizeCoverage({ ...base, ready: 4, supplementaryFailed: "Recreation.gov" });
    expect(c.state).toBe("ready");
    expect(c.message).toBe("Trails for this area are loaded from OpenStreetMap. Recreation.gov data could not be loaded for part of this area right now.");
  });

  it("RIDB is supplementary on the outdoor layer; OpenStreetMap never is", () => {
    expect(isSupplementaryProvider("outdoor", "ridb")).toBe(true);
    expect(isSupplementaryProvider("outdoor", "osm")).toBe(false);
    expect(isSupplementaryProvider("services", "osm")).toBe(false);
  });
});

describe("summarizeCoverage: too large", () => {
  it("says that only the middle of the area is shown", () => {
    const c = summarizeCoverage({ ...base, tilesTotal: 5000, tooLarge: true });
    expect(c.state).toBe("too_large");
    expect(c.message).toBe("Zoom in to load trails for this area. Showing trails already loaded near the middle of this area.");
  });
});

describe("rowState", () => {
  it("a pending row is loading only while its load is queued or running", () => {
    expect(rowState({ status: "pending", lastSyncedAt: null, jobStatus: "queued" })).toBe("loading");
    expect(rowState({ status: "pending", lastSyncedAt: null, jobStatus: "running" })).toBe("loading");
    expect(rowState({ status: "pending", lastSyncedAt: null, jobStatus: "cancelled" })).toBe("missing");
    expect(rowState({ status: "pending", lastSyncedAt: null, jobStatus: null })).toBe("missing");
    expect(rowState({ status: "fetching", lastSyncedAt: null, jobStatus: null })).toBe("loading");
    expect(rowState({ status: "failed", lastSyncedAt: null, jobStatus: "dead" })).toBe("failed");
  });
});

describe("work bounds", () => {
  it("an inline run never takes a provider's last fetch slot", () => {
    expect(fetchConcurrencyFor("osm")).toBe(2);
    expect(inlineConcurrencyCap("osm")).toBe(1);
    expect(inlineConcurrencyCap("ridb")).toBe(fetchConcurrencyFor("ridb") - 1);
  });

  it("an inline fetch budget covers one whole Overpass attempt", () => {
    expect(INLINE_FETCH_BUDGET_MS).toBeGreaterThanOrEqual((DEFAULT_OVERPASS_TIMEOUT_SEC + CLIENT_TIMEOUT_MARGIN_SEC) * 1000);
    expect(INLINE_INGEST_BUDGET_MS).toBeGreaterThan(INLINE_FETCH_BUDGET_MS);
  });

  it("per request, per client and global limits are ordered sensibly", () => {
    expect(MAX_NEW_TILES_PER_REQUEST).toBeGreaterThanOrEqual(1);
    expect(CLIENT_LOAD_BUDGET).toBeGreaterThanOrEqual(MAX_NEW_TILES_PER_REQUEST * 2);
    expect(MAX_QUEUED_TILE_LOADS).toBeGreaterThan(CLIENT_LOAD_BUDGET);
  });
});
