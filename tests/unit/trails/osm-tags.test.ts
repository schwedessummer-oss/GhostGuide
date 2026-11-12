import { describe, expect, it } from "vitest";
import { OUTDOOR_POI_CATEGORIES, SERVICE_POI_CATEGORIES } from "@/domain/catalog";
import {
  POI_RULES,
  POI_PROVENANCE_KEYS,
  SAC_SCALE_ORDER,
  TRAIL_PROVENANCE_KEYS,
  aggregateActivities,
  aggregateDogPolicy,
  aggregateFee,
  aggregatePermit,
  aggregateSurfaces,
  aggregateWheelchair,
  classifyPoi,
  cleanLine,
  consensus,
  descriptionFromTags,
  dogPolicyFromTags,
  feeFromTags,
  highestSacScale,
  isRouteRelation,
  isTrailWayCandidate,
  matchesCondition,
  nameKey,
  namesFromTags,
  parseElevationM,
  permitFromTags,
  phoneFromTags,
  pickConsensusTags,
  pickTags,
  sanitizeUrl,
  seasonalityFromTags,
  surfacesFromTags,
  truncate,
  websiteFromTags,
  wheelchairFromTags,
  worstTrailVisibility,
  type OsmTags,
} from "@/server/trails/providers/osm/tags";

describe("osm tags: conditions", () => {
  const tags = { highway: "path", sport: "climbing; hiking", foot: "yes" };
  it("evaluates exists / in / not_in / list_has like Overpass filters", () => {
    expect(matchesCondition(tags, { key: "highway", op: "exists" })).toBe(true);
    expect(matchesCondition(tags, { key: "name", op: "exists" })).toBe(false);
    expect(matchesCondition(tags, { key: "highway", op: "in", values: ["path", "track"] })).toBe(true);
    expect(matchesCondition(tags, { key: "highway", op: "in", values: ["Path"] })).toBe(false); // case-sensitive
    expect(matchesCondition(tags, { key: "access", op: "not_in", values: ["private"] })).toBe(true); // absent
    expect(matchesCondition(tags, { key: "foot", op: "not_in", values: ["yes"] })).toBe(false);
    expect(matchesCondition(tags, { key: "sport", op: "list_has", values: ["hiking"] })).toBe(true);
    expect(matchesCondition(tags, { key: "sport", op: "list_has", values: ["hik"] })).toBe(false);
    expect(matchesCondition(tags, { key: "missing", op: "list_has", values: ["x"] })).toBe(false);
  });
  it("does not read inherited properties as tags", () => {
    expect(matchesCondition({}, { key: "constructor", op: "exists" })).toBe(false);
    expect(matchesCondition({}, { key: "toString", op: "not_in", values: ["x"] })).toBe(true);
  });
});

describe("osm tags: route relations and trail ways", () => {
  it("recognises hiking and foot routes only", () => {
    expect(isRouteRelation({ route: "hiking" })).toBe(true);
    expect(isRouteRelation({ route: "foot" })).toBe(true);
    expect(isRouteRelation({ route: "bicycle" })).toBe(false);
    expect(isRouteRelation({ route: "walking" })).toBe(false);
    expect(isRouteRelation({})).toBe(false);
  });

  const cases: [string, Record<string, string>, boolean][] = [
    ["named path", { highway: "path", name: "Ridge Trail" }, true],
    ["named footway", { highway: "footway", name: "Riverwalk" }, true],
    ["named bridleway", { highway: "bridleway", name: "Horse Trail" }, true],
    ["named steps", { highway: "steps", name: "Stairway" }, true],
    ["unnamed path", { highway: "path" }, false],
    ["blank name", { highway: "path", name: "   " }, false],
    ["residential road", { highway: "residential", name: "Main St" }, false],
    ["sidewalk", { highway: "footway", footway: "sidewalk", name: "Main Street" }, false],
    ["crossing", { highway: "footway", footway: "crossing", name: "Main Street" }, false],
    ["access aisle", { highway: "footway", footway: "access_aisle", name: "X" }, false],
    ["traffic island", { highway: "footway", footway: "traffic_island", name: "X" }, false],
    ["area", { highway: "footway", area: "yes", name: "Plaza" }, false],
    ["indoor", { highway: "footway", indoor: "yes", name: "Concourse" }, false],
    ["private", { highway: "path", access: "private", name: "Private Path" }, false],
    ["access=no", { highway: "path", access: "no", name: "Closed Path" }, false],
    ["private but foot=designated", { highway: "path", access: "private", foot: "designated", name: "Easement Trail" }, true],
    ["access=no but foot=permissive", { highway: "path", access: "no", foot: "permissive", name: "Permissive Trail" }, true],
    ["foot=no", { highway: "bridleway", foot: "no", name: "Horse Only" }, false],
    ["foot=private", { highway: "path", foot: "private", name: "Private Foot" }, false],
    ["plain named track (forest road)", { highway: "track", name: "Forest Road 123" }, false],
    ["track foot=designated", { highway: "track", foot: "designated", name: "Rail Trail" }, true],
    ["track foot=yes", { highway: "track", foot: "yes", name: "Old Road Trail" }, true],
    ["track with sac_scale", { highway: "track", sac_scale: "hiking", name: "Fire Road Trail" }, true],
    ["track with trail_visibility", { highway: "track", trail_visibility: "good", name: "Logging Trail" }, true],
    ["track foot=permissive only", { highway: "track", foot: "permissive", name: "Farm Track" }, false],
  ];
  it.each(cases)("%s", (_label, tags, expected) => {
    expect(isTrailWayCandidate(tags)).toBe(expected);
  });
});

