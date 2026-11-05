import type postgres from "postgres";

/** Additional demo data for the hike slice (runs after the core seed, on a fresh database). */
export async function seedHike(sql: postgres.Sql) {
  void sql;
}
