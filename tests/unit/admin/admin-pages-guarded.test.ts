import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/*
 * The admin layout does not redirect signed-out visitors itself (a layout
 * has no pathname, so it would always say next=/admin). Each admin page must
 * therefore call requirePermission(…, "<its own path>") so that a signed-out
 * deep link returns to the page that was asked for after sign-in, and so the
 * page is protected on its own.
 */
const ADMIN_DIR = path.resolve(import.meta.dirname, "../../../src/app/admin");

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return pages(full);
    return name === "page.tsx" ? [full] : [];
  });
}

describe("admin pages guard themselves with their own return path", () => {
  const files = pages(ADMIN_DIR);

  it("finds the admin pages", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  for (const file of files) {
    const rel = path.relative(ADMIN_DIR, path.dirname(file)).split(path.sep).filter(Boolean);
    const route = ["/admin", ...rel].join("/");
    it(route, () => {
      const src = readFileSync(file, "utf8");
      const call = /await requirePermission\(\s*"[a-z.]+"\s*,\s*(["`])([^"`]+)\1\s*\)/.exec(src);
      expect(call, `${route} must call requirePermission(permission, path)`).not.toBeNull();
      // `[id]` segments are passed as `${id}` in a template literal
      const expected = route.replace(/\[(\w+)\]/g, (_, p: string) => `\${${p}}`);
      expect(call![2]).toBe(expected);
      // the check comes before any data is loaded
      const firstServerCall = src.search(/await (get|list|load|staffTx|systemTx|with(System|User|Anon))\w*\(/);
      if (firstServerCall >= 0) expect(call!.index).toBeLessThan(firstServerCall);
    });
  }
});
