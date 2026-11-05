import path from "node:path";
import { defineConfig } from "vitest/config";

const alias = {
  "@": path.resolve(import.meta.dirname, "src"),
  // `server-only` throws outside the React Server Components runtime.
  "server-only": path.resolve(import.meta.dirname, "tests/helpers/empty-module.ts"),
};

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:54322/ghostguide_test";

export default defineConfig({
  resolve: { alias },
  test: {
    projects: [
      {
        resolve: { alias },
        test: {
          name: "unit",
          environment: "node",
          include: ["tests/unit/**/*.test.ts", "src/**/*.test.ts"],
          env: { NODE_ENV: "test", APP_MODE: "demo" },
        },
      },
      {
        resolve: { alias },
        test: {
          name: "integration",
          environment: "node",
          include: ["tests/integration/**/*.test.ts"],
          globalSetup: ["tests/helpers/integration-global-setup.ts"],
          // Integration tests share one database: run files sequentially.
          fileParallelism: false,
          testTimeout: 30_000,
          hookTimeout: 120_000,
          env: {
            NODE_ENV: "test",
            APP_MODE: "demo",
            AUTH_PROVIDER: "demo",
            PAYMENTS_PROVIDER: "demo",
            AI_PROVIDER: "demo",
            NOTIFY_PROVIDER: "demo",
            WEATHER_PROVIDER: "demo",
            STORAGE_PROVIDER: "local",
            LOCAL_STORAGE_DIR: ".data/test-storage",
            AUTH_SECRET: "test-secret-0123456789abcdef0123456789abcdef",
            CRON_SECRET: "test-cron-secret-0123456789",
            DATABASE_URL: TEST_DATABASE_URL,
          },
        },
      },
    ],
  },
});
