import { afterEach, describe, expect, it } from "vitest";
import { env, resetEnvCache } from "@/config/env";

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
