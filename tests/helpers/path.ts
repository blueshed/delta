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
 * temporal (a remove closes the row; its history stays); seats carry the other
 * column types: an integer, a boolean and a json column.
 */
export const pathSchema = defineSchema({
  weddings: { table: "fo_weddings", columns: { name: "text" }, temporal: false },
  households: { table: "fo_households", parent: "weddings", columns: { email: "text" }, temporal: false },
  courses: { table: "fo_courses", parent: "weddings", columns: { name: "text" }, temporal: false },
  drinks: { table: "fo_drinks", parent: "courses", columns: { name: "text" }, temporal: false },
  tags: { table: "fo_tags", columns: { label: "text" }, temporal: false },
  notes: { table: "fo_notes", parent: "weddings", columns: { text: "text" }, temporal: true },
  seats: { table: "fo_seats", parent: "weddings", columns: { table_no: "integer", kept: "boolean", wishes: "json?" }, temporal: false },
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
  // list mode by an equality: the tags of one label, which a tag added through it is given
  defineDoc("fo-tags-labelled:", { root: "tags", include: [], scope: { label: ":label" } }),
  // the seating plan: the wedding and its seats
  defineDoc("fo-seating:", { root: "weddings", include: ["seats"] }),
  // list mode by a boolean: the seats kept (1) or not (0), which a seat added through it is given
  defineDoc("fo-seats-kept:", { root: "seats", include: [], scope: { kept: ":kept" } }),
  // list mode by the other column types: a boolean's range, and an integer
  defineDoc("fo-seats-upto:", { root: "seats", include: [], scope: { kept: "<=:kept" } }),
  defineDoc("fo-seats-at:", { root: "seats", include: [], scope: { table_no: ":table" } }),
  // list mode by a json column: the seats whose wishes are the name read as JSON, which a seat added through it is given
  defineDoc("fo-seats-wished:", { root: "seats", include: [], scope: { wishes: ":wishes" } }),
];

/**
 * A custom document (`defineCustomDoc`, membership) beside them: the
 * households of one email, told of a write to a household row whichever
 * document it came through. Only the first read differs by backend (SQLite and
 * the JSON file read their database, Postgres its pool); the rest is the same.
 */
const inboxDoc = <Q>(query: Q) => ({
  prefix: "fo-inbox:",
  watch: ["households"],
  parse: (email: string) => email,
  query,
  matches: (_coll: string, row: any, email: string) => row.email === email,
});
const householdsTable = pathSchema.tables.households!.name;
export const sqliteInbox = inboxDoc((db: any, email: string) => ({ households: db.query(`SELECT * FROM ${householdsTable} WHERE email = ?`).all(email) }));
// each row as JSON, as a document reads it: pg gives a bare BIGINT column as text
export const postgresInbox = inboxDoc(async (pool: any, email: string) => ({ households: (await pool.query(`SELECT to_jsonb(h) AS row FROM ${householdsTable} h WHERE email = $1`, [email])).rows.map((r: any) => r.row) }));

/**
 * A custom document whose prefix starts with a list's: the seats not kept,
 * named fo-seats-at:open:<anything>. Its name is its own, never the list
 * fo-seats-at: read with "open" for a table number.
 */
const openSeatsDoc = <Q>(query: Q) => ({
  prefix: "fo-seats-at:open:",
  watch: ["seats"],
  parse: (name: string) => name,
  query,
  matches: (_coll: string, row: any) => row.kept === false,
});
const seatsTable = pathSchema.tables.seats!.name;
export const sqliteOpenSeats = openSeatsDoc((db: any) => ({ seats: db.query(`SELECT * FROM ${seatsTable} WHERE kept = 0`).all() }));
export const postgresOpenSeats = openSeatsDoc(async (pool: any) => ({ seats: (await pool.query(`SELECT to_jsonb(s) AS row FROM ${seatsTable} s WHERE NOT kept`)).rows.map((r: any) => r.row) }));

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
    seats: [{ id: 1, weddings_id: 1, table_no: 3, kept: true, wishes: { veg: true } }],
  },
};

/** Rows as a fresh open reads them. */
export const course = (id: number, name: string, wedding = 1) => ({ id, weddings_id: wedding, name });
export const drink = (id: number, courseId: number, name: string) => ({ id, courses_id: courseId, name });
export const household = (id: number, email: string, wedding = 1) => ({ id, weddings_id: wedding, email });
export const seat = (id: number, tableNo: number, kept: boolean, wishes: unknown = null, wedding = 1) => ({ id, weddings_id: wedding, table_no: tableNo, kept, wishes });

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
 * copy must then have been told its root is null. The fresh open is a real
 * one: the document is closed first, so no backend answers from a copy of its
 * own -- a custom document's is the one it keeps from what it told (todo #44).
 */
