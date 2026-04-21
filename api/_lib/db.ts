import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }
  return pool;
}

export function isAdmin(req: { headers: Record<string, any>; query: Record<string, any> }): boolean {
  const key = process.env.ADMIN_KEY;
  if (!key) return false;
  const provided =
    (req.headers["x-admin-key"] as string) ||
    (req.query?.key as string) ||
    "";
  return provided === key;
}
