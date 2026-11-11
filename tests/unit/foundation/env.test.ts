import { afterEach, describe, expect, it } from "vitest";
import { assertDatabaseConfigured, env, resetEnvCache } from "@/config/env";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
  resetEnvCache();
});

describe("env: public app URL", () => {
  it("falls back to the Vercel production domain when NEXT_PUBLIC_APP_URL is unset", () => {
    delete process.env.NEXT_PUBLIC_APP_URL;
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "ghost-guide.vercel.app";
    resetEnvCache();
    expect(env().NEXT_PUBLIC_APP_URL).toBe("https://ghost-guide.vercel.app");
  });
  it("an explicit NEXT_PUBLIC_APP_URL wins", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://hike.example.com";
    process.env.VERCEL_PROJECT_PRODUCTION_URL = "ghost-guide.vercel.app";
    resetEnvCache();
    expect(env().NEXT_PUBLIC_APP_URL).toBe("https://hike.example.com");
  });
});

describe("env: database configuration on Vercel", () => {
  it("throws a clear error on Vercel when DATABASE_URL is missing", () => {
    expect(() => assertDatabaseConfigured({ VERCEL: "1" })).toThrow(/DATABASE_URL is not set/);
  });
  it("passes on Vercel when DATABASE_URL is set", () => {
    expect(() => assertDatabaseConfigured({ VERCEL: "1", DATABASE_URL: "postgres://u:p@h:6543/db" })).not.toThrow();
  });
  it("keeps the local default outside Vercel", () => {
    expect(() => assertDatabaseConfigured({})).not.toThrow();
  });
});
