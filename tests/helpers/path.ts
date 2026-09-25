/**
 * One app, every place its truth can live -- a JSON file, SQLite, Postgres in
 * this process (PGlite), a Postgres server -- and the same answers from each.
 *
 * A project may start on a JSON file, move to SQLite, then to Postgres in
 * process, and deliver on a Postgres server. The app does not change on the
 * way: the same schema, the same documents, the same writes, the same data
 * with the same serial ids. Only where the truth lives changes. This is the
 * proof: each backend's file supplies an adapter (`PathBackend`) and asks
 * every case below of it. Where a backend answers differently, it is wrong.
 *
 * Every case ends on the law (todo #27): each document still open, with
 * everything it was told applied to what it opened, equals a fresh open. A
 * message missing, extra, misshapen or out of order breaks it, whatever the
 * case set out to show. Values are compared exactly as Postgres gives them:
 * ids are numbers, a temporal row has no validity columns. Only a copy's
 * version (`_v`) is left out of the law; versions have their own cases.
 */
import { describe, expect, test } from "bun:test";
import { applyOps } from "../../src/core";
import { defineDoc, defineSchema } from "../../src/schema";
import { waitFor } from "../setup";

// ---------------------------------------------------------------------------
// The one schema, documents and seed
// ---------------------------------------------------------------------------

/**
 * A wedding and what hangs off it. households, courses and notes are children
 * of the wedding; drinks are grandchildren (children of a course); tags have
 * no parent, so every document that includes them holds all of them; notes are
 * temporal (a remove closes the row; its history stays).
 */
export const pathSchema = defineSchema({
  weddings: { table: "fo_weddings", columns: { name: "text" }, temporal: false },
  households: { table: "fo_households", parent: "weddings", columns: { email: "text" }, temporal: false },
  courses: { table: "fo_courses", parent: "weddings", columns: { name: "text" }, temporal: false },
  drinks: { table: "fo_drinks", parent: "courses", columns: { name: "text" }, temporal: false },
  tags: { table: "fo_tags", columns: { label: "text" }, temporal: false },
  notes: { table: "fo_notes", parent: "weddings", columns: { text: "text" }, temporal: true },
});

/** Several documents over the same rows, cut different ways. */
export const pathDocs = [
  // the couple's board: everything under the wedding
  defineDoc("fo-board:", { root: "weddings", include: ["households", "courses", "drinks", "tags", "notes"] }),
  // the caterer's menu: the courses and their drinks
  defineDoc("fo-menu:", { root: "weddings", include: ["courses", "drinks"] }),
  // one household's own document: the row is the root
  defineDoc("fo-household:", { root: "households", include: [] }),
  // one course, with its drinks: a child row as the root, a grandchild as its child
  defineDoc("fo-course:", { root: "courses", include: ["drinks"] }),
  // the wedding's name alone: the root, and none of the children
  defineDoc("fo-title:", { root: "weddings", include: [] }),
  // the shared tags beside a wedding
  defineDoc("fo-tagged:", { root: "weddings", include: ["tags"] }),
  // the notes beside a wedding (temporal)
  defineDoc("fo-notes:", { root: "weddings", include: ["notes"] }),
  // list mode: every course; and the courses whose name starts with the doc's id
  defineDoc("fo-all-courses:", { root: "courses", include: [] }),
  defineDoc("fo-courses-like:", { root: "courses", include: [], scope: { name: "like:start" } }),
];

/** Rows as every backend is seeded with them: through `importTables`, which sets each sequence past its rows. */
export interface Snapshot {
  /** Rows by collection key, each with its id (a number) and its parent key. */
  tables: Record<string, Record<string, unknown>[]>;
  /** The last id each collection has minted; missing, the largest id among its rows. */
  sequences?: Record<string, number>;
}

