import "server-only";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/config/env";
import { hmac, safeEqual } from "@/server/auth/tokens";

/**
 * Object storage for route files and narration audio.
 *  local    — files under LOCAL_STORAGE_DIR, served by /api/media with
 *             HMAC-signed, expiring URLs (demo / development).
 *  supabase — Supabase Storage private bucket with signed URLs.
 */
export interface ObjectStorage {
  readonly kind: "local" | "supabase";
  put(objectPath: string, data: Uint8Array, contentType: string): Promise<void>;
  get(objectPath: string): Promise<{ data: Uint8Array; contentType: string } | null>;
  signedUrl(objectPath: string, ttlSec: number): Promise<string>;
  remove(objectPath: string): Promise<void>;
}

export function assertSafeObjectPath(p: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]{0,255}$/.test(p) || p.includes("..")) throw new Error("Unsafe object path");
  return p;
}

const CONTENT_TYPES: Record<string, string> = {
  ".json": "application/json",
  ".geojson": "application/geo+json",
  ".gpx": "application/gpx+xml",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

class LocalStorage implements ObjectStorage {
  readonly kind = "local" as const;
  // Demo-only local storage; excluded from output file tracing.
  private root = path.resolve(/*turbopackIgnore: true*/ process.cwd(), env().LOCAL_STORAGE_DIR);
  private full(p: string) {
    return path.join(this.root, assertSafeObjectPath(p));
  }
  async put(p: string, data: Uint8Array) {
    const f = this.full(p);
    await mkdir(path.dirname(f), { recursive: true });
    await writeFile(f, data);
  }
  async get(p: string) {
    try {
      const data = await readFile(this.full(p));
      return { data: new Uint8Array(data), contentType: CONTENT_TYPES[path.extname(p)] ?? "application/octet-stream" };
    } catch {
      return null;
    }
  }
  async signedUrl(p: string, ttlSec: number) {
    assertSafeObjectPath(p);
    const exp = Math.floor(Date.now() / 1000) + ttlSec;
    const sig = hmac(env().AUTH_SECRET, `media:${p}:${exp}`);
    return `/api/media/${p}?exp=${exp}&sig=${sig}`;
  }
  async remove(p: string) {
    await rm(this.full(p), { force: true });
  }
}

export function verifyLocalMediaSignature(p: string, exp: string | null, sig: string | null): boolean {
  if (!exp || !sig) return false;
  if (Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, hmac(env().AUTH_SECRET, `media:${p}:${exp}`));
}

class SupabaseStorage implements ObjectStorage {
  readonly kind = "supabase" as const;
  private client() {
    const e = env();
    if (!e.NEXT_PUBLIC_SUPABASE_URL || !e.SUPABASE_SECRET_KEY) throw new Error("Supabase storage not configured");
    return createClient(e.NEXT_PUBLIC_SUPABASE_URL, e.SUPABASE_SECRET_KEY, { auth: { persistSession: false } }).storage.from(
      e.SUPABASE_STORAGE_BUCKET,
    );
  }
  async put(p: string, data: Uint8Array, contentType: string) {
    const { error } = await this.client().upload(assertSafeObjectPath(p), data, { contentType, upsert: true });
    if (error) throw new Error(`Storage upload failed: ${error.message}`);
  }
  async get(p: string) {
    const { data, error } = await this.client().download(assertSafeObjectPath(p));
    if (error || !data) return null;
    return { data: new Uint8Array(await data.arrayBuffer()), contentType: data.type };
  }
  async signedUrl(p: string, ttlSec: number) {
    const { data, error } = await this.client().createSignedUrl(assertSafeObjectPath(p), ttlSec);
    if (error || !data) throw new Error(`Could not sign storage URL: ${error?.message}`);
    return data.signedUrl;
  }
  async remove(p: string) {
    await this.client().remove([assertSafeObjectPath(p)]);
  }
}

let instance: ObjectStorage | null = null;
export function storage(): ObjectStorage {
  if (!instance) instance = env().STORAGE_PROVIDER === "supabase" ? new SupabaseStorage() : new LocalStorage();
  return instance;
}
