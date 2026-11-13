import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/*
 * Finding #3: with cacheComponents off, ONE request-time read (cookies(),
 * headers(), the session) anywhere in the root layout makes every route
 * dynamic, and the trail pages' `revalidate = 3600` (ISR/CDN caching) is
 * silently ignored. This walks the server-side import graph of the root
 * layout and of the pages meant to be cached, stopping at client components
 * ("use client": they cannot read request data on the server), and fails on
 * any module that reads request data.
 */
const SRC = path.resolve(import.meta.dirname, "../../../src");

/** Server modules that read request data (cookies/headers/session). */
const REQUEST_MODULES = ["next/headers", "@/server/auth", "@/components/site/units-server", "@/lib/supabase/server"];
const REQUEST_CALLS = /\b(cookies|headers|draftMode|connection|getCurrentUser|getApiUser|requireUser|requirePermission|getUnitsPreference)\s*\(/;

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.tsx`, `${base}.ts`, path.join(base, "index.tsx"), path.join(base, "index.ts")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Runtime (non type-only) import specifiers of a module. */
function importsOf(code: string): string[] {
  const specs: string[] = [];
  const re = /^\s*(import|export)\s+(type\s+)?(?:[^'";]*?\s+from\s+)?["']([^"']+)["']/gm;
  for (const m of code.matchAll(re)) {
    if (m[2]) continue; // `import type` / `export type`
    specs.push(m[3]);
  }
  return specs;
}

const isClientModule = (code: string) => /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*["']use client["']/.test(code);

/** Server modules reachable from `entry` (client components end the walk), with any request-data reads. */
function walk(entry: string): { visited: string[]; offenders: string[] } {
  const visited: string[] = [];
  const offenders: string[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const code = readFileSync(file, "utf8");
    if (file !== entry && isClientModule(code)) continue;
    visited.push(path.relative(SRC, file));
    const specs = importsOf(code);
    const bad = specs.filter((s) => REQUEST_MODULES.includes(s));
    const body = code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (bad.length || REQUEST_CALLS.test(body)) offenders.push(`${path.relative(SRC, file)} (${bad.join(", ") || body.match(REQUEST_CALLS)?.[0]})`);
    for (const spec of specs) {
      const resolved = resolveImport(file, spec);
      if (resolved) queue.push(resolved);
    }
  }
  return { visited, offenders };
}

describe("the root layout renders without request data (pages can be static / ISR)", () => {
  it("walks the header, footer and tab bar", () => {
    const { visited } = walk(path.join(SRC, "app/layout.tsx"));
    expect(visited).toEqual(expect.arrayContaining(["app/layout.tsx", "components/site/site-header.tsx", "components/site/site-footer.tsx"]));
  });

  it("no server module under the root layout reads cookies, headers or the session", () => {
    expect(walk(path.join(SRC, "app/layout.tsx")).offenders).toEqual([]);
  });

  it("the import walker does catch a request read (self-check)", () => {
    expect(REQUEST_CALLS.test("const user = await getCurrentUser();")).toBe(true);
    expect(REQUEST_CALLS.test("const c = (await cookies()).get('x');")).toBe(true);
    expect(importsOf('import { cookies } from "next/headers";\nimport type { X } from "@/server/auth";')).toEqual(["next/headers"]);
    expect(isClientModule('"use client";\nimport x from "y";')).toBe(true);
    expect(isClientModule('/** doc */\n"use client";')).toBe(true);
    expect(isClientModule('import x from "y";\n"use client";')).toBe(false);
  });
});

describe("pages meant to be cached read no request data either", () => {
  it("the walk reaches the trail page's data layer", () => {
    expect(walk(path.join(SRC, "app/trail/[country]/[region]/[slug]/page.tsx")).visited).toContain("server/trails/read.ts");
  });

  for (const page of ["app/trail/[country]/[region]/[slug]/page.tsx", "app/how-it-works/page.tsx"]) {
    it(page, () => {
      expect(walk(path.join(SRC, page)).offenders).toEqual([]);
    });
  }
});