/** Wedding 2 is the bystander. The temporal note began long ago. */
export const pathSeed: Snapshot = {
  tables: {
    weddings: [{ id: 1, name: "ours" }, { id: 2, name: "theirs" }],
    households: [{ id: 1, weddings_id: 1, email: "a@x" }, { id: 2, weddings_id: 1, email: "b@x" }, { id: 3, weddings_id: 2, email: "c@x" }],
    courses: [{ id: 1, weddings_id: 1, name: "Soup" }, { id: 2, weddings_id: 2, name: "Salad" }],
    drinks: [{ id: 1, courses_id: 1, name: "Sherry" }, { id: 2, courses_id: 2, name: "Water" }],
    tags: [{ id: 1, label: "red" }],
    notes: [{ id: 1, weddings_id: 1, text: "bring chairs", valid_from: "2020-01-01T00:00:00.000Z", valid_to: null }],
  },
};

/** Rows as a fresh open reads them. */
export const course = (id: number, name: string, wedding = 1) => ({ id, weddings_id: wedding, name });
export const drink = (id: number, courseId: number, name: string) => ({ id, courses_id: courseId, name });
export const household = (id: number, email: string, wedding = 1) => ({ id, weddings_id: wedding, email });

// ---------------------------------------------------------------------------
// The adapter a backend supplies
// ---------------------------------------------------------------------------

/** One process: delta over the backend, in-process (`createLocal()`), and everything it published. */
export interface PathProcess {
  call(action: string, msg: Record<string, unknown>): Promise<any>;
  heard: { channel: string; data: any }[];
}

export interface PathBackend {
  /** The process the cases write through: the schema and seed in place, a ledger kept. */
  process: PathProcess;
  /** Resolve once everything a write set going has been delivered. */
  quiet(): Promise<void>;
  /** Every row the backend holds, as `importTables` takes them: what carries to the next backend. */
  exportTables(): Promise<Snapshot>;
}

// ---------------------------------------------------------------------------
// Reading what was told
// ---------------------------------------------------------------------------

/** A copy as the law compares it: its version is not its content. */
function content(doc: any): any {
  if (doc === null || typeof doc !== "object") return doc;
  const { _v, ...rest } = doc;
  return rest;
}

/** The ops each message on `channel` carried, in order. */
export const told = (p: PathProcess, channel: string): unknown[][] =>
  p.heard.filter((h) => h.channel === channel).map((h) => h.data.ops);

/** The ops `channel` was told, as one list. */
export const toldOps = (p: PathProcess, channel: string): any[] => told(p, channel).flat();

// ---------------------------------------------------------------------------
// The law
// ---------------------------------------------------------------------------

/** Open `docs` and keep what each opened, to hold against what it is told. */
export async function openAll(p: PathProcess, docs: string[]): Promise<Map<string, any>> {
  const copies = new Map<string, any>();
  for (const doc of docs) {
    const res = await p.call("open", { doc });
    if (res.error) throw new Error(`open ${doc}: ${JSON.stringify(res.error)}`);
    copies.set(doc, structuredClone(res.result));
  }
  p.heard.length = 0; // only what the writes tell counts
  return copies;
}

/**
 * Each copy, with what its channel was told since `openAll` applied in order,
 * equals a fresh open. A document whose root row is gone opens as 404; its
 * copy must then have been told its root is null.
 */
export async function assertCopiesHold(b: PathBackend, copies: Map<string, any>): Promise<void> {
  await b.quiet();
  for (const [doc, opened] of copies) {
    const copy = structuredClone(opened);
    for (const h of b.process.heard.filter((m) => m.channel === doc)) applyOps(copy, h.data.ops);
    const fresh = await b.process.call("open", { doc });
    if (fresh.error?.code === 404) {
      const root = Object.keys(opened).find((k) => opened[k] && typeof opened[k] === "object" && "id" in opened[k]);
      expect({ doc, root: root ? copy[root] : copy }).toEqual({ doc, root: null });
      continue;
    }
    expect({ doc, copy: content(copy) }).toEqual({ doc, copy: content(fresh.result) });
  }
}

// ---------------------------------------------------------------------------
// Writing, and waiting to be told
// ---------------------------------------------------------------------------

/** Write through `doc`, and fail the case if the write is refused. */
export async function write(p: PathProcess, doc: string, ops: unknown[], extra: Record<string, unknown> = {}): Promise<any> {
  const res = await p.call("delta", { doc, ops, ...extra });
  if (res.error) throw new Error(`delta ${doc}: ${JSON.stringify(res.error)}`);
  return res.result;
}

