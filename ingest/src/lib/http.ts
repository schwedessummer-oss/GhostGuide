/**
 * The HTTP client every adapter shares (PLAN §4.7 "good citizenship"):
 *
 *  - an identifying User-Agent with a contact URL (never a vercel.app host:
 *    Overpass rejects it);
 *  - every successful response cached under ingest/.cache/http, revalidated
 *    with If-None-Match / If-Modified-Since when the server sent an ETag or
 *    Last-Modified header;
 *  - a minimum interval between requests to the same host;
 *  - retries with exponential backoff (and Retry-After) on 429, 5xx and
 *    network errors.
 *
 * fetch, sleep, clock and randomness are injectable so tests never touch the
 * network.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export const USER_AGENT = "GhostGuideIngest/0.1 (+https://github.com/schwedessummer-oss/GhostGuide)";

/** Milliseconds between two requests to the same host. */
export const DEFAULT_HOST_INTERVALS: Readonly<Record<string, number>> = {
  "www.wikidata.org": 1_000,
  // SPARQL is slow for us (about one request a minute); only the QID resolver uses it.
  "query.wikidata.org": 60_000,
  "commons.wikimedia.org": 1_000,
  "en.wikivoyage.org": 1_000,
  "en.wikipedia.org": 1_000,
  "overpass-api.de": 10_000,
  "overpass.kumi.systems": 10_000,
  "s3.amazonaws.com": 200,
  "elevation-tiles-prod.s3.amazonaws.com": 200,
};
export const DEFAULT_INTERVAL_MS = 1_000;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly url: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export interface HttpClientOptions {
  /** Root of the ingest cache (ingest/.cache). Responses go to <cacheDir>/http. */
  cacheDir: string;
  userAgent?: string;
  hostIntervals?: Record<string, number>;
  defaultIntervalMs?: number;
  maxRetries?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  timeoutMs?: number;
  /** Serve from the cache only; a miss is an error. */
  offline?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

export interface HttpRequest {
  url: string;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  /** Serve a cached copy younger than this without contacting the server. */
  maxAgeMs?: number;
}

export interface HttpResponse {
  url: string;
  status: number;
  body: Buffer;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  /** sha256 of the body, hex. */
  contentHash: string;
  /** When the body was last confirmed by the server (fetched or revalidated). */
  retrievedAt: Date;
  fromCache: boolean;
  revalidated: boolean;
  /** Cache file of the raw payload, relative to the cache root (for source_records.raw_ref). */
  rawRef: string;
  text(): string;
  json<T = unknown>(): T;
}

interface CacheMeta {
  url: string;
  method: string;
  status: number;
  contentType: string | null;
  etag: string | null;
  lastModified: string | null;
  contentHash: string;
  retrievedAt: string;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_RETRY_AFTER_MS = 5 * 60_000;

export function sha256(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export class HttpClient {
  private readonly opts: Required<Omit<HttpClientOptions, "hostIntervals">> & { hostIntervals: Record<string, number> };
  /** Per-host queue: the time the next request may start, chained so concurrent callers wait their turn. */
  private readonly hostQueue = new Map<string, Promise<void>>();
  private readonly lastStart = new Map<string, number>();

  constructor(options: HttpClientOptions) {
    const userAgent = options.userAgent ?? USER_AGENT;
    if (/vercel\.app/i.test(userAgent)) throw new Error("User-Agent must not name a vercel.app host (Overpass rejects it).");
    if (!/\+https?:\/\//.test(userAgent)) throw new Error("User-Agent must carry a contact URL.");
    this.opts = {
      cacheDir: options.cacheDir,
      userAgent,
      hostIntervals: { ...DEFAULT_HOST_INTERVALS, ...(options.hostIntervals ?? {}) },
      defaultIntervalMs: options.defaultIntervalMs ?? DEFAULT_INTERVAL_MS,
      maxRetries: options.maxRetries ?? 4,
      baseBackoffMs: options.baseBackoffMs ?? 2_000,
      maxBackoffMs: options.maxBackoffMs ?? 60_000,
      timeoutMs: options.timeoutMs ?? 60_000,
      offline: options.offline ?? false,
      fetch: options.fetch ?? fetch,
      sleep: options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
    };
  }

  get userAgent(): string {
    return this.opts.userAgent;
  }

  /** Cache paths for a request: metadata JSON and raw body. */
  cachePaths(req: HttpRequest): { meta: string; body: string; rawRef: string } {
    const u = new URL(req.url);
    const method = req.method ?? "GET";
    const key = sha256(`${method} ${u.toString()}\n${req.body ?? ""}`);
    const rel = path.join("http", u.hostname, key.slice(0, 2), key);
    return {
      meta: path.join(this.opts.cacheDir, `${rel}.json`),
      body: path.join(this.opts.cacheDir, `${rel}.body`),
      rawRef: `${rel}.body`,
    };
  }

  async get(url: string, init: Omit<HttpRequest, "url" | "method"> = {}): Promise<HttpResponse> {
    return this.request({ ...init, url, method: "GET" });
  }

  async post(url: string, body: string, init: Omit<HttpRequest, "url" | "method" | "body"> = {}): Promise<HttpResponse> {
    return this.request({ ...init, url, body, method: "POST" });
  }

  async request(req: HttpRequest): Promise<HttpResponse> {
    const u = new URL(req.url);
    if (!/^https?:$/.test(u.protocol)) throw new HttpError(`Unsupported protocol in ${req.url}`, null, req.url);
    // Wikidata's api.php rate-limits us; entities come from Special:EntityData.
    if (u.hostname === "www.wikidata.org" && u.pathname.startsWith("/w/api.php")) {
      throw new HttpError("Use https://www.wikidata.org/wiki/Special:EntityData/<QID>.json, not api.php", null, req.url);
    }
    const paths = this.cachePaths(req);
    const cached = await this.readCache(paths);

    if (cached && (this.opts.offline || (req.maxAgeMs !== undefined && this.opts.now() - Date.parse(cached.meta.retrievedAt) < req.maxAgeMs))) {
      return this.toResponse(cached.meta, cached.body, paths.rawRef, true, false);
    }
    if (this.opts.offline) throw new HttpError(`Offline and not cached: ${req.url}`, null, req.url);

    // Callers cannot replace the identifying User-Agent.
    const headers: Record<string, string> = { ...(req.headers ?? {}), "User-Agent": this.opts.userAgent };
    if (cached?.meta.etag) headers["If-None-Match"] = cached.meta.etag;
    if (cached?.meta.lastModified) headers["If-Modified-Since"] = cached.meta.lastModified;

    const res = await this.fetchWithRetries(u, req, headers);
    if (res.status === 304 && cached) {
      const meta: CacheMeta = { ...cached.meta, retrievedAt: new Date(this.opts.now()).toISOString() };
      await this.writeFileAtomic(paths.meta, JSON.stringify(meta, null, 2));
      return this.toResponse(meta, cached.body, paths.rawRef, true, true);
    }
    if (res.status < 200 || res.status >= 300) {
      throw new HttpError(`HTTP ${res.status} for ${req.url}`, res.status, req.url);
    }
    const body = Buffer.from(await res.arrayBuffer());
    const meta: CacheMeta = {
      url: u.toString(),
      method: req.method ?? "GET",
      status: res.status,
      contentType: res.headers.get("content-type"),
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
      contentHash: sha256(body),
      retrievedAt: new Date(this.opts.now()).toISOString(),
    };
    await mkdir(path.dirname(paths.body), { recursive: true });
    await this.writeFileAtomic(paths.body, body);
    await this.writeFileAtomic(paths.meta, JSON.stringify(meta, null, 2));
    return this.toResponse(meta, body, paths.rawRef, false, false);
  }

  private async fetchWithRetries(u: URL, req: HttpRequest, headers: Record<string, string>): Promise<Response> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      await this.waitForHost(u.hostname);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      let res: Response | null = null;
      try {
        res = await this.opts.fetch(u.toString(), {
          method: req.method ?? "GET",
          headers,
          body: req.body,
          signal: controller.signal,
        });
      } catch (err) {
        lastError = err;
      } finally {
        clearTimeout(timer);
      }
      if (res && !RETRYABLE.has(res.status)) return res;
      if (attempt === this.opts.maxRetries) {
        if (res) return res;
        break;
      }
      const backoff = Math.min(this.opts.maxBackoffMs, this.opts.baseBackoffMs * 2 ** attempt);
      const jitter = backoff * 0.25 * this.opts.random();
      const retryAfter = res ? parseRetryAfter(res.headers.get("retry-after"), this.opts.now()) : null;
      await this.opts.sleep(Math.max(backoff + jitter, Math.min(retryAfter ?? 0, MAX_RETRY_AFTER_MS)));
    }
    const msg = lastError instanceof Error ? lastError.message : String(lastError);
    throw new HttpError(`Request failed after ${this.opts.maxRetries + 1} attempts: ${u.toString()} (${msg})`, null, u.toString());
  }

  private async waitForHost(host: string): Promise<void> {
    const interval = this.opts.hostIntervals[host] ?? this.opts.defaultIntervalMs;
    const previous = this.hostQueue.get(host) ?? Promise.resolve();
    const turn = previous.then(async () => {
      const last = this.lastStart.get(host);
      if (last !== undefined) {
        const wait = last + interval - this.opts.now();
        if (wait > 0) await this.opts.sleep(wait);
      }
      this.lastStart.set(host, this.opts.now());
    });
    this.hostQueue.set(host, turn.catch(() => undefined));
    await turn;
  }

  private async readCache(paths: { meta: string; body: string }): Promise<{ meta: CacheMeta; body: Buffer } | null> {
    try {
      const meta = JSON.parse(await readFile(paths.meta, "utf8")) as CacheMeta;
      const body = await readFile(paths.body);
      if (sha256(body) !== meta.contentHash) return null;
      return { meta, body };
    } catch {
      return null;
    }
  }

  private async writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, file);
  }

  private toResponse(meta: CacheMeta, body: Buffer, rawRef: string, fromCache: boolean, revalidated: boolean): HttpResponse {
    return {
      url: meta.url,
      status: meta.status,
      body,
      contentType: meta.contentType,
      etag: meta.etag,
      lastModified: meta.lastModified,
      contentHash: meta.contentHash,
      retrievedAt: new Date(meta.retrievedAt),
      fromCache,
      revalidated,
      rawRef,
      text: () => body.toString("utf8"),
      json: <T>() => JSON.parse(body.toString("utf8")) as T,
    };
  }
}

/** Retry-After as milliseconds from now (seconds or an HTTP date), or null. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Wikidata entity JSON (the endpoint that does not rate-limit us like api.php). */
export function wikidataEntityUrl(qid: string): string {
  if (!/^Q[1-9][0-9]*$/.test(qid)) throw new Error(`Not a Wikidata QID: ${qid}`);
  return `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`;
}
