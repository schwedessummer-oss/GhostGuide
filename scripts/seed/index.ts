import { loadEnv, databaseUrl, connect } from "../db/lib";
import { seedCore } from "./core";

loadEnv();

/** Slice seeds run after the core seed on a fresh database. SEED_ONLY=commerce,hike limits which run. */
const SLICES = ["discover", "commerce", "hike", "safety", "admin"] as const;

async function main() {
  const only = (process.env.SEED_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const sql = connect(databaseUrl());
  try {
    const fresh = await seedCore(sql);
    if (fresh) {
      for (const slice of SLICES) {
        if (only.length && !only.includes(slice)) continue;
        const mod = await import(`./${slice}`);
        const fn = mod[`seed${slice[0].toUpperCase()}${slice.slice(1)}`];
        if (typeof fn === "function") await fn(sql);
      }
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
