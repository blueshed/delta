/**
 * The law over generated writes (todo #27). The shared cases
 * (tests/helpers/path.ts) ask the law after writes someone thought of; this
 * asks it after writes nobody chose. A seeded driver opens a mix of the path's
 * documents -- single, list, implied, a time in the name, custom, a scope by
 * a condition, the parentless tags, seats and slots (every column type), and
 * one through a second registration, which has auth and an `owns` -- as two
 * people at once (two subscribers to each), and takes random steps through
 * them as three: adds (an id named, or /-), a field or a row replaced, removes
 * and the cascades they make, moves to another parent, batches of several
 * ops, now and then an op made a mistake of (a bad path, an unknown field, a
 * value not of its type), and undo and redo on each person's cursor (a redo,
 * often, straight after an undo). The same steps go to every backend at once.
 * After each:
 *
 * - on each backend, the law: every watcher's copy, kept open across steps,
 *   with what it was told applied -- each change at its document's next
 *   version -- equals what a reader of its own (registrations of their own on
 *   the same store, holding nothing open) reads from the tables, at the same
 *   version; and a few copies opened again from the writing server, while the
 *   other watcher holds them, read the same: a copy the server keeps that has
 *   gone stale is found (todo #64's class);
 * - across backends, the same answers (an error's code; a write's ops; a walk's
 *   ops and conflict), the same told to each watcher, and the same documents.
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
  pathDocs, pathPublicDocs, pathSchema, pathSeed, postgresInbox, postgresMenuCard, sqliteInbox, sqliteMenuCard,
} from "./helpers/path";
import { auth, type Me } from "./helpers/owns";

setLogLevel("silent");

const STEPS = Number(process.env.DELTA_LAW_STEPS ?? 200);
const SEEDS = process.env.DELTA_LAW_SEED
  ? [Number(process.env.DELTA_LAW_SEED)]
  : Array.from({ length: Number(process.env.DELTA_LAW_SEEDS ?? 3) }, (_, i) => i + 1);

// ---------------------------------------------------------------------------
// The places the same steps go
// ---------------------------------------------------------------------------

/** Three people: ada and bob each open every document (two subscribers to each); cy only writes. */
const people = [{ name: "ada", me: { id: 1 } }, { name: "bob", me: { id: 2 } }, { name: "cy", me: { id: 3 } }];
const watchers = people.slice(0, 2);

/** The public registration is the one with auth: everyone but cy may have its documents. */
const pubOwns = (me: Me) => me.id !== 3;

type Caller = { call(action: string, msg: Record<string, unknown>): Promise<any> };
type Told = { channel: string; data: any; to?: number };
type Place = {
  name: string;
  /** A person's client, writing and opening as them. */
  as(me: Me): Caller;
  heard: Told[];
  /**
   * A reader on the same store through registrations of its own, which hold
   * no document open: what it opens is read from the tables, never a copy
   * the writing server keeps.
   */
  reader(): Promise<Caller & { done(): Promise<void> }>;
  quiet(): Promise<void>;
  end(): Promise<void>;
};

function hearing(): { local: ReturnType<typeof createLocal>; heard: Told[] } {
  const local = createLocal();
  const heard: Told[] = [];
  local.onPublish((channel, data, to) => heard.push({ channel, data, to: (to?.identity as Me | undefined)?.id }));
  return { local, heard };
}

/** SQLite's registrations, on a database or a JSON file: the private set, and the public one with auth. The first's handle. */
function registerOn<H>(register: (ws: any, docs: any[], custom: any[], opts: any) => H, ws: any): H {
  const first = register(ws, pathDocs, [sqliteInbox, sqliteMenuCard], { ledger: true });
  register(ws, pathPublicDocs, [], { ledger: true, auth, owns: pubOwns });   // undone as on Postgres, where every write is kept
  return first;
}

