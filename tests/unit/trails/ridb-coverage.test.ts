/**
 * RIDB coverage boxes (src/server/trails/providers/ridb/coverage.ts): every
 * listed US place — including Alaska across the antimeridian, Hawaii, Puerto
 * Rico and the territories, and border towns — is covered; well-known places
 * in Canada, Mexico, the Caribbean, Russia and elsewhere are not. Points are
 * tested as ±0.02° boxes (about 2 km).
 */
import { describe, expect, it } from "vitest";
import type { Bbox } from "@/domain/catalog";
import { tileForPoint } from "@/server/geo/tiles";
import { ridbProvider } from "@/server/trails/providers/ridb";
import { US_COVERAGE_BOXES, boxesOverlap, coversUs, usBoxesFor } from "@/server/trails/providers/ridb/coverage";

const around = (lng: number, lat: number, d = 0.02): Bbox => [lng - d, lat - d, lng + d, lat + d];

const US: [string, number, number][] = [
  // Pacific Northwest and California
  ["Seattle, WA", -122.33, 47.61],
  ["Cape Flattery, WA", -124.71, 48.38],
  ["Friday Harbor (San Juan Islands), WA", -123.01, 48.53],
  ["Point Roberts, WA", -123.06, 48.98],
  ["Glacier NP, MT", -113.79, 48.7],
  ["Crater Lake, OR", -122.11, 42.94],
  ["Yosemite Valley, CA", -119.54, 37.75],
  ["San Diego, CA", -117.16, 32.72],
  ["Death Valley, CA", -116.87, 36.46],
  // Southwest and the Mexican border
  ["Grand Canyon Village, AZ", -112.11, 36.06],
  ["Yuma, AZ", -114.62, 32.69],
  ["San Luis, AZ", -114.78, 32.49],
  ["Organ Pipe Cactus visitor center, AZ", -112.8, 31.95],
  ["Lukeville, AZ", -112.82, 31.88],
  ["Tucson, AZ", -110.97, 32.22],
  ["Nogales, AZ", -110.94, 31.35],
  ["Columbus, NM", -107.64, 31.83],
  ["Antelope Wells, NM (bootheel)", -108.53, 31.34],
  ["Las Cruces, NM", -106.78, 32.32],
  ["Zion NP, UT", -113.03, 37.3],
  ["Rocky Mountain NP, CO", -105.68, 40.34],
  // Texas along the Rio Grande
  ["El Paso, TX", -106.44, 31.76],
  ["Fort Hancock, TX", -105.84, 31.3],
  ["Indian Hot Springs, TX", -105.31, 30.83],
  ["Candelaria, TX", -104.68, 30.14],
  ["Presidio, TX", -104.37, 29.56],
  ["Fort Stockton, TX", -102.88, 30.89],
  ["Santa Elena Canyon (Big Bend), TX", -103.6, 29.17],
  ["Chisos Basin (Big Bend), TX", -103.3, 29.27],
  ["Sanderson, TX", -102.4, 30.14],
  ["Del Rio, TX", -100.9, 29.36],
  ["Eagle Pass, TX", -100.5, 28.71],
  ["Laredo, TX", -99.51, 27.51],
  ["Zapata, TX", -99.27, 26.91],
  ["Rio Grande City, TX", -98.82, 26.38],
  ["McAllen, TX", -98.23, 26.2],
  ["Brownsville, TX", -97.5, 25.9],
  ["South Padre Island, TX", -97.17, 26.11],
  ["Corpus Christi, TX", -97.4, 27.8],
  ["Houston, TX", -95.37, 29.76],
  ["Guadalupe Mountains NP, TX", -104.86, 31.89],
  // Plains, Midwest and the Canadian border
  ["Yellowstone, WY", -110.59, 44.43],
  ["Theodore Roosevelt NP, ND", -103.45, 46.97],
  ["Northwest Angle, MN", -95.07, 49.35],
  ["Warroad, MN", -95.31, 48.9],
  ["International Falls, MN", -93.41, 48.6],
  ["Ely (Boundary Waters), MN", -91.87, 47.9],
  ["Grand Portage, MN", -89.68, 47.96],
  ["Isle Royale, MI", -88.9, 48.0],
  ["Sault Ste. Marie, MI", -84.35, 46.49],
  ["Detroit, MI", -83.05, 42.33],
  ["Chicago, IL", -87.63, 41.88],
  ["Apostle Islands, WI", -90.7, 47.0],
  // East
  ["Niagara Falls, NY", -79.06, 43.09],
  ["Oswego, NY", -76.51, 43.46],
  ["Cape Vincent, NY", -76.33, 44.13],
  ["Massena, NY", -74.89, 44.93],
  ["Montauk, NY", -71.86, 41.07],
  ["New York City, NY", -74.0, 40.71],
  ["Block Island, RI", -71.58, 41.17],
  ["Nantucket, MA", -70.1, 41.28],
  ["Pittsburg, NH", -71.39, 45.05],
  ["Acadia NP, ME", -68.21, 44.34],
  ["Lubec, ME", -66.98, 44.86],
  ["Calais, ME", -67.28, 45.18],
  ["Houlton, ME", -67.84, 46.13],
  ["Madawaska, ME", -68.32, 47.36],
  ["Washington, DC", -77.04, 38.9],
  ["Shenandoah NP, VA", -78.45, 38.53],
  ["Great Smoky Mountains NP, TN", -83.5, 35.6],
  ["Chincoteague, VA", -75.38, 37.93],
  ["Miami, FL", -80.19, 25.76],
  ["Key West, FL", -81.78, 24.56],
  ["Dry Tortugas, FL", -82.87, 24.63],
  ["Pensacola, FL", -87.2, 30.42],
  ["New Orleans, LA", -90.07, 29.95],
  ["Ship Island, MS", -88.9, 30.21],
  // Alaska
  ["Anchorage, AK", -149.9, 61.2],
  ["Denali, AK", -151.0, 63.07],
  ["Fairbanks, AK", -147.7, 64.84],
  ["Utqiagvik, AK", -156.79, 71.29],
  ["Nome, AK", -165.41, 64.5],
  ["Cape Prince of Wales, AK", -168.08, 65.64],
  ["Little Diomede, AK", -168.93, 65.75],
  ["Gambell (St. Lawrence Island), AK", -171.74, 63.78],
  ["St. Matthew Island, AK", -172.7, 60.4],
  ["St. Paul (Pribilofs), AK", -170.28, 57.12],
  ["Kodiak, AK", -152.4, 57.79],
  ["Cold Bay, AK", -162.72, 55.2],
  ["Unalaska, AK", -166.54, 53.89],
  ["Adak, AK", -176.66, 51.88],
  ["Amchitka, AK", 179.3, 51.5],
  ["Attu, AK", 172.9, 52.9],
  ["Juneau, AK", -134.42, 58.3],
  ["Glacier Bay, AK", -136.9, 58.6],
  ["Yakutat, AK", -139.73, 59.55],
  ["Ketchikan, AK", -131.65, 55.34],
  ["Cape Muzon, AK", -132.7, 54.67],
  // Hawaii and territories
  ["Honolulu, HI", -157.86, 21.31],
  ["Hawaii Volcanoes NP, HI", -155.25, 19.42],
  ["Ka Lae (South Point), HI", -155.68, 18.92],
  ["Haleakala, HI", -156.25, 20.72],
  ["Na Pali Coast, HI", -159.6, 22.17],
  ["Midway Atoll", -177.37, 28.21],
  ["San Juan, PR", -66.11, 18.47],
  ["El Yunque, PR", -65.78, 18.3],
  ["Vieques, PR", -65.44, 18.12],
  ["Mona Island, PR", -67.9, 18.09],
  ["Cruz Bay, St. John, USVI", -64.79, 18.33],
  ["Point Udall, St. Croix, USVI", -64.57, 17.75],
  ["Hagåtña, Guam", 144.75, 13.48],
  ["Saipan, CNMI", 145.75, 15.18],
  ["Pago Pago, American Samoa", -170.7, -14.28],
  ["Ofu, American Samoa", -169.65, -14.18],
  ["Swains Island, American Samoa", -171.08, -11.05],
];

