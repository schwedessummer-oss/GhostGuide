/**
 * One-time Supabase Storage setup: creates the PRIVATE bucket used for route
 * files and narration audio. Run with NEXT_PUBLIC_SUPABASE_URL and
 * SUPABASE_SECRET_KEY set:  npx tsx scripts/setup-supabase-storage.ts
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./db/lib";

loadEnv();

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? "trail-media";
  if (!url || !key) throw new Error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SECRET_KEY");
  const storage = createClient(url, key, { auth: { persistSession: false } }).storage;
  const { data: existing } = await storage.getBucket(bucket);
  if (existing) {
    if (existing.public) throw new Error(`Bucket ${bucket} exists but is PUBLIC. Make it private before use.`);
    console.log(`Bucket ${bucket} already exists (private).`);
    return;
  }
  const { error } = await storage.createBucket(bucket, {
    public: false,
    fileSizeLimit: "25MB",
    allowedMimeTypes: ["application/json", "application/geo+json", "application/gpx+xml", "application/xml", "text/xml", "audio/mpeg", "audio/mp4", "audio/ogg"],
  });
  if (error) throw error;
  console.log(`Created private bucket ${bucket}.`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
