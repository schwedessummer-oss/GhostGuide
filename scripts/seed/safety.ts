import type postgres from "postgres";

/** Additional demo data for the safety slice (runs after the core seed, on a fresh database). */
export async function seedSafety(sql: postgres.Sql) {
  void sql;
}
