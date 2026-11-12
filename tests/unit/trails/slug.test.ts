import { describe, expect, it } from "vitest";
import {
  SLUG_MAX_LENGTH,
  SLUG_RE,
  countryCodeOrUnknown,
  cutSlug,
  pickFreeSlug,
  regionSlugFor,
  shortHash,
  slugWithSuffix,
  slugify,
  toSlugText,
} from "@/server/trails/slug";

describe("slugify", () => {
  it("lower-cases and hyphenates plain names", () => {
    expect(slugify("Table Rock Trail", null, "relation/1")).toBe("table-rock-trail");
    expect(slugify("  Raven Cliff  Falls   Trail ", null, "x")).toBe("raven-cliff-falls-trail");
    expect(slugify("Trail #7 (Upper)", null, "x")).toBe("trail-7-upper");
  });

  it("drops apostrophes and spells out ampersands", () => {
    expect(slugify("Devil's Den & Twin Falls", null, "x")).toBe("devils-den-and-twin-falls");
    expect(slugify("Hiker’s Loop", null, "x")).toBe("hikers-loop");
  });

  it("transliterates German names (umlauts via NFKD, ß → ss)", () => {
    expect(slugify("Höhenweg über die Zugspitze", null, "x")).toBe("hohenweg-uber-die-zugspitze");
    expect(slugify("Großer Arber Rundweg", null, "x")).toBe("grosser-arber-rundweg");
    expect(slugify("GROẞER WALDWEG", null, "x")).toBe("grosser-waldweg");
  });

  it("transliterates French names (accents, ligatures, elisions)", () => {
    expect(slugify("Sentier des Crêtes – Col de la Schlucht", null, "x")).toBe("sentier-des-cretes-col-de-la-schlucht");
    expect(slugify("Tour de l'Île d'Œuf", null, "x")).toBe("tour-de-lile-doeuf");
    expect(slugify("Chemin de Noël à Vézelay", null, "x")).toBe("chemin-de-noel-a-vezelay");
  });

  it("transliterates other Latin letters NFKD cannot decompose", () => {
    expect(slugify("Ærøskøbing Kyststi", null, "x")).toBe("aeroskobing-kyststi");
    expect(slugify("Łysica szlak", null, "x")).toBe("lysica-szlak");
    expect(slugify("Þingvellir", null, "x")).toBe("thingvellir");
    expect(slugify("Øvre Årdal sti", null, "x")).toBe("ovre-ardal-sti");
    expect(slugify("Đường mòn Fansipan", null, "x")).toBe("duong-mon-fansipan");
  });

  it("prefers an ASCII English name", () => {
    expect(slugify("高尾山 稲荷山コース", "Mount Takao Inariyama Course", "way/1")).toBe("mount-takao-inariyama-course");
    expect(slugify("Sentier du Lac", "Lake Path", "x")).toBe("lake-path");
  });

  it("falls back to a stable hash of the provider id for names with no Latin text (Japanese)", () => {
    const a = slugify("高尾山 稲荷山コース", null, "waygroup/123");
    expect(a).toMatch(/^trail-[0-9a-f]{10}$/);
    expect(slugify("高尾山 稲荷山コース", null, "waygroup/123")).toBe(a);
    expect(slugify("別の名前", null, "waygroup/123")).toBe(a); // the id, not the name, is hashed
    expect(slugify("高尾山 稲荷山コース", null, "waygroup/124")).not.toBe(a);
    expect(a).toBe(`trail-${shortHash("waygroup/123")}`);
  });

  it("keeps the Latin part of mixed-script names and uses a non-ASCII English name when the name has none", () => {
    expect(slugify("富士山 Yoshida Trail", null, "x")).toBe("yoshida-trail");
    expect(slugify("登山道", "Café Trail", "x")).toBe("cafe-trail");
    expect(slugify("Тропа", "", "relation/9")).toBe(`trail-${shortHash("relation/9")}`);
  });

  it("cuts long names to 80 characters at a word boundary", () => {
    const long = "The Very Long and Winding Ridge Trail Connecting Seven Summits Across the Northern Wilderness Area";
    const slug = slugify(long, null, "x");
    expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    expect(slug).toBe("the-very-long-and-winding-ridge-trail-connecting-seven-summits-across-the");
    expect(slug).toMatch(SLUG_RE);
    expect(`the-very-long-and-winding-ridge-trail-connecting-seven-summits-across-the-northern`.startsWith(slug)).toBe(true);
  });

  it("cuts a single overlong word hard", () => {
    const slug = slugify("a".repeat(200), null, "x");
    expect(slug).toBe("a".repeat(80));
  });

  it("always produces a slug the database accepts", () => {
    for (const name of ["---", "!!!", "   ", "a", "Ä", "日本", "x-y", "Ⅻ Trail", "ﬁeld path", "Ｔｒａｉｌ １"]) {
      const slug = slugify(name, null, `id/${name}`);
      expect(slug).toMatch(SLUG_RE);
      expect(slug.length).toBeLessThanOrEqual(SLUG_MAX_LENGTH);
    }
    expect(slugify("ﬁeld path", null, "x")).toBe("field-path");
    expect(slugify("Ｔｒａｉｌ １", null, "x")).toBe("trail-1");
  });
});

