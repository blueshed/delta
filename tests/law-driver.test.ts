/**
 * The law over generated writes (todo #27). The shared cases
 * (tests/helpers/path.ts) ask the law after writes someone thought of; this
 * asks it after writes nobody chose. A seeded driver opens a mix of the path's
 * documents -- single, list, implied, a time in the name, custom, a scope by
 * a condition, and one through a second registration -- and takes random steps
 * through them as three people: adds (an id named, or /-), a field or a row
 * replaced, removes and the cascades they make, moves to another parent,
 * batches of several ops, and undo and redo on each person's cursor. The same
 * steps go to every backend at once. After each:
 *
 * - on each backend, the law: every open copy, with what it was told applied,
 *   equals a fresh open (closed first, so nothing answers from a copy of its own);
 * - across backends, the same answers (an error's code; a write's ops; a walk's
 *   ops and conflict) and the same documents.
 *
 * A failure names its seed and step; `DELTA_LAW_SEED=<seed>` runs that seed
 * alone. In the normal suite a few seeds of a few hundred steps on SQLite, the
 * JSON file and PGlite; for a longer run:
 *
 *   DELTA_LAW_SEEDS=20 DELTA_LAW_STEPS=1000 bun test tests/law-driver.test.ts
 */
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool } from "pg";
import { applyOps, type DeltaOp } from "../src/core";
import * as sqlite from "../src/server/sqlite";
import * as json from "../src/server/json";
import { applyFramework, applySql, createDocListener, docTypeFromDef, generateSql, importTables } from "../src/server/postgres";
import { openPglite } from "../src/server/pglite";
import { createLocal } from "../src/server/local";
import { setLogLevel } from "../src/server/logger";
import {
  pathDocs, pathPublicDocs, pathSchema, pathSeed, postgresInbox, postgresMenuCard, sqliteInbox, sqliteMenuCard, type PathProcess,
} from "./helpers/path";

setLogLevel("silent");

const STEPS = Number(process.env.DELTA_LAW_STEPS ?? 200);
const SEEDS = process.env.DELTA_LAW_SEED
  ? [Number(process.env.DELTA_LAW_SEED)]
  : Array.from({ length: Number(process.env.DELTA_LAW_SEEDS ?? 3) }, (_, i) => i + 1);

// ---------------------------------------------------------------------------
// The places the same steps go
// ---------------------------------------------------------------------------

type Heard = { channel: string; data: any }[];
type Place = { name: string; process: PathProcess; quiet(): Promise<void>; end(): Promise<void> };

function local(): { local: ReturnType<typeof createLocal>; process: PathProcess } {
  const l = createLocal();
  const heard: Heard = [];
  l.onPublish((channel, data) => heard.push({ channel, data }));
  return { local: l, process: { call: (action, msg) => l.call(action, msg), heard } };
}

function onSqlite(): Place {
  const db = new Database(":memory:");
  sqlite.createTables(db, pathSchema);
  sqlite.importTables(db, pathSchema, pathSeed);
  const { local: l, process } = local();
  sqlite.registerDocs(l.server, db, pathSchema, pathDocs, [sqliteInbox, sqliteMenuCard], { ledger: true });
  sqlite.registerDocs(l.server, db, pathSchema, pathPublicDocs, [], { ledger: true });   // undone as on Postgres, where every write is kept
  return { name: "sqlite", process, quiet: async () => {}, end: async () => db.close() };
}

function onJson(): Place {
  const dir = mkdtempSync(join(tmpdir(), "delta-law-"));
  const file = join(dir, "data.json");
  json.importTables(file, pathSchema, pathSeed);
  const { local: l, process } = local();
  const store = json.registerDocs(l.server, file, pathSchema, pathDocs, [sqliteInbox, sqliteMenuCard], { ledger: true });
  json.registerDocs(l.server, file, pathSchema, pathPublicDocs, [], { ledger: true });
  return { name: "json", process, quiet: async () => {}, end: async () => { await store.persisted(); rmSync(dir, { recursive: true, force: true }); } };
}