describe("osm tags: POI classification", () => {
  const outdoor: [Record<string, string>, string | null, ("node" | "way" | "relation")?][] = [
    [{ highway: "trailhead" }, "trailhead"],
    [{ highway: "trailhead", amenity: "parking" }, "trailhead"],
    [{ amenity: "parking" }, "parking", "way"],
    [{ amenity: "parking", parking: "surface" }, "parking"],
    [{ amenity: "parking", parking: "underground" }, null],
    [{ amenity: "parking", parking: "multi-storey" }, null],
    [{ amenity: "parking", access: "private" }, null],
    [{ amenity: "parking", access: "customers" }, null],
    [{ amenity: "toilets" }, "toilets"],
    [{ amenity: "toilets", access: "private" }, null],
    [{ amenity: "drinking_water" }, "drinking_water"],
    [{ amenity: "drinking_water", drinking_water: "no" }, null],
    [{ man_made: "water_tap", drinking_water: "yes" }, "drinking_water"],
    [{ man_made: "water_tap" }, null],
    [{ amenity: "shelter" }, "shelter"],
    [{ amenity: "shelter", shelter_type: "picnic_shelter" }, "shelter"],
    [{ amenity: "shelter", shelter_type: "public_transport" }, null],
    [{ amenity: "shelter", shelter_type: "field_shelter" }, null],
    [{ tourism: "wilderness_hut" }, "shelter"],
    [{ tourism: "alpine_hut" }, "shelter"],
    [{ tourism: "camp_site" }, "campsite"],
    [{ tourism: "camp_pitch" }, null],
    [{ tourism: "viewpoint" }, "viewpoint"],
    [{ natural: "peak" }, "peak"],
    [{ natural: "volcano" }, "peak"],
    [{ natural: "peak" }, null, "way"],
    [{ waterway: "waterfall" }, "waterfall"],
    [{ natural: "waterfall" }, "waterfall"],
    [{ natural: "water", water: "lake", name: "Lake Oolenoy" }, "lake", "way"],
    [{ natural: "water", water: "reservoir", name: "Reservoir" }, "lake", "relation"],
    [{ natural: "water", water: "pond", name: "Pond" }, "lake", "way"],
    [{ natural: "water", water: "lake" }, null, "way"],
    [{ natural: "water", water: "river", name: "River" }, null, "way"],
    [{ natural: "spring" }, "spring"],
    [{ natural: "cave_entrance" }, "cave"],
    [{ tourism: "picnic_site" }, "picnic_site"],
    [{ leisure: "picnic_table" }, null],
    [{ amenity: "ranger_station" }, "ranger_station"],
    [{ tourism: "information", information: "visitor_centre" }, "information"],
    [{ tourism: "information", information: "office" }, "information"],
    [{ tourism: "information", information: "board" }, null],
    [{ tourism: "information", information: "guidepost" }, null],
    [{ amenity: "fuel" }, null], // services only
    [{ amenity: "restaurant" }, null],
  ];
  it.each(outdoor)("outdoor %j → %s", (tags, expected, type = "node") => {
    expect(classifyPoi("outdoor", type, tags)).toBe(expected);
  });

  const services: [Record<string, string>, string | null][] = [
    [{ amenity: "fuel" }, "fuel"],
    [{ amenity: "fuel", access: "private" }, null],
    [{ amenity: "charging_station" }, "ev_charging"],
    [{ amenity: "charging_station", motorcar: "no" }, null],
    [{ amenity: "restaurant" }, "restaurant"],
    [{ amenity: "fast_food" }, "fast_food"],
    [{ amenity: "cafe" }, "cafe"],
    [{ tourism: "hotel" }, "lodging"],
    [{ tourism: "motel" }, "lodging"],
    [{ tourism: "guest_house" }, "lodging"],
    [{ tourism: "hostel" }, "lodging"],
    [{ tourism: "chalet" }, "lodging"],
    [{ tourism: "camp_site" }, null],
    [{ shop: "supermarket" }, "supermarket"],
    [{ shop: "convenience" }, "convenience"],
    [{ shop: "outdoor" }, "outdoor_shop"],
    [{ shop: "sports", sport: "climbing" }, "outdoor_shop"],
    [{ shop: "sports", sport: "soccer;hiking" }, "outdoor_shop"],
    [{ shop: "sports", sport: "camping" }, "outdoor_shop"],
    [{ shop: "sports", sport: "golf" }, null],
    [{ shop: "sports" }, null],
    [{ amenity: "hospital" }, "hospital"],
    [{ amenity: "hospital", emergency: "yes" }, "hospital"],
    [{ amenity: "clinic" }, "clinic"],
    [{ amenity: "doctors" }, "clinic"],
    [{ amenity: "pharmacy" }, "pharmacy"],
    [{ amenity: "parking" }, null], // outdoor only
    [{ amenity: "toilets" }, null],
  ];
  it.each(services)("services %j → %s", (tags, expected) => {
    expect(classifyPoi("services", "node", tags)).toBe(expected);
  });

  it("every catalog POI category has at least one rule in the right layer", () => {
    for (const c of OUTDOOR_POI_CATEGORIES) expect(POI_RULES.some((r) => r.category === c && r.layer === "outdoor")).toBe(true);
    for (const c of SERVICE_POI_CATEGORIES) expect(POI_RULES.some((r) => r.category === c && r.layer === "services")).toBe(true);
    const all = new Set<string>([...OUTDOOR_POI_CATEGORIES, ...SERVICE_POI_CATEGORIES]);
    for (const r of POI_RULES) expect(all.has(r.category)).toBe(true);
  });
});

