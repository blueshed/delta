/**
 * The entry an undo or a redo takes (`nextUndo` / `nextRedo`). It was a
 * recursive walk of every chain the cursor ever began; it is now found newest
 * first among the cursor's own entries, as dzql's `_delta_ledger_tip`
 * (blueshed/dzql#35). The old walk is kept here as the reference: over ledgers
 * made through the real API -- three cursors writing, removing and adding rows
 * they share, writing facts (never undone), undoing, redoing and walking a
 * change by name, conflicts recorded as they come -- both take the same entry
 * for every cursor, both ways, after every step. And on a long history the
 * lookup does a few steps of SQLite's work, where the old walk did thousands.
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocal } from "../src/server/local";
import { createLedger } from "../src/server/ledger";
import { setLogLevel } from "../src/server/logger";
import { createTables, defineDoc, defineSchema, registerDocs } from "../src/server/sqlite";
import { openCounted } from "./helpers/counted-sqlite";

setLogLevel("silent");

const schema = defineSchema({
  rooms: { columns: {}, temporal: false },
  messages: { parent: "rooms", columns: { text: "text", n: "integer" }, temporal: false },
});
const room = defineDoc("room:", { root: "rooms", include: ["messages"], implied: true });

/** The tip as it was found before: every chain of the cursor, walked. */
const tips = `
  WITH RECURSIVE chain(id, depth) AS (
    SELECT id, 0 FROM delta_ledger WHERE cursor = ?1 AND undoes IS NULL AND undoable = 1
    UNION ALL
    SELECT l.id, c.depth + 1 FROM delta_ledger l JOIN chain c ON l.undoes = c.id
  ),
  tips AS (
    SELECT c.id, c.depth FROM chain c WHERE NOT EXISTS (SELECT 1 FROM delta_ledger w WHERE w.undoes = c.id)
  )`;
const REFERENCE = {
  undo: `${tips}
    SELECT l.id FROM tips t CROSS JOIN delta_ledger l ON l.id = t.id
    WHERE t.depth % 2 = 0 ORDER BY l.id DESC LIMIT 1`,
  redo: `${tips}
    SELECT l.id FROM tips t CROSS JOIN delta_ledger l ON l.id = t.id
    WHERE t.depth % 2 = 1 AND l.undoable = 1
      AND l.id > COALESCE((SELECT MAX(id) FROM delta_ledger WHERE cursor = ?1 AND undoes IS NULL AND undoable = 1), 0)
    ORDER BY l.id DESC LIMIT 1`,
};

/** A seeded run of numbers, so a failure comes back the same. */
function random(seed: number) {
  let s = seed;
  return () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
}

function setup() {
  const db = new Database(":memory:");
  createTables(db, schema);
  const local = createLocal();
  registerDocs(local.server, db, schema, [room], [], { ledger: true });
  const doc = "room:1";
  const write = (cursor: string, ops: unknown[], undoable = true) => local.call("delta", { doc, ops, cursor, undoable });
  const ids = async () => Object.keys((await local.call("open", { doc })).result.messages ?? {}).map(Number);
  return { db, local, doc, write, ids };
}

const cursors = ["c1", "c2", "c3"];

describe("the tip taken is the one the old walk took", () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    test(`a run of 300 steps, seed ${seed}`, async () => {
      const { db, local, write, ids } = setup();
      const ledger = createLedger(db);
      const reference = { undo: db.query(REFERENCE.undo), redo: db.query(REFERENCE.redo) };
      const next = random(seed);
      const pick = <T,>(xs: T[]) => xs[Math.floor(next() * xs.length)]!;
      await ids();
      for (let step = 0; step < 300; step++) {
        const cursor = pick(cursors);
        const held = await ids();
        const roll = next();
        // a refusal (a row not there, an entry no change of this cursor's) is a step like any other: its answer is not read
        if (roll < 0.2 || held.length < 3) await write(cursor, [{ op: "add", path: "/messages/-", value: { text: `s${step}`, n: step } }]);
        else if (roll < 0.5) await write(cursor, [{ op: "replace", path: `/messages/${pick(held.slice(0, 2))}/n`, value: step }]);   // the rows first made, most: walks meet others' writes
        else if (roll < 0.54) await write(cursor, [{ op: "replace", path: `/messages/${pick(held)}/text`, value: `fact ${step}` }], false);   // a fact: never undone
        else if (roll < 0.6) await write(cursor, [{ op: "remove", path: `/messages/${pick(held)}` }]);
        else if (roll < 0.8) await local.call("undo", { cursor });
        else if (roll < 0.93) await local.call("redo", { cursor });
        else {
          const mine = (db.query("SELECT id FROM delta_ledger WHERE cursor = ? ORDER BY id").all(cursor) as { id: number }[]).map((r) => r.id);
          if (mine.length) await local.call(next() < 0.5 ? "undo" : "redo", { cursor, change: pick(mine) });
        }
        for (const c of cursors) {
          for (const way of ["undo", "redo"] as const) {
            const now = (way === "undo" ? ledger.nextUndo(c) : ledger.nextRedo(c))?.id ?? null;
            const was = (reference[way].get(c) as { id: number } | null)?.id ?? null;
            expect({ seed, step, tip: `${c} ${way}`, entry: now }).toEqual({ seed, step, tip: `${c} ${way}`, entry: was });
          }
        }
      }
      // the run made chains to walk: walks, and walks recorded as changing nothing
      const made = db.query("SELECT count(*) FILTER (WHERE undoes IS NOT NULL) AS walks, count(*) FILTER (WHERE undoable = 0 AND undoes IS NOT NULL) AS skips, count(*) FILTER (WHERE undoable = 0 AND undoes IS NULL) AS facts FROM delta_ledger").get() as Record<string, number>;
      expect(made.walks).toBeGreaterThan(20);
      expect(made.skips).toBeGreaterThan(0);
      expect(made.facts).toBeGreaterThan(0);
    }, 60_000);
  }
});