function onSqlite(): Place {
  const db = new Database(":memory:");
  sqlite.createTables(db, pathSchema);
  sqlite.importTables(db, pathSchema, pathSeed);
  const register = (ws: any, docs: any[], custom: any[], opts: any) => sqlite.registerDocs(ws, db, pathSchema, docs, custom, opts);
  const { local: l, heard } = hearing();
  registerOn(register, l.server);
  const reading = createLocal();
  registerOn(register, reading.server);
  const reader = { call: (a: string, m: Record<string, unknown>) => reading.as(people[0]!.me).call(a, m), done: async () => {} };
  return { name: "sqlite", as: (me) => l.as(me), heard, reader: async () => reader, quiet: async () => {}, end: async () => db.close() };
}

function onJson(): Place {
  const dir = mkdtempSync(join(tmpdir(), "delta-law-"));
  const file = join(dir, "data.json");
  json.importTables(file, pathSchema, pathSeed);
  const register = (ws: any, docs: any[], custom: any[], opts: any) => json.registerDocs(ws, file, pathSchema, docs, custom, opts);
  const { local: l, heard } = hearing();
  const store = registerOn(register, l.server);
  return {
    name: "json", as: (me) => l.as(me), heard, quiet: async () => {},
    // the file as the last change left it, read by a process of its own
    reader: async () => {
      await store.persisted();
      const reading = createLocal();
      registerOn(register, reading.server);
      return { call: (a, m) => reading.as(people[0]!.me).call(a, m), done: async () => {} };
    },
    end: async () => { await store.persisted(); rmSync(dir, { recursive: true, force: true }); },
  };
}

/** A PGlite of its own for each seed: a long run on one wears it out ("regular expression is too complex", a WASM heap's limit). */
async function onPglite(): Promise<Place> {
  const pool: Pool = await openPglite();
  await applyFramework(pool);
  await applySql(pool, generateSql(pathSchema, [...pathDocs, ...pathPublicDocs]));
  await importTables(pool, pathSchema, pathSeed);
  const types = () => [
    ...pathDocs.map((def) => docTypeFromDef<Me>(def, pool, { auth, shared: true })),
    ...pathPublicDocs.map((def) => docTypeFromDef<Me>(def, pool, { auth, owns: pubOwns })),
  ];
  const custom = [{ ...postgresInbox, shared: true }, { ...postgresMenuCard, shared: true }];
  const { local: l, heard } = hearing();
  const listener = await createDocListener(l.server, pool, { types: types(), ledger: true, auth, custom });
  const reading = createLocal();
  const readerListener = await createDocListener(reading.server, pool, { types: types(), ledger: true, auth, custom });
  // NOTIFY is heard after the commit, and fetched then, by queries queued behind it on the one
  // PGlite: quiet once a round trip through it, and a turn after, brings nothing more
  const quiet = async () => {
    let seen = -1;
    while (seen !== heard.length) {
      seen = heard.length;
      for (let i = 0; i < 3; i++) {
        await pool.query("SELECT 1");
        await new Promise((r) => setTimeout(r, 0));
      }
    }
  };
  const reader = { call: (a: string, m: Record<string, unknown>) => reading.as(people[0]!.me).call(a, m), done: async () => {} };
  return {
    name: "pglite", as: (me) => l.as(me), heard, reader: async () => reader, quiet,
    end: async () => { await listener.destroy(); await readerListener.destroy(); await pool.end(); },
  };
}

// ---------------------------------------------------------------------------
// The documents, and the steps through them
// ---------------------------------------------------------------------------