describe("osm tags: names and text", () => {
  it("cleans names and keeps name:en only when different", () => {
    expect(namesFromTags({ name: "  Table   Rock\tTrail " })).toEqual({ name: "Table Rock Trail", nameEn: null });
    expect(namesFromTags({ name: "Sentier du Lac", "name:en": "Lake Trail" })).toEqual({ name: "Sentier du Lac", nameEn: "Lake Trail" });
    expect(namesFromTags({ name: "Lake Trail", "name:en": "lake  trail" })).toEqual({ name: "Lake Trail", nameEn: null });
    expect(namesFromTags({ "name:en": "Only English" })).toEqual({ name: null, nameEn: "Only English" });
    expect(namesFromTags({})).toEqual({ name: null, nameEn: null });
  });

  it("normalizes grouping keys (case, whitespace, compatibility forms)", () => {
    expect(nameKey("Table  Rock Trail")).toBe(nameKey("table rock trail"));
    expect(nameKey("Ｔａｂｌｅ Rock")).toBe(nameKey("Table Rock")); // full-width letters (NFKC)
    expect(nameKey("Table Rock Trail")).not.toBe(nameKey("Table Rock Trails"));
  });

  it("strips control characters and caps length by code points", () => {
    expect(cleanLine("a\u0000b\u0007c")).toBe("abc");
    expect(cleanLine("   ")).toBeNull();
    expect(cleanLine(undefined)).toBeNull();
    expect(cleanLine("x".repeat(400))).toHaveLength(300);
    expect(truncate("😀😀😀", 2)).toBe("😀😀");
    expect(truncate("abc", 5)).toBe("abc");
  });

  it("trims descriptions to 2000 characters, keeping line breaks", () => {
    expect(descriptionFromTags({ description: "  Steep   climb.\n\n  Bring water.  " })).toBe("Steep climb.\nBring water.");
    expect(descriptionFromTags({ description: "y".repeat(5000) })).toHaveLength(2000);
    expect(descriptionFromTags({ description: " " })).toBeNull();
    expect(descriptionFromTags({})).toBeNull();
  });

  it("keeps only http(s) websites; prefixes bare domains", () => {
    expect(websiteFromTags({ website: "https://southcarolinaparks.com/table-rock" })).toBe("https://southcarolinaparks.com/table-rock");
    expect(websiteFromTags({ "contact:website": "http://example.org" })).toBe("http://example.org");
    expect(websiteFromTags({ url: "www.example.org/park" })).toBe("http://www.example.org/park");
    expect(websiteFromTags({ website: "javascript:alert(1)", url: "https://ok.example.com" })).toBe("https://ok.example.com");
    expect(websiteFromTags({ website: "https://a.example.com;https://b.example.com" })).toBe("https://a.example.com");
    expect(sanitizeUrl("data:text/html,hi")).toBeNull();
    expect(sanitizeUrl("mailto:ranger@example.com")).toBeNull();
    expect(sanitizeUrl("https://user:pw@example.com")).toBeNull();
    expect(sanitizeUrl("not a url")).toBeNull();
    expect(sanitizeUrl("http://localhost:3000")).toBeNull();
    expect(sanitizeUrl(undefined)).toBeNull();
    expect(websiteFromTags({})).toBeNull();
  });

  it("reads phone / contact:phone", () => {
    expect(phoneFromTags({ phone: " +1 864-878-9813 " })).toBe("+1 864-878-9813");
    expect(phoneFromTags({ "contact:phone": "+1 864 555 0100" })).toBe("+1 864 555 0100");
    expect(phoneFromTags({ phone: "n/a" })).toBeNull();
    expect(phoneFromTags({})).toBeNull();
  });
});