/**
 * `channel` was told exactly `expected`, message by message: waits until as
 * many messages as expected have come, then lets the backend go quiet and
 * compares the lot, so a late extra message fails too.
 */
export async function expectTold(b: PathBackend, channel: string, expected: unknown[][]): Promise<void> {
  await waitFor(() => told(b.process, channel).length >= expected.length, { timeout: 3000 }).catch(() => {});
  await b.quiet();
  expect({ channel, told: told(b.process, channel) }).toEqual({ channel, told: expected });
}

/** Nothing was told on any of `channels`. */
export async function expectSilent(b: PathBackend, ...channels: string[]): Promise<void> {
  await b.quiet();
  for (const channel of channels) expect({ channel, told: told(b.process, channel) }).toEqual({ channel, told: [] });
}

// ---------------------------------------------------------------------------
// The cases
// ---------------------------------------------------------------------------

/** Every case, asked of the backend `backend()` answers (a fresh one per case). */
export function pathCases(backend: () => PathBackend): void {
  documentCases(backend);
  fanOutCases(backend);
}

/** What a document is, read and written through, on its own. */
export function documentCases(backend: () => PathBackend): void {
  describe("a document, read and written", () => {
    test("opening the board reads the rows as Postgres gives them: ids as numbers, no validity columns", async () => {
      const { result } = await backend().process.call("open", { doc: "fo-board:1" });
      expect(content(result)).toEqual({
        weddings: { id: 1, name: "ours" },
        households: { "1": household(1, "a@x"), "2": household(2, "b@x") },
        courses: { "1": course(1, "Soup") },
        drinks: { "1": drink(1, 1, "Sherry") },
        tags: { "1": { id: 1, label: "red" } },
        notes: { "1": { id: 1, weddings_id: 1, text: "bring chairs" } },
      });
    });

    test("a document whose root is a child row reads that row as its root", async () => {
      const { result } = await backend().process.call("open", { doc: "fo-course:1" });
      expect(content(result)).toEqual({ courses: course(1, "Soup"), drinks: { "1": drink(1, 1, "Sherry") } });
    });

    test("a document whose root row is not there is not found", async () => {
      expect((await backend().process.call("open", { doc: "fo-household:99" })).error?.code).toBe(404);
    });

    test("a list-mode document reads every row of its root; one with a condition, the rows that meet it", async () => {
      const b = backend();
      expect(content((await b.process.call("open", { doc: "fo-all-courses:" })).result)).toEqual({ courses: { "1": course(1, "Soup"), "2": course(2, "Salad", 2) } });
      expect(content((await b.process.call("open", { doc: "fo-courses-like:So" })).result)).toEqual({ courses: { "1": course(1, "Soup") } });
      expect(content((await b.process.call("open", { doc: "fo-courses-like:X" })).result)).toEqual({ courses: {} });
    });

    test("a row added at /- is named by the store: the next serial after the rows it holds", async () => {
      const b = backend();
      await openAll(b.process, ["fo-board:1"]);
      const result = await write(b.process, "fo-board:1", [
        { op: "add", path: "/courses/-", value: { name: "Fish" } },
        { op: "add", path: "/tags/-", value: { label: "blue" } },
      ]);
      expect(result.ops).toEqual([
        { op: "add", path: "/courses/3", value: course(3, "Fish") },
        { op: "add", path: "/tags/2", value: { id: 2, label: "blue" } },
      ]);
      await expectTold(b, "fo-board:1", [result.ops]);
    });

    test("the same mistake is refused with the same code: a row not there 404, an unknown field 400, a row already there 409", async () => {
      const b = backend();
      await openAll(b.process, ["fo-board:1"]);
      const code = async (ops: unknown[]) => (await b.process.call("delta", { doc: "fo-board:1", ops })).error?.code;
      expect(await code([{ op: "replace", path: "/courses/99/name", value: "x" }])).toBe(404);
      expect(await code([{ op: "replace", path: "/courses/1/nope", value: "x" }])).toBe(400);
      expect(await code([{ op: "add", path: "/courses/1", value: { name: "again" } }])).toBe(409);
      expect(await code([{ op: "remove", path: "/courses/2" }])).toBe(404); // the other wedding's: not in this document
    });

    test("every change a document is told carries its next version, and an open reads the version it is at", async () => {
      const b = backend();
      const before = (await b.process.call("open", { doc: "fo-menu:1" })).result._v as number;
      await openAll(b.process, ["fo-board:1", "fo-menu:1"]);
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/courses/1/name", value: "Broth" }]);
      await write(b.process, "fo-menu:1", [{ op: "replace", path: "/courses/1/name", value: "Bisque" }]);
      await expectTold(b, "fo-menu:1", [
        [{ op: "replace", path: "/courses/1", value: course(1, "Broth") }],
        [{ op: "replace", path: "/courses/1", value: course(1, "Bisque") }],
      ]);
      expect(b.process.heard.filter((h) => h.channel === "fo-menu:1").map((h) => h.data.v)).toEqual([before + 1, before + 2]);
      expect((await b.process.call("open", { doc: "fo-menu:1" })).result._v).toBe(before + 2);
    });

    test("history says what was written through a document, newest first, and whose it was", async () => {
      const b = backend();
      await openAll(b.process, ["fo-board:1"]);
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/courses/1/name", value: "Broth" }], { cursor: "s1" });
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/weddings/name", value: "our day" }], { cursor: "s1" });
      const { result } = await b.process.call("history", { doc: "fo-board:1", cursor: "s1" });
      expect(result.map((e: any) => ({ ops: e.ops.map((o: any) => `${o.op} ${o.path}`), mine: e.mine }))).toEqual([
        { ops: ["replace /weddings"], mine: true },
        { ops: ["replace /courses/1"], mine: true },
      ]);
    });

    test("a document read as it stood at a time before a change shows it as it was", async () => {
      const b = backend();
      await openAll(b.process, ["fo-board:1"]);
      const { result } = await b.process.call("open_at", { doc: "fo-notes:1", at: "2021-01-01T00:00:00.000Z" });
      expect(content(result).notes).toEqual({ "1": { id: 1, weddings_id: 1, text: "bring chairs" } });
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/notes/1/text", value: "bring tables" }]);
      const then = await b.process.call("open_at", { doc: "fo-notes:1", at: "2021-01-01T00:00:00.000Z" });
      expect(content(then.result).notes).toEqual({ "1": { id: 1, weddings_id: 1, text: "bring chairs" } });
      const now = await b.process.call("open", { doc: "fo-notes:1" });
      expect(content(now.result).notes).toEqual({ "1": { id: 1, weddings_id: 1, text: "bring tables" } });
    });
  });
}

