import { loadEnv, migrate } from "./lib";

loadEnv();
migrate()
  .then(() => console.log("Migrations up to date."))
  .catch((err) => {
    console.error("Migration failed:", err.message);
    process.exit(1);
  });
