import type postgres from "postgres";

/** Additional demo data for the discover slice (runs after the core seed, on a fresh database). */
export async function seedDiscover(sql: postgres.Sql) {
  void sql;
}