describe("osm tags: elevation", () => {
  const cases: [string | undefined, number | null][] = [
    ["1234", 1234],
    ["1234.6", 1235],
    ["1234,4", 1234],
    ["1234 m", 1234],
    ["1234m", 1234],
    ["1 234", null],
    ["1,234", 1234],
    ["1,234 m", 1234],
    ["4000 ft", 1219],
    ["4000ft", 1219],
    ["4000'", 1219],
    ["3,157 feet", 962],
    ["-28", -28],
    ["+12", 12],
    [" 950 ", 950],
    ["0", 0],
    [".5", 1],
    ["8848.86", 8849],
    ["12000", null],
    ["-1000", null],
    ["approx. 1200", null],
    ["1200-1300", null],
    ["unknown", null],
    ["", null],
    [undefined, null],
    ["NaN", null],
    ["1e3", null],
  ];
  it.each(cases)("%j → %s", (raw, expected) => {
    expect(parseElevationM(raw)).toBe(expected);
  });
});

describe("osm tags: difficulty scales and surfaces", () => {
  it("picks the hardest SAC value and ignores unknown values", () => {
    expect(SAC_SCALE_ORDER[0]).toBe("hiking");
    expect(highestSacScale([{ sac_scale: "hiking" }, { sac_scale: "demanding_mountain_hiking" }, { sac_scale: "mountain_hiking" }])).toBe(
      "demanding_mountain_hiking",
    );
    expect(highestSacScale([{ sac_scale: "T3" }, {}])).toBeNull();
    expect(highestSacScale([{ sac_scale: " Alpine_Hiking " }])).toBe("alpine_hiking");
    expect(highestSacScale([])).toBeNull();
  });

  it("picks the worst trail_visibility", () => {
    expect(worstTrailVisibility([{ trail_visibility: "excellent" }, { trail_visibility: "bad" }, { trail_visibility: "good" }])).toBe("bad");
    expect(worstTrailVisibility([{ trail_visibility: "no" }, { trail_visibility: "horrible" }])).toBe("no");
    expect(worstTrailVisibility([{ trail_visibility: "meh" }])).toBeNull();
  });

  it("splits surfaces and ranks them by mapped length", () => {
    expect(surfacesFromTags({ surface: "Gravel; dirt;gravel" })).toEqual(["gravel", "dirt"]);
    expect(surfacesFromTags({ surface: "<script>" })).toEqual([]);
    expect(surfacesFromTags({})).toEqual([]);
    expect(
      aggregateSurfaces([
        { tags: { surface: "dirt" }, weight: 300 },
        { tags: { surface: "asphalt" }, weight: 1200 },
        { tags: { surface: "dirt;rock" }, weight: 1000 },
        { tags: { surface: "wood" }, weight: Number.NaN },
        { tags: {}, weight: 5000 },
      ]),
    ).toEqual(["dirt", "asphalt", "rock", "wood"]);
  });
});

