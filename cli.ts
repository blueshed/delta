#!/usr/bin/env bun
/**
 * @blueshed/delta CLI.
 *
 *   delta sql <module> [--out <file>] [--schema-export <name>] [--docs-export <name>]
 *     Regenerate a 002-tables.sql file from a TypeScript schema module.
 *
 *   delta init <dir> [--with-auth]
 *     Copy the framework SQL files into <dir> (typically your init_db/).
 *     --with-auth also copies the reference auth-jwt.sql.
 *
 * Run via bunx without installing globally:
 *   bunx @blueshed/delta sql ./types.ts --out init_db/002-tables.sql
 *   bunx @blueshed/delta init init_db --with-auth
 */
import { parseArgs } from "node:util";
import { resolve, basename, join } from "node:path";
import { mkdirSync, copyFileSync, readdirSync, existsSync } from "node:fs";
import { generateSql } from "./postgres/codegen";
import { frameworkSqlFiles } from "./postgres/bootstrap";
import { authJwtSqlFile } from "./auth-jwt";
import type { Schema, DocDef } from "./postgres";

function usage(code = 0): never {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(
    `Usage:\n` +
    `  delta sql <module> [--out <file>] [--schema-export <name>] [--docs-export <name>]\n` +
    `  delta init <dir> [--with-auth]\n`,
  );
  process.exit(code);
}

async function cmdSql(modulePath: string | undefined, values: Record<string, unknown>) {
  if (!modulePath) usage(1);

  const abs = resolve(process.cwd(), modulePath);
  const mod = await import(abs);

  const schemaExport = (values["schema-export"] as string | undefined) ?? "schema";
  const docsExport = (values["docs-export"] as string | undefined) ?? "docs";
  const schema = mod[schemaExport] as Schema | undefined;
  const docs = mod[docsExport] as DocDef[] | undefined;

  if (!schema || typeof schema !== "object" || !("tables" in schema)) {
    process.stderr.write(
      `Module at ${modulePath} does not export a Schema as \`${schemaExport}\`.\n` +
      `Export one with: export const ${schemaExport} = defineSchema({ ... });\n`,
    );
    process.exit(2);
  }
  if (!Array.isArray(docs)) {
    process.stderr.write(
      `Module at ${modulePath} does not export a DocDef[] as \`${docsExport}\`.\n` +
      `Export one with: export const ${docsExport} = [defineDoc(...), ...];\n`,
    );
    process.exit(2);
  }

  const sql = generateSql(schema, docs);
  const out = values.out as string | undefined;

  if (out) {
    await Bun.write(out, sql);
    process.stderr.write(`Wrote ${out} (${sql.length} bytes)\n`);
  } else {
    process.stdout.write(sql);
  }
}

function cmdInit(dir: string | undefined, values: Record<string, unknown>) {
  if (!dir) usage(1);

  const absDir = resolve(process.cwd(), dir);
  if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true });

  const copies: string[] = [];
  for (const src of frameworkSqlFiles()) {
    const dest = join(absDir, basename(src));
    copyFileSync(src, dest);
    copies.push(basename(src));
  }

  if (values["with-auth"]) {
    const src = authJwtSqlFile();
    const dest = join(absDir, "002-users.sql");  // sit just after the 001* framework files
    copyFileSync(src, dest);
    copies.push("002-users.sql (from auth-jwt.sql)");
  }

  process.stderr.write(
    `Copied ${copies.length} file(s) into ${dir}/:\n  ` + copies.join("\n  ") + "\n",
  );
  process.stderr.write(
    `\nNext: generate your table SQL:\n` +
    `  bunx @blueshed/delta sql ./types.ts --out ${dir}/003-tables.sql\n`,
  );
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: "string", short: "o" },
      "schema-export": { type: "string", default: "schema" },
      "docs-export": { type: "string", default: "docs" },
      "with-auth": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) usage(0);

  const cmd = positionals[0];
  const arg = positionals[1];

  switch (cmd) {
    case "sql":  return cmdSql(arg, values);
    case "init": return cmdInit(arg, values);
    default:     usage(1);
  }
}

main().catch((err) => {
  process.stderr.write(`delta: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
