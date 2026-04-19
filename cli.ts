#!/usr/bin/env bun
/**
 * @blueshed/delta CLI.
 *
 *   delta sql <module> [--out <file>] [--schema-export <name>] [--docs-export <name>]
 *     Regenerate a tables SQL file from a TypeScript schema module.
 *
 *   delta init <dir> [--with-auth] [--upgrade]
 *     Copy the framework SQL files into <dir> (typically your init_db/).
 *     --with-auth also copies the reference auth-jwt.sql (users + register/login).
 *     --upgrade replaces existing files with .bak backups, preserving versioning.
 *
 * The init command stamps each copied file with a version header read from
 * this package's package.json so you can `diff -u` against a future
 * `delta init --upgrade` and see exactly what changed.
 */
import { parseArgs } from "node:util";
import { resolve, basename, join, dirname } from "node:path";
import { mkdirSync, copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { generateSql } from "./src/server/postgres/codegen";
import { frameworkSqlFiles } from "./src/server/postgres/bootstrap";
import { authJwtSqlFile } from "./src/server/auth-jwt-sql";
import type { Schema, DocDef } from "./src/server/postgres";

const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "package.json"), "utf8"),
    );
    return String(pkg.version ?? "0.0.0");
  } catch {
    return "0.0.0";
  }
})();

function usage(code = 0): never {
  const stream = code === 0 ? process.stdout : process.stderr;
  stream.write(
    `Usage:\n` +
    `  delta sql <module> [--out <file>] [--schema-export <name>] [--docs-export <name>]\n` +
    `  delta init <dir> [--with-auth] [--upgrade]\n`,
  );
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Header handling — identifies files written by delta init so upgrades can
// read them back and avoid clobbering user-owned SQL.
// ---------------------------------------------------------------------------

const HEADER_RE = /^-- @blueshed\/delta ([a-z0-9-]+) v(\d+\.\d+\.\d+)/;

function headerFor(kind: "framework" | "auth-jwt"): string {
  return (
    `-- @blueshed/delta ${kind} v${PKG_VERSION}\n` +
    `-- Vendored by 'delta init'. Safe to read; prefer 'delta init --upgrade' over hand edits.\n\n`
  );
}

function readHeader(path: string): { kind: string; version: string } | null {
  if (!existsSync(path)) return null;
  const first = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
  const m = first.match(HEADER_RE);
  return m ? { kind: m[1]!, version: m[2]! } : null;
}

function writeWithHeader(src: string, dest: string, kind: "framework" | "auth-jwt"): void {
  const body = readFileSync(src, "utf8");
  writeFileSync(dest, headerFor(kind) + body);
}

// ---------------------------------------------------------------------------
// delta sql
// ---------------------------------------------------------------------------

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
    if (!existsSync(dirname(resolve(out)))) {
      mkdirSync(dirname(resolve(out)), { recursive: true });
    }
    await Bun.write(out, sql);
    process.stderr.write(`Wrote ${out} (${sql.length} bytes)\n`);
  } else {
    process.stdout.write(sql);
  }
}

// ---------------------------------------------------------------------------
// delta init
// ---------------------------------------------------------------------------

interface CopyPlan {
  src: string;
  dest: string;
  kind: "framework" | "auth-jwt";
}

function buildCopyPlan(absDir: string, withAuth: boolean): CopyPlan[] {
  const plan: CopyPlan[] = [];
  for (const src of frameworkSqlFiles()) {
    plan.push({ src, dest: join(absDir, basename(src)), kind: "framework" });
  }
  if (withAuth) {
    plan.push({ src: authJwtSqlFile(), dest: join(absDir, "002-users.sql"), kind: "auth-jwt" });
  }
  return plan;
}

function cmdInit(dir: string | undefined, values: Record<string, unknown>) {
  if (!dir) usage(1);

  const absDir = resolve(process.cwd(), dir);
  if (!existsSync(absDir)) mkdirSync(absDir, { recursive: true });

  const upgrade = !!values.upgrade;
  const withAuth = !!values["with-auth"];
  const plan = buildCopyPlan(absDir, withAuth);

  // On upgrade we refuse to clobber files that don't have our header or that
  // point to a newer version than we ship. The user either wrote that file
  // themselves or has downgraded the package.
  if (upgrade) {
    const conflicts: string[] = [];
    for (const { dest } of plan) {
      if (!existsSync(dest)) continue;
      const hdr = readHeader(dest);
      if (!hdr) conflicts.push(`${basename(dest)}: not stamped by delta init`);
      else if (compareVersion(hdr.version, PKG_VERSION) > 0) {
        conflicts.push(`${basename(dest)}: has v${hdr.version}, package is v${PKG_VERSION}`);
      }
    }
    if (conflicts.length) {
      process.stderr.write(
        `Refusing to upgrade:\n  ${conflicts.join("\n  ")}\n\n` +
        `Resolve these manually (move or rename the offending files) and rerun.\n`,
      );
      process.exit(3);
    }
  }

  const created: string[] = [];
  const upgraded: string[] = [];
  const unchanged: string[] = [];

  for (const { src, dest, kind } of plan) {
    if (existsSync(dest)) {
      const existing = readHeader(dest);
      if (!upgrade) {
        unchanged.push(basename(dest));
        continue;
      }
      if (existing?.version === PKG_VERSION) {
        unchanged.push(basename(dest));
        continue;
      }
      copyFileSync(dest, dest + ".bak");
      writeWithHeader(src, dest, kind);
      upgraded.push(`${basename(dest)} (backup at ${basename(dest)}.bak)`);
    } else {
      writeWithHeader(src, dest, kind);
      created.push(basename(dest));
    }
  }

  const lines: string[] = [];
  if (created.length) lines.push("Created:\n  " + created.join("\n  "));
  if (upgraded.length) lines.push("Upgraded:\n  " + upgraded.join("\n  "));
  if (unchanged.length) lines.push("Unchanged:\n  " + unchanged.join("\n  "));
  process.stderr.write((lines.join("\n\n") || "Nothing to do.") + "\n");

  if (created.length || upgraded.length) {
    process.stderr.write(
      `\nNext: regenerate your table SQL from types.ts:\n` +
      `  bunx @blueshed/delta sql ./types.ts --out ${dir}/003-tables.sql\n`,
    );
  }
}

function compareVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      out: { type: "string", short: "o" },
      "schema-export": { type: "string", default: "schema" },
      "docs-export": { type: "string", default: "docs" },
      "with-auth": { type: "boolean", default: false },
      upgrade: { type: "boolean", default: false },
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