describe("osm tags: policies", () => {
  it("maps single-element tags", () => {
    expect(dogPolicyFromTags({ dog: "yes" })).toBe("allowed");
    expect(dogPolicyFromTags({ dog: "unleashed" })).toBe("allowed");
    expect(dogPolicyFromTags({ dog: "Leashed" })).toBe("leashed");
    expect(dogPolicyFromTags({ dog: "no" })).toBe("not_allowed");
    expect(dogPolicyFromTags({ dog: "maybe" })).toBe("unknown");
    expect(wheelchairFromTags({ wheelchair: "limited" })).toBe("limited");
    expect(wheelchairFromTags({ wheelchair: "designated" })).toBe("unknown");
    expect(feeFromTags({ fee: "yes" })).toBe(true);
    expect(feeFromTags({ fee: "no" })).toBe(false);
    expect(feeFromTags({ fee: "$5" })).toBeNull();
    expect(permitFromTags({ permit: "yes" })).toBe(true);
    expect(permitFromTags({ permit: "required" })).toBe(true);
    expect(permitFromTags({ access: "permit" })).toBe(true);
    expect(permitFromTags({ foot: "permit" })).toBe(true);
    expect(permitFromTags({ permit: "no" })).toBeNull();
    expect(permitFromTags({})).toBeNull();
  });

  it("the route's own value wins; members aggregate conservatively", () => {
    expect(aggregateDogPolicy({ dog: "yes" }, [{ dog: "no" }])).toBe("allowed");
    expect(aggregateDogPolicy(null, [{ dog: "yes" }, { dog: "leashed" }])).toBe("leashed");
    expect(aggregateDogPolicy(null, [{ dog: "yes" }, { dog: "no" }, { dog: "leashed" }])).toBe("not_allowed");
    expect(aggregateDogPolicy(null, [{ dog: "yes" }, { dog: "yes" }])).toBe("allowed");
    expect(aggregateDogPolicy(null, [{ dog: "yes" }, {}])).toBe("unknown");
    expect(aggregateDogPolicy({}, [])).toBe("unknown");

    expect(aggregateWheelchair(null, [{ wheelchair: "yes" }, { wheelchair: "yes" }])).toBe("yes");
    expect(aggregateWheelchair(null, [{ wheelchair: "yes" }, {}])).toBe("unknown");
    expect(aggregateWheelchair(null, [{ wheelchair: "yes" }, { wheelchair: "limited" }])).toBe("limited");
    expect(aggregateWheelchair(null, [{ wheelchair: "limited" }, { wheelchair: "no" }])).toBe("no");

    expect(aggregateFee({ fee: "no" }, [{ fee: "yes" }])).toBe(false);
    expect(aggregateFee(null, [{ fee: "no" }, { fee: "yes" }])).toBe(true);
    expect(aggregateFee(null, [{ fee: "no" }, { fee: "no" }])).toBe(false);
    expect(aggregateFee(null, [{ fee: "no" }, {}])).toBeNull();
    expect(aggregateFee(null, [])).toBeNull();

    expect(aggregatePermit(null, [{}, { access: "permit" }])).toBe(true);
    expect(aggregatePermit({ permit: "required" }, [])).toBe(true);
    expect(aggregatePermit({ permit: "no" }, [{}])).toBeNull();
  });

  it("consensus ignores missing values and gives up on disagreement", () => {
    expect(consensus("own", ["a"])).toBe("own");
    expect(consensus(null, ["a", null, "a"])).toBe("a");
    expect(consensus(null, ["a", "b"])).toBeNull();
    expect(consensus(null, [])).toBeNull();
  });

  it("seasonality from opening_hours or seasonal", () => {
    expect(seasonalityFromTags({ opening_hours: "Apr-Oct" })).toBe("Apr-Oct");
    expect(seasonalityFromTags({ opening_hours: "24/7", seasonal: "summer" })).toBe("summer");
    expect(seasonalityFromTags({ seasonal: "no" })).toBeNull();
    expect(seasonalityFromTags({ seasonal: "yes" })).toBe("yes");
    expect(seasonalityFromTags({})).toBeNull();
  });
});