export async function assertCopiesHold(b: PathBackend, copies: Map<string, any>): Promise<void> {
  await b.quiet();
  for (const [doc, opened] of copies) {
    const copy = structuredClone(opened);
    for (const h of b.process.heard.filter((m) => m.channel === doc)) applyOps(copy, h.data.ops);
    await b.process.call("close", { doc });
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

    test("what a document answers is the caller's own: a write does not change it, and a change to it is not served -- the open's, the custom document's, a told row", async () => {
      const b = backend();
      const docs = ["fo-board:1", "fo-inbox:a@x"];
      const kept = new Map<string, any>();
      for (const doc of docs) kept.set(doc, (await b.process.call("open", { doc })).result);
      const was = structuredClone(kept);
      b.process.heard.length = 0;
      await write(b.process, "fo-board:1", [
        { op: "replace", path: "/courses/1/name", value: "Broth" },
        { op: "replace", path: "/households/1/email", value: "moved@x" },
        { op: "remove", path: "/households/2" },
        { op: "add", path: "/courses/-", value: { name: "Fish" } },
      ]);
      await b.quiet();
      expect(kept).toEqual(was);   // a write does not change what was handed out
      // a caller that changes what it was handed, or a row it was told, changes nothing it is served
      const board = kept.get("fo-board:1");
      board.weddings.name = "MUTATED";
      board.courses["1"].name = "MUTATED";
      delete board.drinks["1"];
      kept.get("fo-inbox:a@x").households["1"].email = "MUTATED";
      for (const h of b.process.heard) for (const op of h.data.ops) if (op.value && typeof op.value === "object") op.value.name = "MUTATED";
      const text = JSON.stringify([
        (await b.process.call("open", { doc: "fo-board:1" })).result,
        (await b.process.call("open", { doc: "fo-inbox:a@x" })).result,
        (await b.process.call("open", { doc: "fo-menu:1" })).result,
      ]);
      expect(text).not.toContain("MUTATED");
      expect(text).toContain("Broth");
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

    test("a condition reads the name as its column takes it, as an add through the name is given it: a boolean's true, yes and 1 are the seats kept, false, off and 0 the rest; an integer's 05 is 5; a json value is the JSON it names", async () => {
      const b = backend();
      await b.process.call("open", { doc: "fo-seating:1" });
      await write(b.process, "fo-seating:1", [{ op: "add", path: "/seats/-", value: { table_no: 5, kept: false, wishes: [1, 2] } }]);
      const seats = async (doc: string) => {
        const res = await b.process.call("open", { doc });
        return { doc, seats: res.error ?? Object.keys(res.result.seats).map(Number) };
      };
      for (const name of ["true", "yes", "1", "t", "on", "Y"]) expect(await seats(`fo-seats-kept:${name}`)).toEqual({ doc: `fo-seats-kept:${name}`, seats: [1] });
      for (const name of ["false", "off", "0", "f", "no", "N"]) expect(await seats(`fo-seats-kept:${name}`)).toEqual({ doc: `fo-seats-kept:${name}`, seats: [2] });
      expect(await seats("fo-seats-upto:off")).toEqual({ doc: "fo-seats-upto:off", seats: [2] }); // false <= false; true is not
      expect(await seats("fo-seats-upto:yes")).toEqual({ doc: "fo-seats-upto:yes", seats: [1, 2] });
      expect(await seats("fo-seats-at:05")).toEqual({ doc: "fo-seats-at:05", seats: [2] });
      expect(await seats("fo-seats-at:3")).toEqual({ doc: "fo-seats-at:3", seats: [1] });
      expect(await seats("fo-seats-wished:[1, 2]")).toEqual({ doc: "fo-seats-wished:[1, 2]", seats: [2] });
    });

    test("a name its column cannot take is refused as a mistake (400), opened or written through: a boolean's maybe, an integer's abc or 3.5, a json value that is not JSON", async () => {
      const b = backend();
      const add = [{ op: "add", path: "/seats/-", value: { weddings_id: 1, table_no: 4, kept: true } }];
      for (const doc of ["fo-seats-kept:maybe", "fo-seats-upto:maybe", "fo-seats-at:abc", "fo-seats-at:3.5", "fo-seats-wished:abc"]) {
        const open = (await b.process.call("open", { doc })).error?.code;
        const written = (await b.process.call("delta", { doc, ops: add })).error?.code;
        expect({ doc, open, written }).toEqual({ doc, open: 400, written: 400 });
      }
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

    test("a row added to a list-mode document is given its scope's values from the name: the value need not repeat them", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-tags-labelled:blue", "fo-board:1"]);
      const result = await write(b.process, "fo-tags-labelled:blue", [{ op: "add", path: "/tags/-", value: {} }]);
      expect(result.ops).toEqual([{ op: "add", path: "/tags/2", value: { id: 2, label: "blue" } }]);
      await expectTold(b, "fo-board:1", [result.ops]);
      await assertCopiesHold(b, copies);
    });

    test("a row told of an add is, key for key, the row a fresh open reads -- as JSON, the same text", async () => {
      const b = backend();
      await openAll(b.process, ["fo-board:1"]);
      const { ops } = await write(b.process, "fo-board:1", [{ op: "add", path: "/courses/-", value: { name: "Fish" } }]);
      await b.quiet();
      const toldRow = JSON.stringify(told(b.process, "fo-board:1")[0]![0] && (told(b.process, "fo-board:1")[0]![0] as any).value);
      const fresh = (await b.process.call("open", { doc: "fo-board:1" })).result.courses[ops[0].path.split("/")[2]];
      expect(toldRow).toBe(JSON.stringify(fresh));
      expect(JSON.stringify(ops[0].value)).toBe(JSON.stringify(fresh));
    });

    test("the same mistake is refused with the same code: a row not there 404, an unknown field 400, a row already there 409", async () => {
      const b = backend();
      await openAll(b.process, ["fo-board:1"]);
      const code = async (ops: unknown[]) => (await b.process.call("delta", { doc: "fo-board:1", ops })).error?.code;
      expect(await code([{ op: "replace", path: "/courses/99/name", value: "x" }])).toBe(404);
      expect(await code([{ op: "replace", path: "/courses/1/nope", value: "x" }])).toBe(400);
      expect(await code([{ op: "add", path: "/courses/1", value: { name: "again" } }])).toBe(409);
      expect(await code([{ op: "remove", path: "/courses/2" }])).toBe(404); // the other wedding's: not in this document
      // RFC 6902: replace and remove need their target there (the JSON file's applyOps too, #4)
      expect(await code([{ op: "remove", path: "/courses/99" }])).toBe(404);
      expect(await code([{ op: "replace", path: "/courses/99", value: { name: "x" } }])).toBe(404);
    });

    test("a path's id is the number its digits name, however many there are: /courses/0001000000000000 is /courses/1000000000000, as /courses/007 is /courses/7", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1"]);
      const { ops } = await write(b.process, "fo-board:1", [
        { op: "add", path: "/courses/007", value: { name: "Fish" } },
        { op: "add", path: "/courses/0001000000000000", value: { name: "Cheese" } },
      ]);
      expect(ops).toEqual([
        { op: "add", path: "/courses/7", value: course(7, "Fish") },
        { op: "add", path: "/courses/1000000000000", value: course(1000000000000, "Cheese") },
      ]);
      await assertCopiesHold(b, copies);
    });

    test("an id past 2^53 - 1 is refused as a mistake (400), in every op: a number would not hold it; 2^53 - 1 is kept", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1"]);
      const code = async (ops: unknown[]) => (await b.process.call("delta", { doc: "fo-board:1", ops })).error?.code;
      expect(await code([{ op: "add", path: "/courses/9007199254740993", value: { name: "Fish" } }])).toBe(400);
      expect(await code([{ op: "add", path: "/courses/12345678901234567890", value: { name: "Fish" } }])).toBe(400); // past a bigint, too
      expect(await code([{ op: "replace", path: "/courses/9007199254740993/name", value: "Cod" }])).toBe(400);
      expect(await code([{ op: "replace", path: "/courses/9007199254740993", value: { name: "Cod" } }])).toBe(400);
      expect(await code([{ op: "remove", path: "/courses/9007199254740993" }])).toBe(400);
      const { ops } = await write(b.process, "fo-board:1", [{ op: "add", path: "/courses/9007199254740991", value: { name: "Fish" } }]);
      expect(ops).toEqual([{ op: "add", path: "/courses/9007199254740991", value: course(9007199254740991, "Fish") }]);
      await assertCopiesHold(b, copies);
    });

    test("a parent key is never null, nor anything but an id: refused as a mistake (400) in every form of replace", async () => {
      const b = backend();
      await openAll(b.process, ["fo-board:1", "fo-household:1"]);
      const code = async (doc: string, ops: unknown[]) => (await b.process.call("delta", { doc, ops })).error?.code;
      expect(await code("fo-board:1", [{ op: "replace", path: "/drinks/1/courses_id", value: null }])).toBe(400);
      expect(await code("fo-board:1", [{ op: "replace", path: "/households/1", value: { weddings_id: null } }])).toBe(400);
      expect(await code("fo-household:1", [{ op: "replace", path: "/households/weddings_id", value: null }])).toBe(400);
      expect(await code("fo-household:1", [{ op: "replace", path: "/households", value: { weddings_id: null } }])).toBe(400);
      expect(await code("fo-board:1", [{ op: "replace", path: "/drinks/1/courses_id", value: 1.5 }])).toBe(400);
      expect(await code("fo-household:1", [{ op: "replace", path: "/households/weddings_id", value: true }])).toBe(400);
    });

    test("a row keeps its id: one in a replace's value is the path's, as in an add's, and id is not a field (400)", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-household:1"]);
      const code = async (doc: string, ops: unknown[]) => (await b.process.call("delta", { doc, ops })).error?.code;
      expect(await code("fo-board:1", [{ op: "replace", path: "/households/1/id", value: 9 }])).toBe(400);
      expect(await code("fo-household:1", [{ op: "replace", path: "/households/id", value: 9 }])).toBe(400);
      const row = await write(b.process, "fo-board:1", [{ op: "replace", path: "/households/1", value: { id: 9, email: "q@x" } }]);
      expect(row.ops).toEqual([{ op: "replace", path: "/households/1", value: household(1, "q@x") }]);
      const root = await write(b.process, "fo-household:1", [{ op: "replace", path: "/households", value: { id: 9, email: "r@x" } }]);
      expect(root.ops).toEqual([{ op: "replace", path: "/households", value: household(1, "r@x") }]);
      expect((await b.process.call("open", { doc: "fo-household:9" })).error?.code).toBe(404);
      await assertCopiesHold(b, copies);
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

  describe("a write's ops land in the order sent", () => {
    test("a drink changed and then removed in one write is told so, in order, to every document that held it; undone, it comes back as it was", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-menu:1", "fo-course:1"]);
      const { ops, inverse } = await write(b.process, "fo-board:1", [
        { op: "replace", path: "/drinks/1/name", value: "Port" },
        { op: "remove", path: "/drinks/1" },
      ], { cursor: "s1" });
      const changed = { op: "replace", path: "/drinks/1", value: drink(1, 1, "Port") };
      const removed = { op: "remove", path: "/drinks/1" };
      const back = { op: "add", path: "/drinks/1", value: drink(1, 1, "Sherry") };
      expect(ops).toEqual([changed, removed]);
      expect(inverse).toEqual([back, { op: "replace", path: "/drinks/1", value: drink(1, 1, "Sherry") }]);
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect({ ops: undone.result.ops, conflict: undone.result.conflict }).toEqual({ ops: [back], conflict: undefined });
      for (const doc of ["fo-board:1", "fo-menu:1", "fo-course:1"]) await expectTold(b, doc, [[changed, removed], [back]]);
      await assertCopiesHold(b, copies);
    });

    test("the wedding renamed, a course added and named twice, in one write: each op lands and is told where it was sent, and the undo takes the course and gives the name back", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-menu:1", "fo-title:1"]);
      const { ops, inverse } = await write(b.process, "fo-board:1", [
        { op: "replace", path: "/weddings/name", value: "our day" },
        { op: "add", path: "/courses/-", value: { name: "Fish" } },
        { op: "replace", path: "/courses/3/name", value: "Cod" },
        { op: "replace", path: "/courses/3", value: { name: "Hake" } },
      ], { cursor: "s1" });
      const renamed = { op: "replace", path: "/weddings", value: { id: 1, name: "our day" } };
      expect(ops).toEqual([
        renamed,
        { op: "add", path: "/courses/3", value: course(3, "Fish") },
        { op: "replace", path: "/courses/3", value: course(3, "Cod") },
        { op: "replace", path: "/courses/3", value: course(3, "Hake") },
      ]);
      expect(inverse).toEqual([
        { op: "replace", path: "/courses/3", value: null },
        { op: "replace", path: "/courses/3", value: null },
        { op: "remove", path: "/courses/3" },
        { op: "replace", path: "/weddings", value: { id: 1, name: "ours" } },
      ]);
      const undone = await b.process.call("undo", { cursor: "s1" });
      const taken = [{ op: "remove", path: "/courses/3" }, { op: "replace", path: "/weddings", value: { name: "ours" } }];
      expect({ ops: undone.result.ops.map((o: any) => o.op === "remove" ? o : { ...o, value: { name: o.value.name } }), conflict: undone.result.conflict }).toEqual({ ops: taken, conflict: undefined });
      await expectTold(b, "fo-menu:1", [ops, undone.result.ops]);
      await expectTold(b, "fo-title:1", [[renamed], [{ op: "replace", path: "/weddings", value: { id: 1, name: "ours" } }]]);
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

    test("removed through its own document, a course goes with the drinks it holds: the board and the menu are told they left, the document its root is null; it is then not found, as any missing root", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-course:1", "fo-board:1", "fo-menu:1", "fo-all-courses:"]);
      const code = async (ops: unknown[]) => (await b.process.call("delta", { doc: "fo-course:1", ops })).error?.code;
      expect(await code([{ op: "remove", path: "/courses/2" }])).toBe(404); // another course: not this document's
      const { ops } = await write(b.process, "fo-course:1", [{ op: "remove", path: "/courses/1" }]);
      expect(ops).toEqual([{ op: "remove", path: "/courses/1" }, { op: "remove", path: "/drinks/1" }]);
      await expectTold(b, "fo-course:1", [[{ op: "replace", path: "/courses", value: null }, { op: "remove", path: "/drinks/1" }]]);
      await expectTold(b, "fo-board:1", [ops]);
      await expectTold(b, "fo-menu:1", [ops]);
      await expectTold(b, "fo-all-courses:", [[{ op: "remove", path: "/courses/1" }]]);
      expect((await b.process.call("open", { doc: "fo-course:1" })).error?.code).toBe(404);
      expect(await code([{ op: "replace", path: "/courses/name", value: "Broth" }])).toBe(404);
      await assertCopiesHold(b, copies);
    });

    test("a household's root written and removed in one write through its own document is told as written, the field first; removed first, the field is not found", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-household:1", "fo-household:2", "fo-board:1"]);
      expect((await b.process.call("delta", { doc: "fo-household:2", ops: [
        { op: "remove", path: "/households/2" },
        { op: "replace", path: "/households/email", value: "late@x" },
      ] })).error?.code).toBe(404);
      const { ops } = await write(b.process, "fo-household:1", [
        { op: "replace", path: "/households/email", value: "gone@x" },
        { op: "remove", path: "/households/1" },
      ]);
      expect(ops).toEqual([{ op: "replace", path: "/households", value: household(1, "gone@x") }, { op: "remove", path: "/households/1" }]);
      await expectTold(b, "fo-household:1", [[{ op: "replace", path: "/households", value: household(1, "gone@x") }, { op: "replace", path: "/households", value: null }]]);
      await expectTold(b, "fo-board:1", [[{ op: "replace", path: "/households/1", value: household(1, "gone@x") }, { op: "remove", path: "/households/1" }]]);
      await expectSilent(b, "fo-household:2");
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

    test("a course named by an id of 16 digits (a client minting Date.now() * 1000) is told, undone and redone as the number it names", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-menu:1"]);
      const id = 1000000000000000;
      const made = await write(b.process, "fo-board:1", [{ op: "add", path: `/courses/${id}`, value: { name: "Fish" } }], { cursor: "s1" });
      expect(made.ops).toEqual([{ op: "add", path: `/courses/${id}`, value: course(id, "Fish") }]);
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect({ ops: undone.result.ops, conflict: undone.result.conflict }).toEqual({ ops: [{ op: "remove", path: `/courses/${id}` }], conflict: undefined });
      const redone = await b.process.call("redo", { cursor: "s1" });
      expect({ ops: redone.result.ops, conflict: redone.result.conflict }).toEqual({ ops: made.ops, conflict: undefined });
      await expectTold(b, "fo-menu:1", [made.ops, undone.result.ops, made.ops]);
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

    test("a course and its drinks added in one write, undone, are redone course first -- and undone again", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-menu:1"]);
      const made = await write(b.process, "fo-board:1", [
        { op: "add", path: "/courses/10", value: { name: "Fish" } },
        { op: "add", path: "/drinks/10", value: { courses_id: 10, name: "Chablis" } },
        { op: "add", path: "/drinks/11", value: { courses_id: 10, name: "Muscadet" } },
      ], { cursor: "s1" });
      const taken = [{ op: "remove", path: "/drinks/11" }, { op: "remove", path: "/drinks/10" }, { op: "remove", path: "/courses/10" }];
      const walked = async (way: string) => {
        const { result } = await b.process.call(way, { cursor: "s1" });
        return { ops: result.ops, conflict: result.conflict };
      };
      expect(await walked("undo")).toEqual({ ops: taken, conflict: undefined });
      expect(await walked("redo")).toEqual({ ops: made.ops, conflict: undefined });
      expect(await walked("undo")).toEqual({ ops: taken, conflict: undefined });
      await expectTold(b, "fo-menu:1", [made.ops, taken, made.ops, taken]);
      await assertCopiesHold(b, copies);
    });

    test("a course removed with its drink, undone and redone, is undone again course first", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-menu:1"]);
      const removed = await write(b.process, "fo-board:1", [{ op: "remove", path: "/courses/1" }], { cursor: "s1" });
      const back = [{ op: "add", path: "/courses/1", value: course(1, "Soup") }, { op: "add", path: "/drinks/1", value: drink(1, 1, "Sherry") }];
      const walked = async (way: string) => {
        const { result } = await b.process.call(way, { cursor: "s1" });
        return { ops: result.ops, conflict: result.conflict };
      };
      expect(await walked("undo")).toEqual({ ops: back, conflict: undefined });
      expect(await walked("redo")).toEqual({ ops: [{ op: "remove", path: "/drinks/1" }, { op: "remove", path: "/courses/1" }], conflict: undefined });
      expect(await walked("undo")).toEqual({ ops: back, conflict: undefined });
      await expectTold(b, "fo-menu:1", [removed.ops, back, [{ op: "remove", path: "/drinks/1" }, { op: "remove", path: "/courses/1" }], back]);
      await assertCopiesHold(b, copies);
    });

    test("a course removed through its own document is undone course first, then its drink, redone drink first, and undone again -- the document read again each time", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-course:1", "fo-board:1", "fo-menu:1"]);
      const removed = await write(b.process, "fo-course:1", [{ op: "remove", path: "/courses/1" }], { cursor: "s1" });
      const back = [{ op: "add", path: "/courses/1", value: course(1, "Soup") }, { op: "add", path: "/drinks/1", value: drink(1, 1, "Sherry") }];
      const taken = [{ op: "remove", path: "/drinks/1" }, { op: "remove", path: "/courses/1" }];
      expect(removed.inverse).toEqual(back);
      const walked = async (way: string) => {
        const { result } = await b.process.call(way, { cursor: "s1" });
        return { ops: result.ops, conflict: result.conflict };
      };
      const opened = async () => content((await b.process.call("open", { doc: "fo-course:1" })).result);
      expect(await walked("undo")).toEqual({ ops: back, conflict: undefined });
      expect(await opened()).toEqual({ courses: course(1, "Soup"), drinks: { "1": drink(1, 1, "Sherry") } });
      expect(await walked("redo")).toEqual({ ops: taken, conflict: undefined });
      expect(await walked("undo")).toEqual({ ops: back, conflict: undefined });
      const gone = { op: "replace", path: "/courses", value: null };
      const here = [{ op: "replace", path: "/courses", value: course(1, "Soup") }, back[1]];
      await expectTold(b, "fo-course:1", [[gone, { op: "remove", path: "/drinks/1" }], here, [{ op: "remove", path: "/drinks/1" }, gone], here]);
      await expectTold(b, "fo-menu:1", [removed.ops, back, taken, back]);
      await assertCopiesHold(b, copies);
    });

    test("a household removed through its own document is undone: the board and the document hear it come back", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-household:1", "fo-board:1"]);
      const removed = await write(b.process, "fo-household:1", [{ op: "remove", path: "/households/1" }], { cursor: "s1" });
      expect(removed.ops).toEqual([{ op: "remove", path: "/households/1" }]);
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect({ ops: undone.result.ops, conflict: undone.result.conflict }).toEqual({ ops: [{ op: "add", path: "/households/1", value: household(1, "a@x") }], conflict: undefined });
      await expectTold(b, "fo-household:1", [[{ op: "replace", path: "/households", value: null }], [{ op: "replace", path: "/households", value: household(1, "a@x") }]]);
      await expectTold(b, "fo-board:1", [removed.ops, undone.result.ops]);
      await assertCopiesHold(b, copies);
    });

    test("a value kept as its column's type is told and undone as kept: a scope's \"10\" in a text column stays \"10\"", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-tags-labelled:10", "fo-board:1"]);
      const result = await write(b.process, "fo-tags-labelled:10", [{ op: "add", path: "/tags/-", value: {} }], { cursor: "s1" });
      expect(result.ops).toEqual([{ op: "add", path: "/tags/2", value: { id: 2, label: "10" } }]);
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect({ ops: undone.result.ops, conflict: undone.result.conflict }).toEqual({ ops: [{ op: "remove", path: "/tags/2" }], conflict: undefined });
      await assertCopiesHold(b, copies);
    });

    test("a value kept as its column's type is told and undone as kept: a text scope's \"007\" stays \"007\"", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-tags-labelled:007", "fo-board:1"]);
      const result = await write(b.process, "fo-tags-labelled:007", [{ op: "add", path: "/tags/-", value: {} }], { cursor: "s1" });
      expect(result.ops).toEqual([{ op: "add", path: "/tags/2", value: { id: 2, label: "007" } }]);
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect({ ops: undone.result.ops, conflict: undone.result.conflict }).toEqual({ ops: [{ op: "remove", path: "/tags/2" }], conflict: undefined });
      await assertCopiesHold(b, copies);
    });

    test("a boolean scope takes the name as Postgres takes a boolean: an unambiguous prefix of true/false, yes/no, on/off, any case; anything else is a 400", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-seating:1"]);
      const add = [{ op: "add", path: "/seats/-", value: { weddings_id: 1, table_no: 4 } }];
      const told: unknown[][] = [];
      let id = 1;
      // what the add stores, as the seating plan reads it (what a list reads by such a name has its own cases)
      for (const [name, kept] of [["fa", false], ["of", false], ["n", false], ["tr", true], ["on", true], ["YES", true]] as const) {
        await b.process.call("open", { doc: `fo-seats-kept:${name}` });
        const { ops } = await write(b.process, `fo-seats-kept:${name}`, add);
        id += 1;
        expect({ name, ops }).toEqual({ name, ops: [{ op: "add", path: `/seats/${id}`, value: seat(id, 4, kept) }] });
        told.push(ops);
      }
      for (const name of ["maybe", "o", "onx"]) {
        await b.process.call("open", { doc: `fo-seats-kept:${name}` }); // refused here already (400): the write is asked on its own
        expect({ name, code: (await b.process.call("delta", { doc: `fo-seats-kept:${name}`, ops: add })).error?.code }).toEqual({ name, code: 400 });
      }
      await expectTold(b, "fo-seating:1", told);
      await assertCopiesHold(b, copies);
    });

    test("a value kept as its column's type is told and undone as kept: a boolean scope's \"0\" is false", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-seats-kept:0", "fo-seats-kept:1", "fo-seating:1"]);
      const result = await write(b.process, "fo-seats-kept:0", [{ op: "add", path: "/seats/-", value: { weddings_id: 1, table_no: 4 } }], { cursor: "s1" });
      expect(result.ops).toEqual([{ op: "add", path: "/seats/2", value: seat(2, 4, false) }]);
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect({ ops: undone.result.ops, conflict: undone.result.conflict }).toEqual({ ops: [{ op: "remove", path: "/seats/2" }], conflict: undefined });
      await expectTold(b, "fo-seats-kept:0", [result.ops, [{ op: "remove", path: "/seats/2" }]]);
      await expectSilent(b, "fo-seats-kept:1");
      await assertCopiesHold(b, copies);
    });

    test("a value kept as its column's type is told and undone as kept: a json scope's \"5\" is the number 5, as the document's condition reads it", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-seats-wished:5", "fo-seating:1"]);
      const result = await write(b.process, "fo-seats-wished:5", [{ op: "add", path: "/seats/-", value: { weddings_id: 1, table_no: 4, kept: false } }], { cursor: "s1" });
      expect(result.ops).toEqual([{ op: "add", path: "/seats/2", value: seat(2, 4, false, 5) }]);
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect({ ops: undone.result.ops, conflict: undone.result.conflict }).toEqual({ ops: [{ op: "remove", path: "/seats/2" }], conflict: undefined });
      await expectTold(b, "fo-seats-wished:5", [result.ops, [{ op: "remove", path: "/seats/2" }]]);
      await assertCopiesHold(b, copies);
    });

    test("a seat added through a boolean list named off is read back by it, told to every list its value meets -- off, no, 0, false and up to off -- and not to yes; undone and redone without a conflict", async () => {
      const b = backend();
      const lists = ["fo-seats-kept:off", "fo-seats-kept:no", "fo-seats-kept:0", "fo-seats-kept:false", "fo-seats-upto:off"];
      const copies = await openAll(b.process, [...lists, "fo-seats-kept:yes", "fo-seating:1"]);
      const made = await write(b.process, "fo-seats-kept:off", [{ op: "add", path: "/seats/-", value: { weddings_id: 1, table_no: 4 } }], { cursor: "s1" });
      expect(made.ops).toEqual([{ op: "add", path: "/seats/2", value: seat(2, 4, false) }]);
      expect(Object.keys((await b.process.call("open", { doc: "fo-seats-kept:off" })).result.seats)).toEqual(["2"]);
      const walked = async (way: string) => {
        const { result } = await b.process.call(way, { cursor: "s1" });
        return { ops: result.ops, conflict: result.conflict };
      };
      const taken = [{ op: "remove", path: "/seats/2" }];
      expect(await walked("undo")).toEqual({ ops: taken, conflict: undefined });
      expect(await walked("redo")).toEqual({ ops: made.ops, conflict: undefined });
      for (const doc of lists) await expectTold(b, doc, [made.ops, taken, made.ops]);
      await expectSilent(b, "fo-seats-kept:yes");
      await assertCopiesHold(b, copies);
    });

    test("a value kept as its column's type is told and undone as kept: a json string that reads as a number stays a string", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-seating:1"]);
      const result = await write(b.process, "fo-seating:1", [{ op: "add", path: "/seats/-", value: { table_no: 5, kept: true, wishes: "123" } }], { cursor: "s1" });
      expect(result.ops).toEqual([{ op: "add", path: "/seats/2", value: seat(2, 5, true, "123") }]);
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect({ ops: undone.result.ops, conflict: undone.result.conflict }).toEqual({ ops: [{ op: "remove", path: "/seats/2" }], conflict: undefined });
      await assertCopiesHold(b, copies);
    });

    test("a value kept as its column's type is told and undone as kept: a single document's parent key written as \"2\" is the number 2", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-household:1", "fo-board:1", "fo-board:2"]);
      const result = await write(b.process, "fo-household:1", [{ op: "replace", path: "/households/weddings_id", value: "2" }], { cursor: "s1" });
      expect(result.ops).toEqual([{ op: "replace", path: "/households", value: household(1, "a@x", 2) }]);
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect({ ops: undone.result.ops, conflict: undone.result.conflict }).toEqual({ ops: [{ op: "replace", path: "/households", value: household(1, "a@x") }], conflict: undefined });
      await assertCopiesHold(b, copies);
    });

    test("a value kept as its column's type is told and undone as kept: a parent key written as \"10\" is the number 10", async () => {
      const b = backend();
      await b.process.call("open", { doc: "fo-board:1" });
      await write(b.process, "fo-board:1", [{ op: "add", path: "/courses/10", value: { name: "Fish" } }]);
      const copies = await openAll(b.process, ["fo-board:1", "fo-course:1", "fo-course:10"]);
      const result = await write(b.process, "fo-board:1", [{ op: "replace", path: "/drinks/1/courses_id", value: "10" }], { cursor: "s1" });
      expect(result.ops).toEqual([{ op: "replace", path: "/drinks/1", value: drink(1, 10, "Sherry") }]);
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect({ ops: undone.result.ops, conflict: undone.result.conflict }).toEqual({ ops: [{ op: "replace", path: "/drinks/1", value: drink(1, 1, "Sherry") }], conflict: undefined });
      await assertCopiesHold(b, copies);
    });
  });

  describe("a custom document that watches the rows", () => {
    test("a household's email written through its own document, as its root, leaves the one inbox and joins the other; undone, it goes back", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-household:1", "fo-inbox:a@x", "fo-inbox:new@x"]);
      await write(b.process, "fo-household:1", [{ op: "replace", path: "/households/email", value: "new@x" }], { cursor: "s1" });
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect(undone.result.conflict).toBeUndefined();
      await expectTold(b, "fo-inbox:a@x", [
        [{ op: "remove", path: "/households/1" }],
        [{ op: "add", path: "/households/1", value: household(1, "a@x") }],
      ]);
      await expectTold(b, "fo-inbox:new@x", [
        [{ op: "add", path: "/households/1", value: household(1, "new@x") }],
        [{ op: "remove", path: "/households/1" }],
      ]);
      await assertCopiesHold(b, copies);
    });

    test("told through two documents, a write is heard once: the household's own and the board's, one add to the inbox it joins", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-household:1", "fo-board:1", "fo-inbox:a@x", "fo-inbox:new@x"]);
      await write(b.process, "fo-household:1", [{ op: "replace", path: "/households/email", value: "new@x" }]);
      await expectTold(b, "fo-inbox:a@x", [[{ op: "remove", path: "/households/1" }]]);
      await expectTold(b, "fo-inbox:new@x", [[{ op: "add", path: "/households/1", value: household(1, "new@x") }]]);
      await assertCopiesHold(b, copies);
    });

    test("a household moved to the other wedding through its own document, both boards open, still matches: the inbox is told one replace and keeps it", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-household:1", "fo-board:1", "fo-board:2", "fo-inbox:a@x"]);
      await write(b.process, "fo-household:1", [{ op: "replace", path: "/households/weddings_id", value: 2 }]);
      await expectTold(b, "fo-board:1", [[{ op: "remove", path: "/households/1" }]]);
      await expectTold(b, "fo-inbox:a@x", [[{ op: "replace", path: "/households/1", value: household(1, "a@x", 2) }]]);
      await assertCopiesHold(b, copies);
    });

    test("a household that leaves the only document open over it, still matching, is not taken for removed: the inbox is told a replace and keeps it", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-inbox:a@x"]);
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/households/1/weddings_id", value: 2 }]);
      await expectTold(b, "fo-board:1", [[{ op: "remove", path: "/households/1" }]]);
      await expectTold(b, "fo-inbox:a@x", [[{ op: "replace", path: "/households/1", value: household(1, "a@x", 2) }]]);
      await assertCopiesHold(b, copies);
    });

    test("a household removed through the board, its own document open too, leaves the inbox once", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-household:1", "fo-inbox:a@x"]);
      await write(b.process, "fo-board:1", [{ op: "remove", path: "/households/1" }]);
      await expectTold(b, "fo-household:1", [[{ op: "replace", path: "/households", value: null }]]);
      await expectTold(b, "fo-inbox:a@x", [[{ op: "remove", path: "/households/1" }]]);
      await assertCopiesHold(b, copies);
    });
  });

  describe("a custom document whose name starts as a list's", () => {
    test("fo-seats-at:open:all is not taken for the list fo-seats-at: named \"open\": seats written beside it are told as ever, and it hears the one that is not kept", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-seats-at:open:all", "fo-seating:1", "fo-seats-at:3", "fo-seats-at:5"]);
      copies.delete("fo-seats-at:open:all"); // its first read is the backend's own query, not a document's
      const moved = await write(b.process, "fo-seating:1", [{ op: "replace", path: "/seats/1/table_no", value: 5 }]);
      const added = await write(b.process, "fo-seats-at:5", [{ op: "add", path: "/seats/-", value: { weddings_id: 1, kept: false } }]);
      expect(added.ops).toEqual([{ op: "add", path: "/seats/2", value: seat(2, 5, false) }]);
      await expectTold(b, "fo-seating:1", [moved.ops, added.ops]);
      await expectTold(b, "fo-seats-at:3", [[{ op: "remove", path: "/seats/1" }]]);
      await expectTold(b, "fo-seats-at:5", [[{ op: "add", path: "/seats/1", value: seat(1, 5, true, { veg: true }) }], added.ops]);
      await expectTold(b, "fo-seats-at:open:all", [added.ops]);
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

    test("a household moved through its own document, its parent key written as a root field, leaves this board and arrives on that one", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-household:1", "fo-board:1", "fo-board:2"]);
      await write(b.process, "fo-household:1", [{ op: "replace", path: "/households/weddings_id", value: 2 }]);
      await expectTold(b, "fo-household:1", [[{ op: "replace", path: "/households", value: household(1, "a@x", 2) }]]);
      await expectTold(b, "fo-board:1", [[{ op: "remove", path: "/households/1" }]]);
      await expectTold(b, "fo-board:2", [[{ op: "add", path: "/households/1", value: household(1, "a@x", 2) }]]);
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