/** What is open: written through (the first set) and only read (the second). */
const written = [
  "fo-board:1", "fo-board:2", "fo-menu:1", "fo-household:1", "fo-course:1", "fo-title:1", "fo-notes:1", "fo-party:1",
  "fo-all-courses:", "fo-catalog:", "fo-all-households:", "fo-plan:7", "fo-pub-courses:",
  "fo-seating:1", "fo-slots-of:1", "fo-tagged:1",
];
const read = [
  "fo-courses-like:S", "fo-weddings:", "fo-drinks:1", "fo-courses-noted-on:", "fo-board-on:1:2021-01-01", "fo-notes-on:2021-01-01",
  "fo-inbox:a@x", "fo-inbox:b@x", "fo-menu-card:1", "fo-menu-card:2",
  "fo-seats-kept:1", "fo-seats-at:3", "fo-slots-upto:5", "fo-slots-by:2026-01-01", "fo-tags-labelled:red",
];
const docs = [...written, ...read];
const names = ["Soup", "Salad", "Stew", "Fish", "Cake"];
const emails = ["a@x", "b@x", "c@x", "d@x"];
const times = ["2026-01-01", "2026-01-01T10:00:00+02:00", "2025-12-31T23:30:00Z", "2026-01-01 08:00:00.25", "2026-01-02T00:00:00Z"];

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
type Known = Record<"weddings" | "courses" | "drinks" | "households" | "favours" | "notes" | "seats" | "slots" | "tags", number[]>;

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
    seats: ids("fo-seating:1", "seats"),
    slots: ids("fo-slots-of:1", "slots"),
    tags: ids("fo-tagged:1", "tags"),
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
    case "fo-seating:1": {
      const wishes = () => r.pick([null, { veg: true }, [1, 2], "window", 3]);
      on(
        () => ({ op: "add", path: `/seats/${id()}`, value: { table_no: 1 + r.int(5), kept: r.next() < 0.5, wishes: wishes() } }),
        () => ({ op: "replace", path: `/seats/${some(k.seats)}/table_no`, value: 1 + r.int(5) }),
        () => ({ op: "replace", path: `/seats/${some(k.seats)}/kept`, value: r.next() < 0.5 }),
        () => ({ op: "replace", path: `/seats/${some(k.seats)}`, value: { wishes: wishes(), table_no: 3 } }),
        () => ({ op: "remove", path: `/seats/${some(k.seats)}` }),
      );
      break;
    }
    case "fo-slots-of:1":
      on(
        () => ({ op: "add", path: `/slots/${id()}`, value: { price: r.pick([null, 1.5, 3, 7]), starts: r.pick([null, ...times]) } }),
        () => ({ op: "replace", path: `/slots/${some(k.slots)}/starts`, value: r.pick(times) }),
        () => ({ op: "replace", path: `/slots/${some(k.slots)}/price`, value: r.pick([2.5, 6]) }),
        () => ({ op: "remove", path: `/slots/${some(k.slots)}` }),
      );
      break;
    case "fo-tagged:1":
      on(
        () => ({ op: "add", path: `/tags/${id()}`, value: { label: r.pick(["red", "blue"]) } }),
        () => ({ op: "replace", path: `/tags/${some(k.tags)}/label`, value: r.pick(["red", "green"]) }),
        () => ({ op: "remove", path: `/tags/${some(k.tags)}` }),
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

/**
 * An op made a mistake of, now and then, so a batch is refused part-way as well
 * as whole: a path no document takes, a field the row has not, a value not of
 * its column's type. (Not a text id, which SQLite keeps and Postgres refuses.)
 */
function spoil(op: DeltaOp, r: ReturnType<typeof random>): DeltaOp {
  const value = (op as any).value;
  const kind = op.op === "remove" ? 0 : r.int(3);
  if (kind === 0) return { ...op, path: r.pick(["/nowhere/1", "courses", "/courses/1/name/x", ""]) } as DeltaOp;
  if (kind === 1) return { ...op, value: value !== null && typeof value === "object" ? { ...value, nope: 1 } : { nope: value } } as DeltaOp;
  const wrong = (v: unknown) => (typeof v === "string" ? r.pick([5, "nope"]) : typeof v === "number" ? r.pick([true, "abc"]) : "x");
  if (value === null || typeof value !== "object") return { ...op, value: wrong(value) } as DeltaOp;
  const [field] = Object.keys(value);
  return { ...op, value: { ...value, [field!]: wrong(value[field!]) } } as DeltaOp;
}

/** The next step: a write, or an undo or redo on someone's cursor -- a redo, often, straight after an undo. */
function stepOf(r: ReturnType<typeof random>, k: Known, last: Step | undefined): Step {
  if (last?.kind === "undo" && r.next() < 0.5) return { kind: "redo", cursor: last.cursor };
  const cursor = r.pick(people).name;
  const roll = r.next();
  if (roll < 0.15) return { kind: "undo", cursor };
  if (roll < 0.2) return { kind: "redo", cursor };
  const doc = r.pick(written);
  const n = r.next() < 0.75 ? 1 : 2 + r.int(2);   // now and then a batch of several ops
  const ops = Array.from({ length: n }, () => opFor(doc, r, k)).map((op) => (r.next() < 0.06 ? spoil(op, r) : op));
  return { kind: "delta", doc, ops, cursor };
}

// ---------------------------------------------------------------------------
// Taking a step, and the law after it
// ---------------------------------------------------------------------------

const meOf = (name: string) => people.find((p) => p.name === name)!.me;

/** What a step answers, as every backend must answer it alike: a code, or the ops a write applied or a walk took and its conflict. */
async function take(p: Place, step: Step): Promise<unknown> {
  const as = p.as(meOf(step.cursor));
  const res = step.kind === "delta"
    ? await as.call("delta", { doc: step.doc, ops: step.ops, cursor: step.cursor, inverse: true })
    : await as.call(step.kind, { cursor: step.cursor });
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

/** A person's copy of an open document: as it opened, with what it was told since `at` applied; its version, if it keeps one. */
type Copy = { doc: any; v?: number; at: number };
/** Each watcher's copies, by document; undefined while the document is not open to them (not there, or let go). */
type Copies = Map<string, Map<string, Copy | undefined>>;

/** `me` opens `doc` on `p`: a copy, or undefined when it is not there (404). */
async function keep(p: Place, me: Me, doc: string): Promise<Copy | undefined> {
  const res = await p.as(me).call("open", { doc });
  if (res.error?.code === 404) return undefined;
  if (res.error) throw new Error(`${p.name}: open ${doc}: ${JSON.stringify(res.error)}`);
  return { doc: content(structuredClone(res.result)), v: res.result._v, at: p.heard.length };
}

/**
 * Apply to `copy` what `me` was told on `doc` since it was last brought up to
 * date, each change at the version after the last; false when it was let go
 * (404: a custom document whose read is gone), after which it hears nothing more.
 */
function catchUp(p: Place, me: Me, doc: string, copy: Copy): boolean {
  let open = true;
  for (const h of p.heard.slice(copy.at)) {
    if (h.channel !== doc || (h.to !== undefined && h.to !== me.id)) continue;
    expect({ place: p.name, doc, me: me.id, after: open ? undefined : h.data }).toEqual({ place: p.name, doc, me: me.id, after: undefined });
    if (h.data.error) { open = false; continue; }
    if (copy.v !== undefined) {
      expect({ place: p.name, doc, v: h.data.v }).toEqual({ place: p.name, doc, v: copy.v + 1 });
      copy.v = h.data.v;
    }
    applyOps(copy.doc, h.data.ops);
  }
  copy.at = p.heard.length;
  return open;
}

/**
 * The law on `p`: each watcher's copy of each document, with what it was
 * told applied, equals what a reader of its own opens from the tables, and
 * keeps its version; a copy whose document is not there was told its root is
 * null (or, a custom one, was let go), and is opened again once it is. Then a
 * few copies are opened again, as their watcher, while the other keeps the
 * document open: what the writing server answers from what it keeps must be
 * what the tables say (todo #64's class). Answers every document as read (null: not there).
 */
async function law(p: Place, copies: Copies, reopen: [number, number][]): Promise<Record<string, any>> {
  await p.quiet();
  const reader = await p.reader();
  const fresh: Record<string, any> = {};
  for (const doc of docs) {
    const res = await reader.call("open", { doc });
    if (res.error && res.error.code !== 404) throw new Error(`${p.name}: reader: open ${doc}: ${JSON.stringify(res.error)}`);
    fresh[doc] = res.error ? null : res.result;
    await reader.call("close", { doc });
  }
  await reader.done();
  for (const { me } of watchers) {
    const mine = copies.get(String(me.id))!;
    for (const doc of docs) {
      const copy = mine.get(doc);
      if (!copy || !catchUp(p, me, doc, copy)) {
        mine.set(doc, fresh[doc] === null ? undefined : await keep(p, me, doc));
        continue;
      }
      const at = { place: p.name, doc, me: me.id };
      if (fresh[doc] === null) {
        const root = Object.keys(copy.doc ?? {}).find((k) => copy.doc[k] === null || (typeof copy.doc[k] === "object" && "id" in copy.doc[k]));
        expect({ ...at, gone: root ? copy.doc[root] : copy.doc }).toEqual({ ...at, gone: null });
        continue;
      }
      expect({ ...at, copy: copy.doc, v: copy.v }).toEqual({ ...at, copy: content(fresh[doc]), v: fresh[doc]._v });
    }
  }
  // a few opened again from what the writing server keeps, the other watcher still holding them
  for (const [w, d] of reopen) {
    const { me } = watchers[w % watchers.length]!;
    const doc = docs[d % docs.length]!;
    if (fresh[doc] === null || !copies.get(String(me.id))!.get(doc)) continue;
    await p.as(me).call("close", { doc });
    const again = await keep(p, me, doc);
    const at = { place: p.name, doc, me: me.id, reopened: true };
    expect({ ...at, copy: again?.doc, v: again?.v }).toEqual({ ...at, copy: content(fresh[doc]), v: fresh[doc]._v });
    copies.get(String(me.id))!.set(doc, again);
  }
  return fresh;
}

/** What each watcher was told since `from`, by channel, in order: a broadcast, or a message to them alone (how a backend sends it is its own). */
function toldSince(p: Place, from: number): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const h of p.heard.slice(from)) {
    for (const { name, me } of watchers) if (h.to === undefined || h.to === me.id) (out[`${name}: ${h.channel}`] ??= []).push(h.data);
  }
  return out;
}