const FOREIGN: [string, number, number][] = [
  ["Vancouver, BC", -123.12, 49.28],
  ["Victoria, BC", -123.37, 48.43],
  ["Sidney, BC", -123.4, 48.65],
  ["Calgary, AB", -114.07, 51.05],
  ["Winnipeg, MB", -97.14, 49.9],
  ["Thunder Bay, ON", -89.25, 48.42],
  ["Toronto, ON", -79.38, 43.65],
  ["Kingston, ON", -76.48, 44.23],
  ["Ottawa, ON", -75.7, 45.42],
  ["Montreal, QC", -73.57, 45.5],
  ["Sherbrooke, QC", -71.9, 45.4],
  ["Quebec City, QC", -71.2, 46.8],
  ["Woodstock, NB", -67.57, 46.15],
  ["Fredericton, NB", -66.64, 45.96],
  ["Saint John, NB", -66.06, 45.27],
  ["Prince Rupert, BC", -130.32, 54.31],
  ["Whitehorse, YT", -135.05, 60.72],
  ["Dawson City, YT", -139.43, 64.06],
  ["Mexico City", -99.13, 19.43],
  ["Monterrey, MX", -100.31, 25.69],
  ["Saltillo, MX", -101.0, 25.42],
  ["Chihuahua, MX", -106.09, 28.63],
  ["Hermosillo, MX", -110.95, 29.07],
  ["Ensenada, MX", -116.6, 31.87],
  ["Havana, Cuba", -82.38, 23.13],
  ["Nassau, Bahamas", -77.35, 25.06],
  ["Freeport, Bahamas", -78.7, 26.53],
  ["Bimini, Bahamas", -79.28, 25.73],
  ["Road Town, Tortola (BVI)", -64.62, 18.43],
  ["Provideniya, Russia", -173.23, 64.42],
  ["Uelen, Russia", -169.81, 66.16],
  ["Big Diomede, Russia", -169.05, 65.78],
  ["Bering Island (Komandorski), Russia", 166.2, 55.0],
  ["Apia, Samoa", -171.76, -13.83],
  ["London", -0.13, 51.5],
  ["Tokyo", 139.7, 35.7],
  ["Sydney", 151.2, -33.87],
  ["Zermatt", 7.75, 46.02],
];

