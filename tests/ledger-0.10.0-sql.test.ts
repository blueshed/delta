/**
 * A database on 0.10.0's framework SQL, under this listener: undo and redo go on working, signed
 * in or not, until 001g is applied again; only a walk that names a change needs it. Postgres in
 * process (PGlite), its walk functions set back to 0.10.0's (tests/fixtures/delta-walk-0.10.0.sql).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Pool } from "pg";
import { applyFramework, applySql, clearRegistry, createDocListener, docTypeFromDef, generateSql, importTables, registerDocType } from "../src/server/postgres";
import { openPglite } from "../src/server/pglite";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import { pathDocs, pathSchema, pathSeed } from "./helpers/path";
import { auth, ownsByName } from "./helpers/owns";

setLogLevel("silent");

let pool: Pool;

beforeAll(async () => {
  pool = await openPglite();
  await applyFramework(pool);
  await pool.query(`
    DROP FUNCTION delta_walk_as(TEXT, TEXT, TEXT, BOOLEAN, BOOLEAN, BIGINT, BIGINT);
    DROP FUNCTION delta_walk(TEXT, TEXT, BOOLEAN, BOOLEAN, BIGINT, BIGINT);
    DROP FUNCTION _delta_change_tip(TEXT, BIGINT, BOOLEAN);`);
  await pool.query(await Bun.file(new URL("./fixtures/delta-walk-0.10.0.sql", import.meta.url)).text());
  await applySql(pool, generateSql(pathSchema, pathDocs));
  await importTables(pool, pathSchema, pathSeed);
});

afterAll(async () => {
  await pool.end();
});

const name = (res: any) => res.result?.weddings?.name;

describe("a database on 0.10.0's SQL", () => {
  test("undo and redo walk the cursor's next entry, as they did; a walk that names a change is the server's error until 001g is applied again", async () => {
    clearRegistry();
    for (const def of pathDocs) registerDocType(docTypeFromDef(def, pool));
    const local = createLocal();
    const listener = await createDocListener(local.server, pool, { ledger: true });
    try {
      await local.call("open", { doc: "fo-title:1" });
      const made = (await local.call("delta", { doc: "fo-title:1", ops: [{ op: "replace", path: "/weddings/name", value: "later" }], cursor: "s1" })).result;
      expect((await local.call("undo", { cursor: "s1", dry: true })).result).toMatchObject({ entry: made.entry, ops: [{ op: "replace" }] });
      expect((await local.call("undo", { cursor: "s1", entry: made.entry })).error).toBeUndefined();
      expect(name(await local.call("open", { doc: "fo-title:1" }))).toBe("ours");
      expect((await local.call("redo", { cursor: "s1" })).error).toBeUndefined();
      expect(name(await local.call("open", { doc: "fo-title:1" }))).toBe("later");
      expect((await local.call("undo", { cursor: "s1", change: made.entry })).error?.code).toBe(500);
    } finally {
      await listener.destroy();
    }
  });

  test("signed in, undo and redo go through delta_walk_as, as they did", async () => {
    clearRegistry();
    for (const def of pathDocs) registerDocType(docTypeFromDef(def, pool, { auth, owns: ownsByName }));
    const local = createLocal();
    const listener = await createDocListener(local.server, pool, { auth, ledger: true });
    try {
      const ada = local.as({ id: 1 });
      await ada.call("open", { doc: "fo-title:1" });
      expect((await ada.call("delta", { doc: "fo-title:1", ops: [{ op: "replace", path: "/weddings/name", value: "signed" }], cursor: "c1" })).error).toBeUndefined();
      expect((await ada.call("undo", { cursor: "c1" })).error).toBeUndefined();
      expect(name(await ada.call("open", { doc: "fo-title:1" }))).toBe("later");
      expect((await ada.call("redo", { cursor: "c1" })).error).toBeUndefined();
      expect(name(await ada.call("open", { doc: "fo-title:1" }))).toBe("signed");
    } finally {
      await listener.destroy();
    }
  });
});