/** What every place answers when each answers as the first does. */
const alike = (places: Place[], first: unknown): Record<string, any> => Object.fromEntries(places.map((p) => [p.name, first]));

/** Run `seed` on the places: the same steps to each, the law, the answers, what was told and what is read asked after every one. */
async function drive(seed: number, places: Place[]): Promise<void> {
  const r = random(seed);
  const copies = new Map<Place, Copies>();
  for (const p of places) {
    const theirs: Copies = new Map();
    for (const { me } of watchers) {
      const mine = new Map<string, Copy | undefined>();
      for (const doc of docs) mine.set(doc, await keep(p, me, doc));
      theirs.set(String(me.id), mine);
    }
    copies.set(p, theirs);
  }
  let fresh = await law(places[0]!, copies.get(places[0]!)!, []);
  const steps: Step[] = [];
  for (let i = 0; i < STEPS; i++) {
    const step = stepOf(r, know(Object.fromEntries(Object.entries(fresh).map(([d, v]) => [d, content(v)]))), steps.at(-1));
    const reopen: [number, number][] = [[r.int(2), r.int(docs.length)], [r.int(2), r.int(docs.length)]];
    steps.push(step);
    try {
      const answers: Record<string, unknown> = {};
      const from = new Map(places.map((p) => [p, p.heard.length]));
      for (const p of places) answers[p.name] = await take(p, step);
      expect(answers).toEqual(alike(places, answers[places[0]!.name]));
      for (const p of places) await p.quiet();
      const told: Record<string, unknown> = Object.fromEntries(places.map((p) => [p.name, toldSince(p, from.get(p)!)]));
      expect(told).toEqual(alike(places, told[places[0]!.name]));
      const reads: Record<string, Record<string, unknown>> = {};
      for (const p of places) reads[p.name] = await law(p, copies.get(p)!, reopen);
      fresh = reads[places[0]!.name]!;
      for (const doc of docs) {
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
