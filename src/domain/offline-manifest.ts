/**
 * Offline trip-download manifest and completeness check (pure, no I/O).
 *
 * The server lists what a downloaded trip needs (hike page, help page,
 * bundle data, narration audio) and checksums where it can. The client adds
 * the pages' static assets, asks the service worker which URLs are present,
 * verifies checksums, and calls checkCompleteness() to tell the hiker
 * exactly what is missing or corrupted before they leave signal.
 */
export type ManifestItemKind = "page" | "data" | "audio";

export interface ManifestItem {
  key: string;
  kind: ManifestItemKind;
  url: string;
  /** sha256 hex of the item's content, when the server can provide it */
  sha256?: string;
  label?: string;
}

export interface OfflineManifest {
  version: number;
  generatedAt: string;
  items: ManifestItem[];
}

export interface CompletenessResult {
  complete: boolean;
  missing: string[];
  corrupted: string[];
}

/**
 * - missing:   an item whose key is not in `presentKeys`
 * - corrupted: a present item with a sha256 whose checksum did not verify
 *              (false) or could not be verified (absent from results)
 * A manifest with no items is never complete.
 */
export function checkCompleteness(
  manifest: Pick<OfflineManifest, "items">,
  presentKeys: Iterable<string>,
  checksumResults: Record<string, boolean> | Map<string, boolean> = {},
): CompletenessResult {
  const present = new Set(presentKeys);
  const get = (k: string): boolean | undefined =>
    checksumResults instanceof Map ? checksumResults.get(k) : (checksumResults as Record<string, boolean>)[k];
  const missing: string[] = [];
  const corrupted: string[] = [];
  const seen = new Set<string>();
  for (const item of manifest.items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    if (!present.has(item.key)) missing.push(item.key);
    else if (item.sha256 && get(item.key) !== true) corrupted.push(item.key);
  }
  return { complete: seen.size > 0 && missing.length === 0 && corrupted.length === 0, missing, corrupted };
}

/** Manifest items for a page's static assets (scripts, styles, fonts). */
export function assetItems(urls: string[]): ManifestItem[] {
  return [...new Set(urls)].sort().map((url) => ({ key: `asset:${url}`, kind: "page" as const, url, label: "App file" }));
}

/** Deterministic JSON for hashing a manifest (stable key and item order). */
export function canonicalManifestJson(manifest: OfflineManifest): string {
  const items = [...manifest.items]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((i) => ({ key: i.key, kind: i.kind, sha256: i.sha256 ?? null, url: i.url }));
  return JSON.stringify({ version: manifest.version, items });
}

/** Plain-language summary of a completeness result. */
export function describeCompleteness(result: CompletenessResult, manifest: Pick<OfflineManifest, "items">): string[] {
  const label = (key: string) => {
    const item = manifest.items.find((i) => i.key === key);
    return item?.label ?? key;
  };
  const lines: string[] = [];
  const group = (keys: string[], what: string) => {
    if (!keys.length) return;
    const names = [...new Set(keys.map(label))];
    lines.push(`${keys.length} ${keys.length === 1 ? "item" : "items"} ${what}: ${names.slice(0, 5).join(", ")}${names.length > 5 ? "…" : ""}`);
  };
  group(result.missing, "missing");
  group(result.corrupted, "failed verification");
  return lines;
}
