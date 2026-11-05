import type postgres from "postgres";

/** Additional demo data for the admin slice (runs after the core seed, on a fresh database). */
export async function seedAdmin(sql: postgres.Sql) {
  void sql;
}