/** A PGlite of its own for each seed: a long run on one wears it out ("regular expression is too complex", a WASM heap's limit). */
async function onPglite(): Promise<Place> {
  const pool: Pool = await openPglite();
  await applyFramework(pool);
  await applySql(pool, generateSql(pathSchema, [...pathDocs, ...pathPublicDocs]));
  await importTables(pool, pathSchema, pathSeed);
  const { local: l, process } = local();
  const listener = await createDocListener(l.server, pool, { types: [...pathDocs, ...pathPublicDocs].map((def) => docTypeFromDef(def, pool)), ledger: true, custom: [postgresInbox, postgresMenuCard] });
  // NOTIFY is heard after the commit, and fetched then, by queries queued behind it on the one
  // PGlite: quiet once a round trip through it, and a turn after, brings nothing more
  const quiet = async () => {
    let seen = -1;
    while (seen !== process.heard.length) {
      seen = process.heard.length;
      for (let i = 0; i < 3; i++) {
        await pool.query("SELECT 1");
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  };
  return { name: "pglite", process, quiet, end: async () => { await listener.destroy(); await pool.end(); } };
}

// ---------------------------------------------------------------------------
// The documents, and the steps through them
// ---------------------------------------------------------------------------

/** What is open: written through (the first set) and only read (the second). */
const written = [
  "fo-board:1", "fo-board:2", "fo-menu:1", "fo-household:1", "fo-course:1", "fo-title:1", "fo-notes:1", "fo-party:1",
  "fo-all-courses:", "fo-catalog:", "fo-all-households:", "fo-plan:7", "fo-pub-courses:",
];
const read = [
  "fo-courses-like:S", "fo-weddings:", "fo-drinks:1", "fo-courses-noted-on:", "fo-board-on:1:2021-01-01", "fo-notes-on:2021-01-01",
  "fo-inbox:a@x", "fo-inbox:b@x", "fo-menu-card:1", "fo-menu-card:2",
];
const people = ["ada", "bob", "cy"];
const names = ["Soup", "Salad", "Stew", "Fish", "Cake"];
const emails = ["a@x", "b@x", "c@x", "d@x"];

/** Mulberry32: a small seeded generator, so a seed is the same steps on every run. */
function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(xs: readonly T[]): T => xs[int(xs.length)]!;
  return { next, int, pick };
}

type Step =
  | { kind: "delta"; doc: string; ops: DeltaOp[]; cursor: string }
  | { kind: "undo" | "redo"; cursor: string };

/** The ids each collection holds now, as the first place's documents read them. */
type Known = Record<"weddings" | "courses" | "drinks" | "households" | "favours" | "notes", number[]>;

function know(fresh: Record<string, any>): Known {
  const ids = (doc: string, coll: string) => Object.keys(fresh[doc]?.[coll] ?? {}).map(Number);
  const notes = [...ids("fo-board:1", "notes"), ...ids("fo-board:2", "notes")];
  return {
    weddings: ids("fo-weddings:", "weddings"),
    courses: ids("fo-catalog:", "courses"),
    drinks: ids("fo-catalog:", "drinks"),
    households: ids("fo-all-households:", "households"),
    favours: ids("fo-party:1", "favours"),
    notes,
  };
}

/** One op through `doc`, of the kinds it takes, over the rows there are -- and now and then rows there are not. */
function opFor(doc: string, r: ReturnType<typeof random>, k: Known): DeltaOp {
  const some = (xs: number[]) => (xs.length && r.next() < 0.9 ? r.pick(xs) : 1 + r.int(12));
  const id = () => (r.next() < 0.7 ? "-" : String(1 + r.int(14)));
  const course = () => ({ name: r.pick(names) });
  const wedding = () => r.pick([1, 2, 2, 7]);
  const choices: (() => DeltaOp)[] = [];
  const on = (...fs: (() => DeltaOp)[]) => choices.push(...fs);
  const board = (w: number) => {
    on(
      () => ({ op: "add", path: `/courses/${id()}`, value: course() }),
      () => ({ op: "add", path: `/drinks/${id()}`, value: { courses_id: some(k.courses), name: r.pick(names) } }),
      () => ({ op: "add", path: `/households/${id()}`, value: { email: r.pick(emails) } }),
      () => ({ op: "replace", path: `/courses/${some(k.courses)}/name`, value: r.pick(names) }),
      () => ({ op: "replace", path: `/courses/${some(k.courses)}`, value: course() }),
      () => ({ op: "replace", path: `/households/${some(k.households)}/email`, value: r.pick(emails) }),
      () => ({ op: "replace", path: "/weddings/name", value: r.pick(["ours", "theirs", "our day"]) }),
      () => ({ op: "remove", path: `/courses/${some(k.courses)}` }),
      () => ({ op: "remove", path: `/drinks/${some(k.drinks)}` }),
      () => ({ op: "remove", path: `/households/${some(k.households)}` }),
    );
    if (r.next() < 0.1) on(() => ({ op: "remove", path: `/weddings/${w}` }));
  };
  switch (doc) {
    case "fo-board:1":
      board(1);
      on(
        () => ({ op: "add", path: "/notes/-", value: { text: r.pick(["chairs", "tables"]) } }),
        () => ({ op: "replace", path: `/notes/${some(k.notes)}/text`, value: r.pick(["chairs", "lights"]) }),
        () => ({ op: "remove", path: `/notes/${some(k.notes)}` }),
      );
      break;
    case "fo-board:2": board(2); break;
    case "fo-menu:1":
      on(
        () => ({ op: "add", path: `/courses/${id()}`, value: course() }),
        () => ({ op: "replace", path: `/courses/${some(k.courses)}/name`, value: r.pick(names) }),
        () => ({ op: "add", path: "/drinks/-", value: { courses_id: some(k.courses), name: r.pick(names) } }),
        () => ({ op: "remove", path: `/drinks/${some(k.drinks)}` }),
      );
      break;
    case "fo-household:1":
      on(
        () => ({ op: "replace", path: "/households/email", value: r.pick(emails) }),
        () => ({ op: "replace", path: "/households", value: { email: r.pick(emails) } }),
      );
      if (r.next() < 0.1) on(() => ({ op: "remove", path: "/households/1" }));
      break;
    case "fo-course:1":
      on(
        () => ({ op: "replace", path: "/courses/name", value: r.pick(names) }),
        () => ({ op: "add", path: "/drinks/-", value: { courses_id: 1, name: r.pick(names) } }),
        () => ({ op: "remove", path: `/drinks/${some(k.drinks)}` }),
      );
      break;
    case "fo-title:1": on(() => ({ op: "replace", path: "/weddings/name", value: r.pick(["ours", "the day"]) })); break;
    case "fo-notes:1":
      on(
        () => ({ op: "add", path: "/notes/-", value: { text: r.pick(["chairs", "flowers"]) } }),
        () => ({ op: "replace", path: `/notes/${some(k.notes)}/text`, value: r.pick(["chairs", "lights"]) }),
        () => ({ op: "remove", path: `/notes/${some(k.notes)}` }),
      );
      break;
    case "fo-party:1":
      on(
        () => ({ op: "add", path: "/favours/-", value: { households_id: some(k.households), gift: r.pick(["jam", "soap"]) } }),
        () => ({ op: "replace", path: `/favours/${some(k.favours)}/gift`, value: r.pick(["jam", "tea"]) }),
        () => ({ op: "remove", path: `/favours/${some(k.favours)}` }),
        () => ({ op: "add", path: "/households/-", value: { email: r.pick(emails) } }),
      );
      break;
    case "fo-all-courses:":
    case "fo-pub-courses:":
      on(
        () => ({ op: "add", path: `/courses/${id()}`, value: { ...course(), weddings_id: wedding() } }),
        () => ({ op: "replace", path: `/courses/${some(k.courses)}/weddings_id`, value: wedding() }),
        () => ({ op: "replace", path: `/courses/${some(k.courses)}/name`, value: r.pick(names) }),
        () => ({ op: "remove", path: `/courses/${some(k.courses)}` }),
      );
      break;
    case "fo-catalog:":
      on(
        () => ({ op: "add", path: `/drinks/${id()}`, value: { courses_id: some(k.courses), name: r.pick(names) } }),
        () => ({ op: "replace", path: `/drinks/${some(k.drinks)}/courses_id`, value: some(k.courses) }),
        () => ({ op: "replace", path: `/drinks/${some(k.drinks)}/name`, value: r.pick(names) }),
        () => ({ op: "remove", path: `/courses/${some(k.courses)}` }),
      );
      break;
    case "fo-all-households:":
      on(
        () => ({ op: "replace", path: `/households/${some(k.households)}/weddings_id`, value: wedding() }),
        () => ({ op: "replace", path: `/households/${some(k.households)}`, value: { email: r.pick(emails) } }),
        () => ({ op: "add", path: "/households/-", value: { weddings_id: wedding(), email: r.pick(emails) } }),
      );
      break;
    case "fo-plan:7":
      on(
        () => ({ op: "add", path: "/courses/-", value: course() }),
        () => ({ op: "add", path: "/drinks/-", value: { courses_id: some(k.courses), name: r.pick(names) } }),
        () => ({ op: "replace", path: "/weddings/name", value: r.pick(["planned", "the plan"]) }),
        () => ({ op: "replace", path: `/courses/${some(k.courses)}/name`, value: r.pick(names) }),
      );
      if (r.next() < 0.1) on(() => ({ op: "remove", path: "/weddings/7" }));
      break;
  }
  return r.pick(choices)();
}

function stepOf(r: ReturnType<typeof random>, k: Known): Step {
  const cursor = r.pick(people);
  const roll = r.next();
  if (roll < 0.15) return { kind: "undo", cursor };
  if (roll < 0.22) return { kind: "redo", cursor };
  const doc = r.pick(written);
  const n = r.next() < 0.75 ? 1 : 2 + r.int(2);   // now and then a batch of several ops
  return { kind: "delta", doc, ops: Array.from({ length: n }, () => opFor(doc, r, k)), cursor };
}

// ---------------------------------------------------------------------------
// Taking a step, and the law after it
// ---------------------------------------------------------------------------

/** What a step answers, as every backend must answer it alike: a code, or the ops a write applied or a walk took and its conflict. */
async function take(p: Place, step: Step): Promise<unknown> {
  const res = step.kind === "delta"
    ? await p.process.call("delta", { doc: step.doc, ops: step.ops, cursor: step.cursor, inverse: true })
    : await p.process.call(step.kind, { cursor: step.cursor });
  if (res.error) return res.error.code >= 500 ? res.error : { code: res.error.code };   // the server's own: its message says why
  if (res.result === null) return null;
  return { ops: res.result.ops, conflict: res.result.conflict };
}

/** A copy as it is compared: its version is not its content. */
const content = (doc: any) => {
  if (doc === null || typeof doc !== "object") return doc;
  const { _v, ...rest } = doc;
  return rest;
};

/** An open document's copy: what it opened, and where in what was heard its telling starts. */
type Copy = { opened: any; from: number };

/** Open `doc` on `p` and keep its copy; undefined while it is not there (404). */
async function keep(p: Place, doc: string): Promise<Copy | undefined> {
  const res = await p.process.call("open", { doc });
  if (res.error?.code === 404) return undefined;
  if (res.error) throw new Error(`${p.name}: open ${doc}: ${JSON.stringify(res.error)}`);
  return { opened: structuredClone(res.result), from: p.process.heard.length };
}

/**
 * The law on `p`: each copy, with what it was told applied, equals a fresh
 * open; a copy whose document is no longer there was told its root is null,
 * and is opened again once it is. Answers every document as freshly read
 * (null: not there), to hold against the other backends.
 */
async function law(p: Place, copies: Map<string, Copy | undefined>): Promise<Record<string, unknown>> {
  await p.quiet();
  const fresh: Record<string, unknown> = {};
  for (const [doc, kept] of copies) {
    if (!kept) {
      const again = await keep(p, doc);
      copies.set(doc, again);
      fresh[doc] = again ? content(again.opened) : null;
      continue;
    }
    const copy = structuredClone(kept.opened);
    let letGo = false;   // a custom document whose read is gone is let go (404): it is open no more
    for (const h of p.process.heard.slice(kept.from)) {
      if (h.channel !== doc) continue;
      expect({ place: p.name, doc, after: letGo ? h.data : undefined }).toEqual({ place: p.name, doc, after: undefined });
      if (h.data.error) letGo = true;
      else applyOps(copy, h.data.ops);
    }
    if (letGo) {
      expect({ place: p.name, doc, open: (await p.process.call("open", { doc })).error?.code }).toEqual({ place: p.name, doc, open: 404 });
      copies.set(doc, undefined);
      fresh[doc] = null;
      continue;
    }
    await p.process.call("close", { doc });
    const again = await keep(p, doc);
    if (!again) {
      const root = Object.keys(kept.opened).find((k) => kept.opened[k] && typeof kept.opened[k] === "object" && "id" in kept.opened[k]);
      expect({ place: p.name, doc, gone: root ? copy[root] : copy }).toEqual({ place: p.name, doc, gone: null });
      copies.set(doc, undefined);
      fresh[doc] = null;
      continue;
    }
    expect({ place: p.name, doc, copy: content(copy) }).toEqual({ place: p.name, doc, copy: content(again.opened) });
    copies.set(doc, again);
    fresh[doc] = content(again.opened);
  }
  return fresh;
}

/** What every place answers when each answers as the first does. */
const alike = (places: Place[], first: unknown) => Object.fromEntries(places.map((p) => [p.name, first]));

/** Run `seed` on the places: the same steps to each, the law and the answers asked after every one. */
async function drive(seed: number, places: Place[]): Promise<void> {
  const r = random(seed);
  const copies = new Map<Place, Map<string, Copy | undefined>>();
  for (const p of places) {
    const mine = new Map<string, Copy | undefined>();
    for (const doc of [...written, ...read]) mine.set(doc, await keep(p, doc));
    copies.set(p, mine);
  }
  let fresh = await law(places[0]!, copies.get(places[0]!)!);
  const steps: Step[] = [];
  for (let i = 0; i < STEPS; i++) {
    const step = stepOf(r, know(fresh as Record<string, any>));
    steps.push(step);
    try {
      const answers: Record<string, unknown> = {};
      for (const p of places) answers[p.name] = await take(p, step);
      expect(answers).toEqual(alike(places, answers[places[0]!.name]));
      const reads: Record<string, Record<string, unknown>> = {};
      for (const p of places) reads[p.name] = await law(p, copies.get(p)!);
      fresh = reads[places[0]!.name]!;
      for (const doc of Object.keys(fresh)) {
        const each = Object.fromEntries(places.map((p) => [p.name, reads[p.name]![doc]]));
        expect({ doc, each }).toEqual({ doc, each: alike(places, fresh[doc]) });
      }
    } catch (err: any) {
      const recent = steps.map((s, j) => `  ${j}: ${JSON.stringify(s)}`).slice(-10).join("\n");
      err.message = `seed ${seed}, step ${i} (rerun: DELTA_LAW_SEED=${seed} DELTA_LAW_STEPS=${i + 1})\n${recent}\n${err.message}`;
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------

describe("the law over generated writes (todo #27)", () => {
  for (const seed of SEEDS) {
    test(`seed ${seed}: ${STEPS} steps, the same on SQLite, the JSON file and PGlite`, async () => {
      const places = [onSqlite(), onJson(), await onPglite()];
      try { await drive(seed, places); }
      finally { for (const p of places) await p.end(); }
    }, 600_000);
  }
});
