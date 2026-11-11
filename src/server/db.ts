import "server-only";
import postgres from "postgres";
import { assertDatabaseConfigured, env } from "@/config/env";

/**
 * Database access layer.
 *
 * Three ways to run queries — pick the narrowest one that works:
 *
 *  withUser(user, tx => …)  Runs inside a transaction as the `authenticated`
 *                           role with `request.jwt.claims.sub = user.id`, so
 *                           every RLS policy applies. Default for anything a
 *                           signed-in customer or staff member does.
 *  withAnon(tx => …)        Same, as the `anon` role (public catalog reads).
 *  withSystem(tx => …)      Trusted server code only (webhooks, jobs, and
 *                           use-cases that need row locks / lifecycle writes).
 *                           Runs as the table owner and BYPASSES RLS — the
 *                           caller must have already authorized the action.
 *
 * Rows come back with camelCase column keys; JSON column contents are not
 * rewritten (store camelCase keys inside JSON). numeric and bigint columns
 * are parsed to JS numbers. Use timestamptz for instants and cast ambiguous
 * parameters (e.g. `${date}::timestamptz`) — postgres.js v4 lets the server
 * decide parameter types.
 *
 * JSONB PARAMETERS: use the json helper — `${tx.json(obj as JsonValue)}`.
 * Never `${JSON.stringify(obj)}::jsonb`: v4 would store a JSON *string*.
 * Arrays for text[]/uuid[] columns: pass the array with a cast, `${ids}::uuid[]`.
 */
export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;
export type JsonValue = postgres.JSONValue;

export interface DbUser {
  id: string;
  email?: string | null;
}

const globalForDb = globalThis as unknown as { __ggSql?: postgres.Sql };

function createPool(): postgres.Sql {
  assertDatabaseConfigured();
  const e = env();
  return postgres(e.DATABASE_URL, {
    max: e.DATABASE_POOL_MAX,
    idle_timeout: 20,
    connect_timeout: 10,
    // Transaction-mode poolers (Supabase :6543) do not support prepared statements.
    prepare: !e.DATABASE_TRANSACTION_POOLER,
    ssl: e.DATABASE_SSL ? "require" : false,
    onnotice: () => {},
    // Column names only: snake_case <-> camelCase. JSON column CONTENTS are
    // returned exactly as stored (postgres.camel would also rewrite JSON keys).
    transform: { column: { from: postgres.toCamel, to: postgres.fromCamel }, undefined: null },
    types: {
      numeric: {
        to: 1700,
        from: [1700],
        serialize: (x: unknown) => String(x),
        parse: (x: string) => Number(x),
      },
      int8: {
        to: 20,
        from: [20],
        serialize: (x: unknown) => String(x),
        parse: (x: string) => Number(x),
      },
    },
    connection: { application_name: "ghost-guide" },
  });
}

/** The shared owner-role pool. Prefer withUser/withAnon/withSystem. */
export function sql(): postgres.Sql {
  if (!globalForDb.__ggSql) globalForDb.__ggSql = createPool();
  return globalForDb.__ggSql;
}

export async function closeDb() {
  if (globalForDb.__ggSql) {
    await globalForDb.__ggSql.end({ timeout: 5 });
    globalForDb.__ggSql = undefined;
  }
}

async function asRole<T>(
  role: "authenticated" | "anon",
  claims: Record<string, unknown>,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return sql().begin(async (tx) => {
    // set_config(..., true) and SET LOCAL are scoped to this transaction, so
    // pooled connections never leak identity between requests.
    await tx`select set_config('request.jwt.claims', ${JSON.stringify(claims)}, true)`;
    if (role === "authenticated") await tx`set local role authenticated`;
    else await tx`set local role anon`;
    return fn(tx);
  }) as Promise<T>;
}

export function withUser<T>(user: DbUser, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!user?.id) throw new Error("withUser requires an authenticated user");
  return asRole("authenticated", { sub: user.id, role: "authenticated", email: user.email ?? null }, fn);
}

export function withAnon<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return asRole("anon", { role: "anon" }, fn);
}

export function withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return sql().begin((tx) => fn(tx)) as Promise<T>;
}

/** True if the error is a Postgres unique-violation (23505). */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "23505";
}