describe("osm tags: activities", () => {
  const cases: [string, OsmTags | null, OsmTags[], string[]][] = [
    ["route=hiking", { route: "hiking" }, [], ["hiking"]],
    ["route=foot", { route: "foot" }, [], ["walking"]],
    ["path with sac_scale", null, [{ highway: "path", sac_scale: "hiking" }, { highway: "path" }], ["hiking"]],
    ["plain path (no evidence)", null, [{ highway: "path" }], []],
    ["footway", null, [{ highway: "footway" }], ["walking"]],
    ["foot=designated", null, [{ highway: "path", foot: "designated" }], ["walking"]],
    ["bicycle designated everywhere", null, [{ highway: "path", bicycle: "designated" }, { highway: "path", bicycle: "designated" }], ["biking"]],
    ["bicycle designated on part only", null, [{ highway: "path", bicycle: "designated" }, { highway: "path", bicycle: "yes" }], []],
    ["bicycle=yes is not designated", null, [{ highway: "path", bicycle: "yes" }], []],
    ["route bicycle=designated", { route: "hiking", bicycle: "designated" }, [{ highway: "path" }], ["hiking", "biking"]],
    ["bridleway", null, [{ highway: "bridleway" }], ["horse_riding"]],
    ["horse designated + bridleway", null, [{ highway: "bridleway" }, { highway: "path", horse: "designated" }], ["horse_riding"]],
    ["horse on part only", null, [{ highway: "bridleway" }, { highway: "footway" }], ["walking"]],
    [
      "everything, in canonical order",
      { route: "hiking", horse: "designated" },
      [{ highway: "footway", bicycle: "designated" }],
      ["hiking", "walking", "biking", "horse_riding"],
    ],
  ];
  it.each(cases)("%s", (_label, primary, members, expected) => {
    expect(aggregateActivities(primary, members)).toEqual(expected);
  });
});

describe("osm tags: provenance whitelist", () => {
  it("keeps only whitelisted keys, cleaned", () => {
    const tags = {
      name: "Table Rock Trail",
      ref: "TR",
      "osmc:symbol": "red::red_dot",
      sac_scale: "mountain_hiking",
      "addr:street": "1 Main St",
      phone: "+1 555 0100",
      fixme: "check",
      note: "private note",
      wikidata: "Q123",
    };
    expect(pickTags(tags, TRAIL_PROVENANCE_KEYS)).toEqual({
      name: "Table Rock Trail",
      ref: "TR",
      "osmc:symbol": "red::red_dot",
      sac_scale: "mountain_hiking",
      wikidata: "Q123",
    });
    expect(Object.keys(pickTags({ amenity: "toilets", phone: "1", "contact:email": "x@y.z" }, POI_PROVENANCE_KEYS))).toEqual(["amenity"]);
    expect(pickTags({ name: "x".repeat(300) }, ["name"]).name).toHaveLength(255);
  });

  it("keeps tags the ways agree on", () => {
    expect(
      pickConsensusTags(
        [
          { name: "Ridge Trail", surface: "dirt", sac_scale: "hiking" },
          { name: "Ridge Trail", surface: "rock" },
          { name: "Ridge Trail", highway: "path" },
        ],
        TRAIL_PROVENANCE_KEYS,
      ),
    ).toEqual({ name: "Ridge Trail", highway: "path", sac_scale: "hiking" });
  });
});