describe("cutSlug / toSlugText", () => {
  it("never ends with a hyphen and keeps exact-boundary cuts", () => {
    expect(cutSlug("abc-def", 3)).toBe("abc");
    expect(cutSlug("abc-def", 4)).toBe("abc");
    expect(cutSlug("abcdef-gh", 5)).toBe("abcde");
    expect(cutSlug("short", 80)).toBe("short");
  });

  it("returns empty text for nothing transliterable", () => {
    expect(toSlugText("東京")).toBe("");
    expect(toSlugText(null)).toBe("");
    expect(toSlugText(undefined)).toBe("");
  });
});

describe("regionSlugFor / countryCodeOrUnknown", () => {
  it("slugs region names with an 'unknown' fallback", () => {
    expect(regionSlugFor("British Columbia")).toBe("british-columbia");
    expect(regionSlugFor("Île-de-France")).toBe("ile-de-france");
    expect(regionSlugFor("Baden-Württemberg")).toBe("baden-wurttemberg");
    expect(regionSlugFor("Provence-Alpes-Côte d'Azur")).toBe("provence-alpes-cote-dazur");
    expect(regionSlugFor("東京都")).toBe("unknown");
    expect(regionSlugFor(null)).toBe("unknown");
    expect(regionSlugFor("")).toBe("unknown");
    expect(regionSlugFor("x".repeat(120)).length).toBeLessThanOrEqual(80);
  });

  it("accepts ISO alpha-2 codes only", () => {
    expect(countryCodeOrUnknown("US")).toBe("us");
    expect(countryCodeOrUnknown(" jp ")).toBe("jp");
    expect(countryCodeOrUnknown("USA")).toBe("xx");
    expect(countryCodeOrUnknown("1a")).toBe("xx");
    expect(countryCodeOrUnknown(null)).toBe("xx");
  });
});

describe("pickFreeSlug", () => {
  it("appends -2, -3, ... to the first free slot", () => {
    expect(pickFreeSlug("foo", new Set())).toBe("foo");
    expect(pickFreeSlug("foo", new Set(["foo"]))).toBe("foo-2");
    expect(pickFreeSlug("foo", new Set(["foo", "foo-2", "foo-3"]))).toBe("foo-4");
    expect(pickFreeSlug("foo", new Set(["foo-2"]))).toBe("foo");
    expect(slugWithSuffix("bar", 1)).toBe("bar");
    expect(slugWithSuffix("bar", 12)).toBe("bar-12");
  });

  it("stays deterministic when the search bound is exhausted", () => {
    const taken = new Set(["foo", "foo-2", "foo-3"]);
    const slug = pickFreeSlug("foo", taken, 3);
    expect(slug).toMatch(/^foo-[0-9a-f]{10}$/);
    expect(pickFreeSlug("foo", taken, 3)).toBe(slug);
  });
});