describe("a chain is the cursor's whose write began it", () => {
  // Through the API every entry of a chain carries its write's cursor, so the run above never
  // meets this: an entry recorded by hand as one cursor walking another's write.
  test("a walk recorded by another cursor is no tip of that cursor's", async () => {
    const { db, write, ids } = setup();
    await ids();
    await write("c1", [{ op: "add", path: "/messages/-", value: { text: "a", n: 0 } }]);
    await write("c2", [{ op: "add", path: "/messages/-", value: { text: "b", n: 0 } }]);
    const ledger = createLedger(db);
    const walked = db.query("SELECT id FROM delta_ledger WHERE cursor = 'c1'").get() as { id: number };
    ledger.record({ doc: "room:1", ops: [{ op: "remove", path: "/messages/1" }], inverse: [], who: null, cursor: "c2", undoes: walked.id });
    const reference = db.query(REFERENCE.redo);
    expect(ledger.nextRedo("c2")?.id ?? null).toEqual((reference.get("c2") as { id: number } | null)?.id ?? null);
    expect(ledger.nextRedo("c2")).toBeUndefined();
  });
});

describe("an undo costs what was written since, not the cursor's whole history", () => {
  test("finding the tip of a long history takes a few of SQLite's steps, where the old walk took thousands", async () => {
    const { db, local, write, ids } = setup();
    await ids();
    await write("long", [{ op: "add", path: "/messages/-", value: { text: "a", n: 0 } }]);
    const [id] = await ids();
    for (let i = 0; i < 1500; i++) {   // a long history: a write and its undo, 1,500 times
      await write("long", [{ op: "replace", path: `/messages/${id}/n`, value: i }]);
      await local.call("undo", { cursor: "long" });
    }
    await write("long", [{ op: "replace", path: `/messages/${id}/n`, value: -1 }]);
    // the ledger in a file, opened where SQLite counts each statement's steps (bun:sqlite does not say)
    const dir = mkdtempSync(join(tmpdir(), "ledger-tip-"));
    const compare = (when: string, ways: ("undo" | "redo")[]) => {
      const file = join(dir, `${ways.length}.db`);
      writeFileSync(file, db.serialize());
      const counted = openCounted(file);
      try {
        const ledger = createLedger(counted);
        const reference = { undo: counted.query(REFERENCE.undo), redo: counted.query(REFERENCE.redo) };
        const cost = (lookup: () => number | null) => {
          const [steps, scans] = [counted.steps(), counted.fullScans()];
          const found = lookup();
          return { found, steps: counted.steps() - steps, fullScans: counted.fullScans() - scans };
        };
        for (const way of ways) {
          const now = cost(() => (way === "undo" ? ledger.nextUndo("long") : ledger.nextRedo("long"))?.id ?? null);
          const was = cost(() => (reference[way].get("long") as { id: number } | null)?.id ?? null);
          expect({ when, way, id: now.found }).toEqual({ when, way, id: was.found });
          expect({ when, way, few: now.steps < 200, fullScans: now.fullScans }).toEqual({ when, way, few: true, fullScans: 0 });
          expect({ when, way, all: was.steps > 10_000 }).toEqual({ when, way, all: true });   // what it was: every chain of 1,500, walked
        }
      } finally {
        counted.close();
      }
    };
    try {
      compare("after a write", ["undo", "redo"]);
      await local.call("undo", { cursor: "long" });
      compare("after its undo", ["redo"]);   // (its undo now is the first write, 3,000 entries back: what was written since)
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
