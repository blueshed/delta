// Boot-time setup: walk init_db/ in order and apply every .sql file. Everything
// the DB needs — framework, users, tables, policies — is vendored into init_db/,
// so this file never imports SQL from node_modules. Readable in git, editable
// by humans, upgradeable via `bunx @blueshed/delta init --upgrade`.
import { Pool } from "pg";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const INIT_DB_DIR = "./init_db";

export async function setup(adminUrl: string): Promise<void> {
  const pool = new Pool({ connectionString: adminUrl });
  try {
    for (const file of sqlFiles(INIT_DB_DIR)) {
      const sql = readFileSync(join(INIT_DB_DIR, file), "utf8");
      if (!sql.trim()) continue;
      await pool.query(sql);
    }
    await seedUsers(pool);
  } finally {
    await pool.end();
  }
}

function sqlFiles(dir: string): string[] {
  return readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
}

async function seedUsers(pool: Pool): Promise<void> {
  // EXAMPLE seed — remove or adapt for the real app.
  const seed: [string, string][] = [
    ["Alice", "alice@example.com"],
    ["Bob", "bob@example.com"],
  ];
  for (const [name, email] of seed) {
    const { rows } = await pool.query(
      "SELECT id FROM users WHERE email = $1",
      [email],
    );
    if (rows.length === 0) {
      await pool.query("SELECT register($1, $2, $3)", [name, email, "password"]);
    }
  }
}