/** A write reaches every other open document that holds a row it changed -- and none that do not (todo #28). */
export function fanOutCases(backend: () => PathBackend): void {
  describe("a row two documents hold as a map", () => {
    test("a field written through the board reaches the menu as the whole row, and the course's own document as its root", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-menu:1", "fo-course:1"]);
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/courses/1/name", value: "Consommé" }]);
      await expectTold(b, "fo-menu:1", [[{ op: "replace", path: "/courses/1", value: course(1, "Consommé") }]]);
      await expectTold(b, "fo-course:1", [[{ op: "replace", path: "/courses", value: course(1, "Consommé") }]]);
      await assertCopiesHold(b, copies);
    });

    test("a row added through the board reaches the menu", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-menu:1"]);
      await write(b.process, "fo-board:1", [{ op: "add", path: "/courses/10", value: { name: "Fish" } }]);
      await expectTold(b, "fo-menu:1", [[{ op: "add", path: "/courses/10", value: course(10, "Fish") }]]);
      await assertCopiesHold(b, copies);
    });

    test("a grandchild added through the board reaches the menu and its course's own document, found through its parent", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-menu:1", "fo-course:1"]);
      await write(b.process, "fo-board:1", [{ op: "add", path: "/drinks/10", value: { courses_id: 1, name: "Claret" } }]);
      await expectTold(b, "fo-menu:1", [[{ op: "add", path: "/drinks/10", value: drink(10, 1, "Claret") }]]);
      await expectTold(b, "fo-course:1", [[{ op: "add", path: "/drinks/10", value: drink(10, 1, "Claret") }]]);
      await assertCopiesHold(b, copies);
    });

    test("a course and its drink added in one write reach the menu course first, so the drink finds its parent", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-menu:1"]);
      await write(b.process, "fo-board:1", [
        { op: "add", path: "/courses/10", value: { name: "Fish" } },
        { op: "add", path: "/drinks/10", value: { courses_id: 10, name: "Chablis" } },
      ]);
      await expectTold(b, "fo-menu:1", [[
        { op: "add", path: "/courses/10", value: course(10, "Fish") },
        { op: "add", path: "/drinks/10", value: drink(10, 10, "Chablis") },
      ]]);
      await assertCopiesHold(b, copies);
    });

    test("a course removed through the board leaves the menu, with the drinks it takes with it", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-menu:1"]);
      await write(b.process, "fo-board:1", [{ op: "remove", path: "/courses/1" }]);
      await expectTold(b, "fo-menu:1", [[{ op: "remove", path: "/courses/1" }, { op: "remove", path: "/drinks/1" }]]);
      await assertCopiesHold(b, copies);
    });

    test("a drink written through its course's own document reaches the board and the menu", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-course:1", "fo-board:1", "fo-menu:1"]);
      await write(b.process, "fo-course:1", [{ op: "replace", path: "/drinks/1/name", value: "Madeira" }]);
      await expectTold(b, "fo-board:1", [[{ op: "replace", path: "/drinks/1", value: drink(1, 1, "Madeira") }]]);
      await expectTold(b, "fo-menu:1", [[{ op: "replace", path: "/drinks/1", value: drink(1, 1, "Madeira") }]]);
      await assertCopiesHold(b, copies);
    });
  });

  describe("a row one document holds as a map and another as its root", () => {
    test("written in the board's map, it reaches the household's own document as its root, replaced whole; the other household hears nothing", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-household:1", "fo-household:2"]);
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/households/1/email", value: "new@x" }]);
      await expectTold(b, "fo-household:1", [[{ op: "replace", path: "/households", value: household(1, "new@x") }]]);
      await expectSilent(b, "fo-household:2");
      await assertCopiesHold(b, copies);
    });

    test("written through the household's own document, it reaches the board's map as the keyed row", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-household:1", "fo-board:1"]);
      await write(b.process, "fo-household:1", [{ op: "replace", path: "/households/email", value: "mine@x" }]);
      await expectTold(b, "fo-household:1", [[{ op: "replace", path: "/households", value: household(1, "mine@x") }]]);
      await expectTold(b, "fo-board:1", [[{ op: "replace", path: "/households/1", value: household(1, "mine@x") }]]);
      await assertCopiesHold(b, copies);
    });

    test("taken out of the board's map, it takes the household's root with it", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-household:1"]);
      await write(b.process, "fo-board:1", [{ op: "remove", path: "/households/1" }]);
      await expectTold(b, "fo-board:1", [[{ op: "remove", path: "/households/1" }]]);
      await expectTold(b, "fo-household:1", [[{ op: "replace", path: "/households", value: null }]]);
      await assertCopiesHold(b, copies);
    });

    test("one write to two households: each household's document is told of its own row alone, once", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-household:1", "fo-household:2"]);
      await write(b.process, "fo-board:1", [
        { op: "replace", path: "/households/1/email", value: "one@x" },
        { op: "replace", path: "/households/2/email", value: "two@x" },
      ]);
      await expectTold(b, "fo-household:1", [[{ op: "replace", path: "/households", value: household(1, "one@x") }]]);
      await expectTold(b, "fo-household:2", [[{ op: "replace", path: "/households", value: household(2, "two@x") }]]);
      await assertCopiesHold(b, copies);
    });
  });

  describe("a root two documents share", () => {
    test("the wedding renamed through the board reaches the menu and the title, each as its root", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-menu:1", "fo-title:1"]);
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/weddings/name", value: "our day" }]);
      await expectTold(b, "fo-menu:1", [[{ op: "replace", path: "/weddings", value: { id: 1, name: "our day" } }]]);
      await expectTold(b, "fo-title:1", [[{ op: "replace", path: "/weddings", value: { id: 1, name: "our day" } }]]);
      await assertCopiesHold(b, copies);
    });
  });

  describe("a collection with no parent: every document that includes it holds all of it", () => {
    test("a tag added through one wedding's board reaches the other wedding's board, and every tagged document", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-board:2", "fo-tagged:1", "fo-tagged:2"]);
      await write(b.process, "fo-board:1", [{ op: "add", path: "/tags/10", value: { label: "blue" } }]);
      for (const doc of ["fo-board:2", "fo-tagged:1", "fo-tagged:2"]) {
        await expectTold(b, doc, [[{ op: "add", path: "/tags/10", value: { id: 10, label: "blue" } }]]);
      }
      await assertCopiesHold(b, copies);
    });
  });

  describe("a temporal collection", () => {
    test("a note changed through the board reaches the notes document as the row, without its validity", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-notes:1"]);
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/notes/1/text", value: "bring tables" }]);
      await expectTold(b, "fo-notes:1", [[{ op: "replace", path: "/notes/1", value: { id: 1, weddings_id: 1, text: "bring tables" } }]]);
      await assertCopiesHold(b, copies);
    });

    test("a note closed through the board (removed: its history kept, no longer current) leaves the notes document", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-notes:1"]);
      await write(b.process, "fo-board:1", [{ op: "remove", path: "/notes/1" }]);
      await expectTold(b, "fo-notes:1", [[{ op: "remove", path: "/notes/1" }]]);
      await assertCopiesHold(b, copies);
    });
  });

  describe("undo and redo are writes too", () => {
    test("undoing a course added through the board takes it out of the menu; redoing puts it back", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-menu:1"]);
      await write(b.process, "fo-board:1", [{ op: "add", path: "/courses/10", value: { name: "Fish" } }], { cursor: "s1" });
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect(undone.error).toBeUndefined();
      const redone = await b.process.call("redo", { cursor: "s1" });
      expect(redone.error).toBeUndefined();
      await expectTold(b, "fo-menu:1", [
        [{ op: "add", path: "/courses/10", value: course(10, "Fish") }],
        [{ op: "remove", path: "/courses/10" }],
        [{ op: "add", path: "/courses/10", value: course(10, "Fish") }],
      ]);
      await assertCopiesHold(b, copies);
    });

    test("an undo puts a dropped course back with its drink, course first, and the menu hears it so", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-menu:1"]);
      await write(b.process, "fo-board:1", [{ op: "remove", path: "/courses/1" }], { cursor: "s1" });
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect(undone.result.ops.map((o: any) => `${o.op} ${o.path}`)).toEqual(["add /courses/1", "add /drinks/1"]);
      await expectTold(b, "fo-menu:1", [
        [{ op: "remove", path: "/courses/1" }, { op: "remove", path: "/drinks/1" }],
        [{ op: "add", path: "/courses/1", value: course(1, "Soup") }, { op: "add", path: "/drinks/1", value: drink(1, 1, "Sherry") }],
      ]);
      await assertCopiesHold(b, copies);
    });
  });

  describe("who is not told", () => {
    test("the writer's own document hears its write once, not again by fan-out", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-menu:1"]);
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/courses/1/name", value: "Broth" }]);
      await expectTold(b, "fo-board:1", [[{ op: "replace", path: "/courses/1", value: course(1, "Broth") }]]);
      await assertCopiesHold(b, copies);
    });

    test("documents over another wedding hear nothing of this one's writes", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-board:2", "fo-menu:2", "fo-household:3", "fo-course:2", "fo-title:2", "fo-notes:2"]);
      await write(b.process, "fo-board:1", [
        { op: "replace", path: "/courses/1/name", value: "Broth" },
        { op: "add", path: "/drinks/10", value: { courses_id: 1, name: "Port" } },
        { op: "replace", path: "/households/1/email", value: "z@x" },
        { op: "replace", path: "/weddings/name", value: "ours, renamed" },
        { op: "replace", path: "/notes/1/text", value: "bring lights" },
      ]);
      await expectSilent(b, "fo-board:2", "fo-menu:2", "fo-household:3", "fo-course:2", "fo-title:2", "fo-notes:2");
      await assertCopiesHold(b, copies);
    });

    test("a document that does not include the collection hears nothing of it", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-title:1", "fo-tagged:1"]);
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/courses/1/name", value: "Broth" }]);
      await expectSilent(b, "fo-title:1", "fo-tagged:1");
      await assertCopiesHold(b, copies);
    });

    test("a document closed before the write is not told, and opened afresh it reads the write", async () => {
      const b = backend();
      await openAll(b.process, ["fo-board:1", "fo-menu:1"]);
      await b.process.call("close", { doc: "fo-menu:1" });
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/courses/1/name", value: "Broth" }]);
      await expectSilent(b, "fo-menu:1");
      expect((await b.process.call("open", { doc: "fo-menu:1" })).result.courses["1"]).toEqual(course(1, "Broth"));
    });
  });

  describe("a row that moves from one document's scope to another's", () => {
    test("a household moved to the other wedding leaves this board and arrives on that one", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-board:2", "fo-household:1"]);
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/households/1/weddings_id", value: 2 }]);
      await expectTold(b, "fo-board:1", [[{ op: "remove", path: "/households/1" }]]);
      await expectTold(b, "fo-board:2", [[{ op: "add", path: "/households/1", value: household(1, "a@x", 2) }]]);
      await expectTold(b, "fo-household:1", [[{ op: "replace", path: "/households", value: household(1, "a@x", 2) }]]);
      await assertCopiesHold(b, copies);
    });

    test("a drink moved to another course leaves the one course's document and arrives in the other's", async () => {
      const b = backend();
      await b.process.call("open", { doc: "fo-board:1" });
      await write(b.process, "fo-board:1", [{ op: "add", path: "/courses/10", value: { name: "Fish" } }]);
      await b.quiet();
      const copies = await openAll(b.process, ["fo-board:1", "fo-course:1", "fo-course:10"]);
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/drinks/1/courses_id", value: 10 }]);
      await expectTold(b, "fo-course:1", [[{ op: "remove", path: "/drinks/1" }]]);
      await expectTold(b, "fo-course:10", [[{ op: "add", path: "/drinks/1", value: drink(1, 10, "Sherry") }]]);
      await assertCopiesHold(b, copies);
    });

    test("a course renamed out of one list's condition and into another's leaves the one and arrives in the other", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-courses-like:So", "fo-courses-like:Fi", "fo-all-courses:"]);
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/courses/1/name", value: "Fish soup" }]);
      await expectTold(b, "fo-courses-like:So", [[{ op: "remove", path: "/courses/1" }]]);
      await expectTold(b, "fo-courses-like:Fi", [[{ op: "add", path: "/courses/1", value: course(1, "Fish soup") }]]);
      await expectTold(b, "fo-all-courses:", [[{ op: "replace", path: "/courses/1", value: course(1, "Fish soup") }]]);
      await assertCopiesHold(b, copies);
    });

    test("a course added through the board reaches every-course and the list it meets the condition of, not the others", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-all-courses:", "fo-courses-like:Fi", "fo-courses-like:So"]);
      await write(b.process, "fo-board:1", [{ op: "add", path: "/courses/10", value: { name: "Fish" } }]);
      await expectTold(b, "fo-all-courses:", [[{ op: "add", path: "/courses/10", value: course(10, "Fish") }]]);
      await expectTold(b, "fo-courses-like:Fi", [[{ op: "add", path: "/courses/10", value: course(10, "Fish") }]]);
      await expectSilent(b, "fo-courses-like:So");
      await assertCopiesHold(b, copies);
    });

    test("a course removed through the board leaves every-course", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-all-courses:"]);
      await write(b.process, "fo-board:1", [{ op: "remove", path: "/courses/1" }]);
      await expectTold(b, "fo-all-courses:", [[{ op: "remove", path: "/courses/1" }]]);
      await assertCopiesHold(b, copies);
    });
  });
}

// ---------------------------------------------------------------------------
// Carrying the data to the next place
// ---------------------------------------------------------------------------

/**
 * Every document of the seed, as a process opens it: what must read the same
 * after the data is carried to another backend.
 */
export const everyDocument = ["fo-board:1", "fo-board:2", "fo-menu:1", "fo-household:1", "fo-course:1", "fo-notes:1", "fo-all-courses:", "fo-courses-like:So"];

/** Open each of `docs` and answer what each read, without its version. */
export async function readAll(p: PathProcess, docs = everyDocument): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const doc of docs) out[doc] = content((await p.call("open", { doc })).result);
  return out;
}