describe("ridb coverage: US places", () => {
  for (const [name, lng, lat] of US) {
    it(`covers ${name}`, () => {
      expect(coversUs(around(lng, lat))).toBe(true);
      // and the 0.25° catalog tile that contains it
      expect(ridbProvider.covers(tileForPoint("outdoor", lng, lat).bbox)).toBe(true);
    });
  }
});

describe("ridb coverage: places outside the US", () => {
  for (const [name, lng, lat] of FOREIGN) {
    it(`does not cover ${name}`, () => {
      expect(usBoxesFor(around(lng, lat)).map((b) => b.name)).toEqual([]);
      expect(ridbProvider.covers(around(lng, lat))).toBe(false);
    });
  }
});

describe("ridb coverage: boxes", () => {
  it("are well-formed, named and unique", () => {
    const names = new Set<string>();
    for (const b of US_COVERAGE_BOXES) {
      const [w, s, e, n] = b.bbox;
      expect(b.name.length, JSON.stringify(b)).toBeGreaterThan(3);
      expect(names.has(b.name), b.name).toBe(false);
      names.add(b.name);
      expect(w >= -180 && e <= 180 && s >= -90 && n <= 90, b.name).toBe(true);
      expect(w < e && s < n, b.name).toBe(true);
      // No box is wider than the antimeridian-split Alaska boxes need.
      expect(e - w, b.name).toBeLessThan(40);
    }
  });

  it("covers areas that overlap a box, not areas that only touch its edge", () => {
    expect(boxesOverlap([0, 0, 1, 1], [1, 0, 2, 1])).toBe(false);
    expect(boxesOverlap([0, 0, 1, 1], [0.999, 0.999, 2, 2])).toBe(true);
    // The Yukon tile east of 141°W touches the Alaska mainland box only along its edge.
    expect(coversUs([-141.0, 64.0, -140.75, 64.25])).toBe(false);
    expect(coversUs([-141.25, 64.0, -141.0, 64.25])).toBe(true);
  });

  it("covers large areas that include the US, and rejects invalid input", () => {
    expect(coversUs([-180, -90, 180, 90])).toBe(true);
    expect(coversUs([-130, 20, -60, 55])).toBe(true);
    expect(coversUs([Number.NaN, 0, 1, 1] as Bbox)).toBe(false);
    expect(coversUs([2, 0, 1, 1] as Bbox)).toBe(false);
    expect(coversUs([-200, 0, 1, 1] as Bbox)).toBe(false);
    expect(coversUs(null as unknown as Bbox)).toBe(false);
  });
});
