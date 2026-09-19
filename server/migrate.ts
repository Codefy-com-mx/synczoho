import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { getPool } from "./db.js";

export async function runMigrations(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [731_908_221]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const directory = path.resolve(process.cwd(), "server/migrations");
    const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const exists = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (exists.rowCount) continue;
      const sql = await readFile(path.join(directory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`Applied database migration ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [731_908_221]).catch(() => undefined);
    client.release();
  }
}
