import { execSync } from "node:child_process";
import { loadEnv, migrate, recreateDatabase, ROOT } from "./lib";

loadEnv();
(async () => {
  await recreateDatabase();
  await migrate();
  if (!process.argv.includes("--no-seed")) {
    execSync("npm run -s db:seed", { stdio: "inherit", cwd: ROOT, env: process.env });
  }
  console.log("Local database reset complete.");
})().catch((err) => {
  console.error("Reset failed:", err.message);
  process.exit(1);
});
