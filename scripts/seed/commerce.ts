import type postgres from "postgres";

/** Additional demo data for the commerce slice (runs after the core seed, on a fresh database). */
export async function seedCommerce(sql: postgres.Sql) {
  void sql;
}
