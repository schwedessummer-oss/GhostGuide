import { loadEnv, databaseUrl, connect } from "../db/lib";
import { seedCore } from "./core";
import { seedDiscover } from "./discover";
import { seedCommerce } from "./commerce";
import { seedHike } from "./hike";
import { seedSafety } from "./safety";
import { seedAdmin } from "./admin";

loadEnv();

async function main() {
  const sql = connect(databaseUrl());
  try {
    const fresh = await seedCore(sql);
    if (fresh) {
      await seedDiscover(sql);
      await seedCommerce(sql);
      await seedHike(sql);
      await seedSafety(sql);
      await seedAdmin(sql);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
