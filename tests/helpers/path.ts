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
 * column types: an integer, a boolean and a json column. A household's `t` is
 * named as the write SQL once named its row (todo #58): a column may take any name.
 */
export const pathSchema = defineSchema({
  weddings: { table: "fo_weddings", columns: { name: "text" }, temporal: false },
  households: { table: "fo_households", parent: "weddings", columns: { email: "text", t: "text?" }, temporal: false },
  courses: { table: "fo_courses", parent: "weddings", columns: { name: "text" }, temporal: false },
  drinks: { table: "fo_drinks", parent: "courses", columns: { name: "text" }, temporal: false },
  tags: { table: "fo_tags", columns: { label: "text" }, temporal: false },
  notes: { table: "fo_notes", parent: "weddings", columns: { text: "text" }, temporal: true },
  seats: { table: "fo_seats", parent: "weddings", columns: { table_no: "integer", kept: "boolean", wishes: "json?" }, temporal: false },
  // the time slots of a wedding: the scopes on a real, a parent key and a time
  slots: { table: "fo_slots", parent: "weddings", columns: { price: "real?", starts: "timestamptz?" }, temporal: false },
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
  // list mode with an include: every course, and every drink
  defineDoc("fo-catalog:", { root: "courses", include: ["drinks"] }),
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
  // list mode by a real's range: the slots that cost at most the name
  defineDoc("fo-slots-upto:", { root: "slots", include: [], scope: { price: "<=:max" } }),
  // list mode by a parent key: a wedding's slots, and those of the weddings up to one
  defineDoc("fo-slots-of:", { root: "slots", include: [], scope: { weddings_id: ":wedding" } }),
  defineDoc("fo-slots-under:", { root: "slots", include: [], scope: { weddings_id: "<=:most" } }),
  // list mode by a time: the slots that start by a date, and those that start on its midnight
  defineDoc("fo-slots-by:", { root: "slots", include: [], scope: { starts: "<=:end" } }),
  defineDoc("fo-slots-on:", { root: "slots", include: [], scope: { starts: ":on" } }),
  // a temporal row as the root: one note, and every note
  defineDoc("fo-note:", { root: "notes", include: [] }),
  defineDoc("fo-all-notes:", { root: "notes", include: [] }),
  // the wedding's drinks, without the courses they hang from: held through them all the same
  defineDoc("fo-drinks:", { root: "weddings", include: ["drinks"] }),
  // one course and the households, which hang from the wedding: a chain that meets no course, so none of them
  defineDoc("fo-course-guests:", { root: "courses", include: ["households"] }),
  // a wedding being planned: there before its row is, which its first write makes (implied)
  defineDoc("fo-plan:", { root: "weddings", include: ["courses", "drinks"], implied: true }),
  // single mode with a second condition: one household by its id and its email, one seat by its id and its table
  defineDoc("fo-guest:", { root: "households", include: [], scope: { id: ":id", email: ":email" } }),
  defineDoc("fo-seat-of:", { root: "seats", include: [], scope: { id: ":id", table_no: ":table" } }),
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

/**
 * A recompute custom document beside them (todo #35): the wedding's menu card,
 * its name and its courses' names in order -- a shape no per-row predicate
 * gives -- read whole on open and again on every write to what it watches,
 * told as a root replace. Only the read differs by backend.
 */
const menuCardDoc = <R>(recompute: R) => ({
  prefix: "fo-menu-card:",
  watch: ["weddings", "courses"],
  parse: (id: string) => Number(id),
  recompute,
});
const weddingsTable = pathSchema.tables.weddings!.name;
const coursesTable = pathSchema.tables.courses!.name;
export const sqliteMenuCard = menuCardDoc((db: any, id: number) => {
  const wedding = db.query(`SELECT name FROM ${weddingsTable} WHERE id = ?`).get(id) as { name: string } | null;
  if (!wedding) return null;
  return { wedding: wedding.name, courses: (db.query(`SELECT name FROM ${coursesTable} WHERE weddings_id = ? ORDER BY id`).all(id) as { name: string }[]).map((c) => c.name) };
});
export const postgresMenuCard = menuCardDoc(async (pool: any, id: number) => (await pool.query(
  `SELECT jsonb_build_object('wedding', w.name, 'courses', COALESCE((SELECT jsonb_agg(c.name ORDER BY c.id) FROM ${coursesTable} c WHERE c.weddings_id = w.id), '[]'::jsonb)) AS doc FROM ${weddingsTable} w WHERE w.id = $1`,
  [id])).rows[0]?.doc ?? null);

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
export const household = (id: number, email: string, wedding = 1, t: string | null = null) => ({ id, weddings_id: wedding, email, t });
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

    test("a number's name is read by one grammar, a decimal a double holds: a real's 1.5, .5, 1e0 and 3. are numbers; Infinity, NaN, inf, 0x10, 1e400 and 1e-400 are refused (400), opened or written through, and an integer's 1_000, 0x10 and 2^53 too", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-slots-upto:", "fo-slots-upto:1.5", "fo-slots-upto:1e0"]);
      await write(b.process, "fo-slots-upto:", [
        { op: "add", path: "/slots/-", value: { weddings_id: 1, price: 1.5 } },
        { op: "add", path: "/slots/-", value: { weddings_id: 1, price: 0.25 } },
        { op: "add", path: "/slots/-", value: { weddings_id: 2, price: 3 } },
      ]);
      await assertCopiesHold(b, copies);
      const slots = async (doc: string) => {
        const res = await b.process.call("open", { doc });
        return { doc, slots: res.error ?? Object.keys(res.result.slots).map(Number) };
      };
      for (const [name, ids] of [["1.5", [1, 2]], [".5", [2]], ["1e0", [2]], ["3.", [1, 2, 3]], ["+2E-1", []], ["-1", []]] as const) {
        expect(await slots(`fo-slots-upto:${name}`)).toEqual({ doc: `fo-slots-upto:${name}`, slots: [...ids] });
      }
      const add = [{ op: "add", path: "/slots/-", value: { weddings_id: 1, price: 1 } }];
      const refused = [
        ...["Infinity", "-Infinity", "NaN", "inf", "0x10", "1e400", "1e-400"].map((name) => `fo-slots-upto:${name}`),
        ...["1_000", "0x10", "9007199254740992"].map((name) => `fo-seats-at:${name}`),
      ];
      for (const doc of refused) {
        const open = (await b.process.call("open", { doc })).error?.code;
        const written = (await b.process.call("delta", { doc, ops: add })).error?.code;
        expect({ doc, open, written }).toEqual({ doc, open: 400, written: 400 });
      }
    });

    test("a parent key's name is an id: a whole number (+1, 01 and ' 1' are 1); text that is no number is no row's, where every id is a number, and sorts after every number, as SQLite orders an id kept as text; a number not whole, or past 2^53 - 1, is refused (400)", async () => {
      const b = backend();
      await openAll(b.process, ["fo-slots-upto:"]);
      await write(b.process, "fo-slots-upto:", [
        { op: "add", path: "/slots/-", value: { weddings_id: 1, price: 1 } },
        { op: "add", path: "/slots/-", value: { weddings_id: 2, price: 2 } },
      ]);
      const names = ["fo-slots-of:1", "fo-slots-of:+1", "fo-slots-of:01", "fo-slots-of: 1", "fo-slots-of:abc", "fo-slots-under:1", "fo-slots-under:abc", "fo-slots-under:-1"];
      const copies = await openAll(b.process, names);
      expect(names.map((doc) => ({ doc, slots: Object.keys(copies.get(doc).slots).map(Number) }))).toEqual([
        { doc: "fo-slots-of:1", slots: [1] },
        { doc: "fo-slots-of:+1", slots: [1] },
        { doc: "fo-slots-of:01", slots: [1] },
        { doc: "fo-slots-of: 1", slots: [1] },
        { doc: "fo-slots-of:abc", slots: [] },
        { doc: "fo-slots-under:1", slots: [1] },
        { doc: "fo-slots-under:abc", slots: [1, 2] },
        { doc: "fo-slots-under:-1", slots: [] },
      ]);
      await write(b.process, "fo-slots-upto:", [{ op: "replace", path: "/slots/2/weddings_id", value: 1 }]);
      await assertCopiesHold(b, copies);
      const add = [{ op: "add", path: "/slots/-", value: { weddings_id: 1, price: 1 } }];
      for (const doc of ["fo-slots-of:1.5", "fo-slots-of:1e0", "fo-slots-of:9007199254740992", "fo-slots-under:1.5"]) {
        const open = (await b.process.call("open", { doc })).error?.code;
        const written = (await b.process.call("delta", { doc, ops: add })).error?.code;
        expect({ doc, open, written }).toEqual({ doc, open: 400, written: 400 });
      }
    });

    test("a time's name is a date, YYYY-MM-DD, the instant midnight UTC begins it, and a stored time is compared as the instant it names, whatever its form; anything else is refused (400): garbage, 2026-02-30, 20260101, today", async () => {
      const b = backend();
      await openAll(b.process, ["fo-slots-upto:"]);
      const at = (starts: string | null) => ({ op: "add", path: "/slots/-", value: { weddings_id: 1, starts } });
      await write(b.process, "fo-slots-upto:", [
        at("2026-01-01T10:00:00.000Z"), // 1: after midnight
        at("2025-12-31T23:30:00-02:00"), // 2: 01:30 UTC, after midnight, though its text sorts before the date
        at("2026-01-01T00:00:00.000Z"), // 3: midnight, though its text is not the date's
        at("2025-12-31T23:59:59.999Z"), // 4: before
        at("2026-01-01T01:00:00+01:00"), // 5: midnight
        at(null), // 6: no time
        at("2025-12-31T10:00:00-14:00"), // 7: midnight, its text a day before -- as far as a zone takes it
        at("2026-01-01T13:59:59+14:00"), // 8: before midnight, its text on the day
      ]);
      const names = ["fo-slots-by:2026-01-01", "fo-slots-by: 2026-01-01", "fo-slots-by:2025-12-31", "fo-slots-by:2026-01-02", "fo-slots-on:2026-01-01", "fo-slots-on:2025-12-31"];
      const copies = await openAll(b.process, names);
      expect(names.map((doc) => ({ doc, slots: Object.keys(copies.get(doc).slots).map(Number) }))).toEqual([
        { doc: "fo-slots-by:2026-01-01", slots: [3, 4, 5, 7, 8] },
        { doc: "fo-slots-by: 2026-01-01", slots: [3, 4, 5, 7, 8] },
        { doc: "fo-slots-by:2025-12-31", slots: [] },
        { doc: "fo-slots-by:2026-01-02", slots: [1, 2, 3, 4, 5, 7, 8] },
        { doc: "fo-slots-on:2026-01-01", slots: [3, 5, 7] },
        { doc: "fo-slots-on:2025-12-31", slots: [] },
      ]);
      // an add through the name is given its time, and read back by it; rows move across midnight
      const { ops } = await write(b.process, "fo-slots-on:2026-01-01", [{ op: "add", path: "/slots/-", value: { weddings_id: 1 } }]);
      expect(ops.map((o: any) => o.path)).toEqual(["/slots/9"]);
      await write(b.process, "fo-slots-upto:", [
        { op: "replace", path: "/slots/1/starts", value: "2025-06-01T00:00:00Z" },
        { op: "replace", path: "/slots/3/starts", value: "2026-01-01T00:00:00.001Z" },
      ]);
      await assertCopiesHold(b, copies);
      expect(Object.keys((await b.process.call("open", { doc: "fo-slots-on:2026-01-01" })).result.slots).map(Number)).toEqual([5, 7, 9]);
      const add = [{ op: "add", path: "/slots/-", value: { weddings_id: 1, starts: "2026-01-01T00:00:00Z" } }];
      const refused = ["garbage", "2026-01-01T12:00:00Z", "2026-02-30", "2026-13-01", "0000-01-01", "20260101", "2026-1-1", "today", "now"];
      for (const doc of [...refused.map((name) => `fo-slots-by:${name}`), "fo-slots-on:garbage"]) {
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

    test("a root row is made over the wire through a list document, and then opens as its own single document", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-all-courses:", "fo-board:1"]);
      expect((await b.process.call("open", { doc: "fo-course:3" })).error?.code).toBe(404);
      const { ops } = await write(b.process, "fo-all-courses:", [{ op: "add", path: "/courses/-", value: { weddings_id: 1, name: "Fish" } }]);
      expect(ops).toEqual([{ op: "add", path: "/courses/3", value: course(3, "Fish") }]);
      await expectTold(b, "fo-board:1", [ops]);
      expect(content((await b.process.call("open", { doc: "fo-course:3" })).result)).toEqual({ courses: course(3, "Fish"), drinks: {} });
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

    test("a remove of a row that is not there is a 404, whatever holds its collection: a map, a collection with no parent, a list, a list's include (A6)", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-catalog:"]);
      const code = async (doc: string, ops: unknown[]) => (await b.process.call("delta", { doc, ops })).error?.code;
      expect(await code("fo-board:1", [{ op: "remove", path: "/households/999" }])).toBe(404);
      expect(await code("fo-board:1", [{ op: "remove", path: "/tags/999" }])).toBe(404);
      expect(await code("fo-catalog:", [{ op: "remove", path: "/courses/999" }])).toBe(404);
      expect(await code("fo-catalog:", [{ op: "remove", path: "/drinks/999" }])).toBe(404);
      expect(await code("fo-board:1", [{ op: "remove", path: "/tags/1" }, { op: "remove", path: "/tags/1" }])).toBe(404);   // twice in one write: the second is not there
      expect(content((await b.process.call("open", { doc: "fo-board:1" })).result).tags).toEqual({ "1": { id: 1, label: "red" } });
      await assertCopiesHold(b, copies);
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

    test("a column may take any name: a household's t, named as the write SQL named its row, is written and read in every form (todo #58)", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-household:1", "fo-inbox:a@x"]);
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/households/1/t", value: "field" }]);
      await write(b.process, "fo-household:1", [{ op: "replace", path: "/households/t", value: "root" }]);
      await write(b.process, "fo-household:1", [{ op: "replace", path: "/households", value: { t: "merged" } }]);
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/households/2", value: { t: "row" } }]);
      const added = await write(b.process, "fo-board:1", [{ op: "add", path: "/households/-", value: { email: "a@x", t: "added" } }]);
      expect(added.ops).toEqual([{ op: "add", path: "/households/4", value: household(4, "a@x", 1, "added") }]);
      expect(content((await b.process.call("open", { doc: "fo-board:1" })).result).households).toEqual({
        "1": household(1, "a@x", 1, "merged"), "2": household(2, "b@x", 1, "row"), "4": household(4, "a@x", 1, "added"),
      });
      const now = await b.process.call("open_at", { doc: "fo-household:1", at: new Date(Date.now() + 1000).toISOString() });
      expect(content(now.result)).toEqual({ households: household(1, "a@x", 1, "merged") });
      await write(b.process, "fo-board:1", [{ op: "remove", path: "/households/4" }]);
      await assertCopiesHold(b, copies);
    });

    test("a single document is its root and what hangs from it: it adds no other root row (400), and once its root is gone it takes no writes (404), as it opens -- but an undo, which may put it back (todo #52, #59)", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-course:1", "fo-board:1", "fo-menu:1"]);
      const code = async (ops: unknown[]) => (await b.process.call("delta", { doc: "fo-course:1", ops })).error?.code;
      expect(await code([{ op: "add", path: "/courses/7", value: { weddings_id: 1, name: "Seven" } }])).toBe(400);
      expect(await code([{ op: "add", path: "/courses/-", value: { weddings_id: 1, name: "Dash" } }])).toBe(400);
      expect(await code([{ op: "add", path: "/courses/1", value: { weddings_id: 1, name: "Soup" } }])).toBe(409); // its own: there already
      await write(b.process, "fo-board:1", [{ op: "remove", path: "/courses/1" }]);
      expect(await code([{ op: "add", path: "/drinks/-", value: { name: "Port" } }])).toBe(404);
      expect(await code([{ op: "add", path: "/courses/1", value: { weddings_id: 1, name: "Soup again" } }])).toBe(404);
      expect(await code([{ op: "replace", path: "/courses/name", value: "Broth" }])).toBe(404);
      const board = content((await b.process.call("open", { doc: "fo-board:1" })).result);
      expect({ courses: board.courses, drinks: board.drinks }).toEqual({ courses: {}, drinks: {} });
      await assertCopiesHold(b, copies);
    });

    test("a single document that removed its own root takes no writes (404), but its undo puts the root back, and then it does (todo #59, #43)", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-course:1", "fo-menu:1"]);
      const code = async (ops: unknown[]) => (await b.process.call("delta", { doc: "fo-course:1", ops })).error?.code;
      await write(b.process, "fo-course:1", [{ op: "remove", path: "/courses/1" }], { cursor: "s1" });
      expect(await code([{ op: "add", path: "/courses/1", value: { weddings_id: 1, name: "Soup again" } }])).toBe(404);
      expect(await code([{ op: "add", path: "/drinks/-", value: { name: "Port" } }])).toBe(404);
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect({ ops: undone.result.ops.map((o: any) => `${o.op} ${o.path}`), conflict: undone.result.conflict }).toEqual({ ops: ["add /courses/1", "add /drinks/1"], conflict: undefined });
      await write(b.process, "fo-course:1", [{ op: "replace", path: "/courses/name", value: "Broth" }]);
      await assertCopiesHold(b, copies);
      expect(content((await b.process.call("open", { doc: "fo-course:1" })).result)).toEqual({ courses: course(1, "Broth"), drinks: { "1": drink(1, 1, "Sherry") } });
    });

    test("a single document named by its id and another column holds its root only where the row meets both: opened, written, read as it stood and asked its history, another's is not there (404) and nothing is written (0.10.0 review)", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-guest:1:a@x", "fo-board:1", "fo-household:1"]);
      const theirs = "fo-guest:1:z@x";   // household 1 is a@x's
      const code = async (action: string, msg: Record<string, unknown>) => (await b.process.call(action, { doc: theirs, ...msg })).error?.code;
      expect(await code("open", {})).toBe(404);
      expect(await code("delta", { ops: [{ op: "replace", path: "/households/t", value: "taken" }] })).toBe(404);
      expect(await code("delta", { ops: [{ op: "replace", path: "/households/1", value: { t: "taken" } }] })).toBe(404);
      expect(await code("delta", { ops: [{ op: "remove", path: "/households/1" }] })).toBe(404);
      expect(await code("open_at", { at: new Date().toISOString() })).toBe(404);
      expect(await code("history", {})).toBe(404);
      await expectSilent(b, "fo-guest:1:a@x", "fo-board:1", "fo-household:1");
      expect(content((await b.process.call("open", { doc: "fo-guest:1:a@x" })).result)).toEqual({ households: household(1, "a@x") });
      await write(b.process, "fo-guest:1:a@x", [{ op: "replace", path: "/households/t", value: "hers" }], { cursor: "s1" });
      expect((await b.process.call("history", { doc: "fo-guest:1:a@x" })).result).toHaveLength(1);
      await assertCopiesHold(b, copies);
    });

    test("a single document that takes its root out in a write writes nothing more through it (404, nothing written) but that root back, and then on through it (todo #59, #61)", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-course:1", "fo-board:1", "fo-menu:1"]);
      const code = async (ops: unknown[]) => (await b.process.call("delta", { doc: "fo-course:1", ops })).error?.code;
      const out = { op: "remove", path: "/courses/1" };
      expect(await code([out, { op: "add", path: "/drinks/-", value: { name: "Port" } }])).toBe(404); // a drink under no course
      expect(await code([out, { op: "replace", path: "/courses/name", value: "Broth" }])).toBe(404);
      expect(await code([out, { op: "remove", path: "/drinks/1" }])).toBe(404);
      await expectSilent(b, "fo-course:1", "fo-board:1", "fo-menu:1");
      expect(content((await b.process.call("open", { doc: "fo-course:1" })).result)).toEqual({ courses: course(1, "Soup"), drinks: { "1": drink(1, 1, "Sherry") } });
      const { ops } = await write(b.process, "fo-course:1", [out, { op: "add", path: "/courses/1", value: { weddings_id: 1, name: "Broth" } }, { op: "add", path: "/drinks/-", value: { name: "Port" } }]);
      expect(ops).toEqual([out, { op: "remove", path: "/drinks/1" }, { op: "add", path: "/courses/1", value: course(1, "Broth") }, { op: "add", path: "/drinks/3", value: drink(3, 1, "Port") }]);
      expect(content((await b.process.call("open", { doc: "fo-course:1" })).result)).toEqual({ courses: course(1, "Broth"), drinks: { "3": drink(3, 1, "Port") } });
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

    test("the wedding renamed, a course added and named twice, in one write: each op lands and is told where it was sent (the two namings, one straight after the other, as one), and the undo takes the course and gives the name back", async () => {
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
        { op: "replace", path: "/courses/3", value: course(3, "Hake") },
      ]);
      expect(inverse).toEqual([
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

    test("a row replaced again and again, one op straight after another, is answered, recorded and told once, as the run leaves it; a replace of another row between starts a run of its own", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-course:1", "fo-board:1", "fo-menu:1"]);
      const { ops, inverse } = await write(b.process, "fo-course:1", [
        { op: "replace", path: "/courses/name", value: "A" },
        { op: "replace", path: "/courses", value: { name: "B" } },
        { op: "replace", path: "/courses/01/name", value: "C" },
        { op: "replace", path: "/drinks/1/name", value: "Port" },
        { op: "replace", path: "/drinks/1", value: { name: "Madeira" } },
        { op: "replace", path: "/courses/name", value: "D" },
      ], { cursor: "s1" });
      expect(ops).toEqual([
        { op: "replace", path: "/courses", value: course(1, "C") },
        { op: "replace", path: "/drinks/1", value: drink(1, 1, "Madeira") },
        { op: "replace", path: "/courses", value: course(1, "D") },
      ]);
      expect(inverse).toEqual([
        { op: "replace", path: "/courses", value: course(1, "Soup") },
        { op: "replace", path: "/drinks/1", value: drink(1, 1, "Sherry") },
        { op: "replace", path: "/courses", value: course(1, "Soup") },
      ]);
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect({ ops: undone.result.ops, conflict: undone.result.conflict }).toEqual({ ops: [{ op: "replace", path: "/courses", value: course(1, "Soup") }, { op: "replace", path: "/drinks/1", value: drink(1, 1, "Sherry") }], conflict: undefined });
      const inMap = (o: any) => (o.path === "/courses" ? { ...o, path: "/courses/1" } : o);
      await expectTold(b, "fo-course:1", [ops, undone.result.ops]);
      await expectTold(b, "fo-board:1", [ops.map(inMap), undone.result.ops.map(inMap)]);
      await expectTold(b, "fo-menu:1", [ops.map(inMap), undone.result.ops.map(inMap)]);
      await assertCopiesHold(b, copies);
    });

    test("a drink written and then taken with its course, in one write, is told gone once to each document that held it; undone, both come back", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-menu:1", "fo-course:1", "fo-all-courses:"]);
      const { ops } = await write(b.process, "fo-board:1", [
        { op: "replace", path: "/drinks/1/name", value: "Port" },
        { op: "remove", path: "/courses/1" },
      ], { cursor: "s1" });
      const gone = [{ op: "remove", path: "/drinks/1" }, { op: "remove", path: "/courses/1" }];
      expect(ops).toEqual([{ op: "replace", path: "/drinks/1", value: drink(1, 1, "Port") }, { op: "remove", path: "/courses/1" }, { op: "remove", path: "/drinks/1" }]);
      const undone = await b.process.call("undo", { cursor: "s1" });
      const back = [{ op: "add", path: "/courses/1", value: course(1, "Soup") }, { op: "add", path: "/drinks/1", value: drink(1, 1, "Sherry") }];
      expect({ ops: undone.result.ops, conflict: undone.result.conflict }).toEqual({ ops: back, conflict: undefined });
      await expectTold(b, "fo-board:1", [gone, back]);
      await expectTold(b, "fo-menu:1", [gone, back]);
      // the course's own document holds the drink by its key until the course is told gone (null), then hears the drink go
      await expectTold(b, "fo-course:1", [[ops[0], { op: "replace", path: "/courses", value: null }, gone[0]], [{ op: "replace", path: "/courses", value: course(1, "Soup") }, back[1]]]);
      await expectTold(b, "fo-all-courses:", [[gone[1]], [back[0]]]);
      await assertCopiesHold(b, copies);
    });

    test("a row that leaves the document in a write is not there for the rest of it (404), and nothing is written: moved to the other wedding and then removed, renamed or given a drink; out of a list's condition, or added outside it, and then written", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-board:2", "fo-course:1", "fo-courses-like:So", "fo-all-courses:"]);
      const code = async (doc: string, ops: unknown[]) => (await b.process.call("delta", { doc, ops })).error?.code;
      const moved = { op: "replace", path: "/courses/1/weddings_id", value: 2 };
      expect(await code("fo-board:1", [moved, { op: "remove", path: "/courses/1" }])).toBe(404);
      expect(await code("fo-board:1", [moved, { op: "replace", path: "/courses/1/name", value: "X" }])).toBe(404);
      expect(await code("fo-board:1", [moved, { op: "replace", path: "/drinks/1/name", value: "X" }])).toBe(404); // its drink went with it
      expect(await code("fo-board:1", [moved, { op: "add", path: "/drinks/-", value: { courses_id: 1, name: "Gin" } }])).toBe(404);
      expect(await code("fo-courses-like:So", [{ op: "replace", path: "/courses/1/name", value: "Xyz" }, { op: "replace", path: "/courses/1/name", value: "Soup2" }])).toBe(404);
      expect(await code("fo-courses-like:So", [{ op: "add", path: "/courses/-", value: { weddings_id: 1, name: "Fish" } }, { op: "replace", path: "/courses/3/name", value: "Sole" }])).toBe(404);
      await expectSilent(b, "fo-board:1", "fo-board:2", "fo-course:1", "fo-courses-like:So", "fo-all-courses:");
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

    test("a single document's root named by its id is its root: replace /courses/1 and /courses/01/name write it and are told as /courses; another id is not found (404); undone, it goes back", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-course:1", "fo-board:1", "fo-menu:1", "fo-title:1", "fo-all-courses:"]);
      const code = async (doc: string, ops: unknown[]) => (await b.process.call("delta", { doc, ops })).error?.code;
      expect(await code("fo-course:1", [{ op: "replace", path: "/courses/2", value: { name: "x" } }])).toBe(404); // another course: not this document's
      expect(await code("fo-course:1", [{ op: "replace", path: "/courses/2/name", value: "x" }])).toBe(404);
      expect(await code("fo-course:1", [{ op: "replace", path: "/courses/1", value: { nope: 1 } }])).toBe(400);
      expect(await code("fo-course:1", [{ op: "replace", path: "/courses/1", value: 5 }])).toBe(400);
      expect(await code("fo-course:1", [{ op: "replace", path: "/courses/1/nope", value: "x" }])).toBe(400);
      expect(await code("fo-course:1", [{ op: "replace", path: "/courses/1/id", value: 9 }])).toBe(400);
      expect(await code("fo-course:1", [{ op: "replace", path: "/courses/9007199254740993", value: { name: "x" } }])).toBe(400);
      const { ops } = await write(b.process, "fo-course:1", [
        { op: "replace", path: "/courses/1", value: { id: 9, name: "Bisque" } },
        { op: "replace", path: "/courses/01/name", value: "Broth" },
      ], { cursor: "s1" });
      expect(ops).toEqual([{ op: "replace", path: "/courses", value: course(1, "Broth") }]); // one straight after the other: one run
      const titled = await write(b.process, "fo-board:1", [{ op: "replace", path: "/weddings/1/name", value: "our day" }]);
      expect(titled.ops).toEqual([{ op: "replace", path: "/weddings", value: { id: 1, name: "our day" } }]);
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect({ ops: undone.result.ops, conflict: undone.result.conflict }).toEqual({ ops: [{ op: "replace", path: "/courses", value: course(1, "Soup") }], conflict: undefined });
      const renamed = (name: string) => ({ op: "replace", path: "/courses/1", value: course(1, name) });
      await expectTold(b, "fo-menu:1", [[renamed("Broth")], titled.ops, [renamed("Soup")]]);
      await expectTold(b, "fo-all-courses:", [[renamed("Broth")], [renamed("Soup")]]);
      await expectTold(b, "fo-title:1", [titled.ops]);
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

  describe("an included collection whose parent the document does not include (todo #32)", () => {
    test("the wedding's drinks, their courses left out, are held through the courses they hang from: opened, written, told and read as they stood", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-drinks:1", "fo-drinks:2", "fo-board:1"]);
      expect(content(copies.get("fo-drinks:1"))).toEqual({ weddings: { id: 1, name: "ours" }, drinks: { "1": drink(1, 1, "Sherry") } });
      // a drink of another wedding's course is not this document's to add
      expect((await b.process.call("delta", { doc: "fo-drinks:1", ops: [{ op: "add", path: "/drinks/11", value: { courses_id: 2, name: "Gin" } }] })).error?.code).toBe(404);
      const added = await write(b.process, "fo-drinks:1", [{ op: "add", path: "/drinks/10", value: { courses_id: 1, name: "Port" } }]);
      expect(added.ops).toEqual([{ op: "add", path: "/drinks/10", value: drink(10, 1, "Port") }]);
      const renamed = await write(b.process, "fo-board:1", [{ op: "replace", path: "/drinks/1/name", value: "Madeira" }]);
      await expectTold(b, "fo-drinks:1", [added.ops, renamed.ops]);
      await expectTold(b, "fo-board:1", [added.ops, renamed.ops]);
      await expectSilent(b, "fo-drinks:2");
      const then = await b.process.call("open_at", { doc: "fo-drinks:1", at: new Date().toISOString() });
      expect(content(then.result).drinks).toEqual({ "1": drink(1, 1, "Madeira"), "10": drink(10, 1, "Port") });
      await assertCopiesHold(b, copies);
    });

    test("a course's households, which hang from the wedding it does not include, are none of its: not read, not written, not told", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-course-guests:1", "fo-board:1"]);
      expect(content(copies.get("fo-course-guests:1"))).toEqual({ courses: course(1, "Soup"), households: {} });
      const code = async (ops: unknown[]) => (await b.process.call("delta", { doc: "fo-course-guests:1", ops })).error?.code;
      expect(await code([{ op: "replace", path: "/households/1/email", value: "x@x" }])).toBe(404);
      expect(await code([{ op: "remove", path: "/households/1" }])).toBe(404);
      expect(await code([{ op: "add", path: "/households/10", value: { weddings_id: 1, email: "n@x" } }])).toBe(404);
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/households/1/email", value: "new@x" }]);
      await expectSilent(b, "fo-course-guests:1");
      const then = await b.process.call("open_at", { doc: "fo-course-guests:1", at: new Date().toISOString() });
      expect(content(then.result).households).toEqual({});
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

    test("a note as a document's root, alone or in a list, is read, written, told, undone and read as it was without its validity", async () => {
      const b = backend();
      const note = (id: number, text: string) => ({ id, weddings_id: 1, text });
      const copies = await openAll(b.process, ["fo-note:1", "fo-all-notes:", "fo-notes:1"]);
      expect(content(copies.get("fo-note:1"))).toEqual({ notes: note(1, "bring chairs") });
      expect(content(copies.get("fo-all-notes:"))).toEqual({ notes: { "1": note(1, "bring chairs") } });
      const changed = await write(b.process, "fo-note:1", [{ op: "replace", path: "/notes/text", value: "bring tables" }], { cursor: "s1" });
      expect({ ops: changed.ops, inverse: changed.inverse }).toEqual({
        ops: [{ op: "replace", path: "/notes", value: note(1, "bring tables") }],
        inverse: [{ op: "replace", path: "/notes", value: note(1, "bring chairs") }],
      });
      const added = await write(b.process, "fo-all-notes:", [{ op: "add", path: "/notes/-", value: { weddings_id: 1, text: "bring lights" } }]);
      expect(added.ops).toEqual([{ op: "add", path: "/notes/2", value: note(2, "bring lights") }]);
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect({ ops: undone.result.ops, conflict: undone.result.conflict }).toEqual({ ops: [{ op: "replace", path: "/notes", value: note(1, "bring chairs") }], conflict: undefined });
      await expectTold(b, "fo-note:1", [changed.ops, undone.result.ops]);
      await expectTold(b, "fo-all-notes:", [[{ op: "replace", path: "/notes/1", value: note(1, "bring tables") }], added.ops, [{ op: "replace", path: "/notes/1", value: note(1, "bring chairs") }]]);
      const then = await b.process.call("open_at", { doc: "fo-note:1", at: "2021-01-01T00:00:00.000Z" });
      expect(content(then.result)).toEqual({ notes: note(1, "bring chairs") });
      const history = (await b.process.call("history", { doc: "fo-note:1", cursor: "s1" })).result;
      expect(JSON.stringify(history)).not.toContain("valid_");
      await assertCopiesHold(b, copies);
    });

    test("a note written twice in one write, another row between, is one new version: each replace is answered and told, and its history holds the note before the write and after it", async () => {
      const b = backend();
      const note = (text: string) => ({ id: 1, weddings_id: 1, text });
      const copies = await openAll(b.process, ["fo-board:1", "fo-notes:1", "fo-note:1"]);
      const { ops } = await write(b.process, "fo-board:1", [
        { op: "replace", path: "/notes/1/text", value: "bring tables" },
        { op: "replace", path: "/weddings/name", value: "our day" },
        { op: "replace", path: "/notes/1", value: { text: "bring lights" } },
      ], { cursor: "s1" });
      expect(ops).toEqual([
        { op: "replace", path: "/notes/1", value: note("bring tables") },
        { op: "replace", path: "/weddings", value: { id: 1, name: "our day" } },
        { op: "replace", path: "/notes/1", value: note("bring lights") },
      ]);
      const versions = async () => (await b.exportTables()).tables.notes!.filter((r: any) => r.id === 1).map((r: any) => ({ text: r.text, live: r.valid_to == null }));
      expect(await versions()).toEqual([{ text: "bring chairs", live: false }, { text: "bring lights", live: true }]);
      const undone = await b.process.call("undo", { cursor: "s1" });
      const back = [{ op: "replace", path: "/notes/1", value: note("bring chairs") }, { op: "replace", path: "/weddings", value: { id: 1, name: "ours" } }];
      expect({ ops: undone.result.ops, conflict: undone.result.conflict }).toEqual({ ops: back, conflict: undefined });
      expect(await versions()).toEqual([{ text: "bring chairs", live: false }, { text: "bring lights", live: false }, { text: "bring chairs", live: true }]);
      await expectTold(b, "fo-note:1", [[{ op: "replace", path: "/notes", value: note("bring tables") }, { op: "replace", path: "/notes", value: note("bring lights") }], [{ op: "replace", path: "/notes", value: note("bring chairs") }]]);
      await expectTold(b, "fo-notes:1", [ops, back]);
      await assertCopiesHold(b, copies);
    });

    test("a note written, removed and added back in one write through the board -- or added, removed and added again -- is one moment: one new version, undone, redone and undone again to the notes as they were", async () => {
      const b = backend();
      const note = (id: number, text: string) => ({ id, weddings_id: 1, text });
      const copies = await openAll(b.process, ["fo-board:1", "fo-notes:1", "fo-note:1", "fo-all-notes:"]);
      const versions = async (id: number) => (await b.exportTables()).tables.notes!.filter((r: any) => r.id === id).map((r: any) => ({ text: r.text, live: r.valid_to == null }));
      const walked = async (cursor: string, way: string) => {
        const { result } = await b.process.call(way, { cursor });
        return { ops: result.ops, conflict: result.conflict };
      };
      const rewritten = await write(b.process, "fo-board:1", [
        { op: "replace", path: "/notes/1/text", value: "bring tables" },
        { op: "remove", path: "/notes/1" },
        { op: "add", path: "/notes/1", value: { text: "bring lights" } },
      ], { cursor: "s1" });
      expect(rewritten.ops).toEqual([
        { op: "replace", path: "/notes/1", value: note(1, "bring tables") },
        { op: "remove", path: "/notes/1" },
        { op: "add", path: "/notes/1", value: note(1, "bring lights") },
      ]);
      const readded = await write(b.process, "fo-board:1", [
        { op: "add", path: "/notes/7", value: { text: "bring tables" } },
        { op: "remove", path: "/notes/7" },
        { op: "add", path: "/notes/7", value: { text: "bring lights" } },
      ], { cursor: "s2" });
      expect(readded.ops).toEqual([
        { op: "add", path: "/notes/7", value: note(7, "bring tables") },
        { op: "remove", path: "/notes/7" },
        { op: "add", path: "/notes/7", value: note(7, "bring lights") },
      ]);
      expect({ 1: await versions(1), 7: await versions(7) }).toEqual({
        1: [{ text: "bring chairs", live: false }, { text: "bring lights", live: true }],
        7: [{ text: "bring lights", live: true }],
      });
      const as = (text: string) => [{ op: "replace", path: "/notes/1", value: note(1, text) }];
      const taken = [{ op: "remove", path: "/notes/7" }];
      const made = [{ op: "add", path: "/notes/7", value: note(7, "bring lights") }];
      for (const [cursor, back, again] of [["s1", as("bring chairs"), as("bring lights")], ["s2", taken, made]] as const) {
        expect({ cursor, ...(await walked(cursor, "undo")) }).toEqual({ cursor, ops: back, conflict: undefined });
        expect({ cursor, ...(await walked(cursor, "redo")) }).toEqual({ cursor, ops: again, conflict: undefined });
        expect({ cursor, ...(await walked(cursor, "undo")) }).toEqual({ cursor, ops: back, conflict: undefined });
      }
      const was = (text: string, live = false) => ({ text, live });
      expect({ 1: await versions(1), 7: await versions(7) }).toEqual({
        1: [was("bring chairs"), was("bring lights"), was("bring chairs"), was("bring lights"), was("bring chairs", true)],
        7: [was("bring lights"), was("bring lights")],
      });
      expect(content((await b.process.call("open", { doc: "fo-notes:1" })).result)).toEqual({ weddings: { id: 1, name: "ours" }, notes: { "1": note(1, "bring chairs") } });
      await expectTold(b, "fo-notes:1", [rewritten.ops, readded.ops, as("bring chairs"), as("bring lights"), as("bring chairs"), taken, made, taken]);
      await assertCopiesHold(b, copies);
    });

    test("a note written, removed and added back in one write through its own document is one moment: one new version, told at its root, undone, redone and undone again to the note it was", async () => {
      const b = backend();
      const note = (text: string) => ({ id: 1, weddings_id: 1, text });
      const copies = await openAll(b.process, ["fo-note:1", "fo-notes:1", "fo-all-notes:"]);
      const versions = async () => (await b.exportTables()).tables.notes!.filter((r: any) => r.id === 1).map((r: any) => ({ text: r.text, live: r.valid_to == null }));
      const walked = async (way: string) => {
        const { result } = await b.process.call(way, { cursor: "s1" });
        return { ops: result.ops, conflict: result.conflict };
      };
      const { ops } = await write(b.process, "fo-note:1", [
        { op: "replace", path: "/notes/text", value: "bring tables" },
        { op: "remove", path: "/notes/1" },
        { op: "add", path: "/notes/1", value: { weddings_id: 1, text: "bring lights" } },
      ], { cursor: "s1" });
      expect(ops).toEqual([
        { op: "replace", path: "/notes", value: note("bring tables") },
        { op: "remove", path: "/notes/1" },
        { op: "add", path: "/notes/1", value: note("bring lights") },
      ]);
      expect(await versions()).toEqual([{ text: "bring chairs", live: false }, { text: "bring lights", live: true }]);
      const as = (text: string) => [{ op: "replace", path: "/notes", value: note(text) }];
      expect(await walked("undo")).toEqual({ ops: as("bring chairs"), conflict: undefined });
      expect(await walked("redo")).toEqual({ ops: as("bring lights"), conflict: undefined });
      expect(await walked("undo")).toEqual({ ops: as("bring chairs"), conflict: undefined });
      const was = (text: string, live = false) => ({ text, live });
      expect(await versions()).toEqual([was("bring chairs"), was("bring lights"), was("bring chairs"), was("bring lights"), was("bring chairs", true)]);
      await expectTold(b, "fo-note:1", [
        [...as("bring tables"), { op: "replace", path: "/notes", value: null }, ...as("bring lights")],
        as("bring chairs"), as("bring lights"), as("bring chairs"),
      ]);
      await assertCopiesHold(b, copies);
    });

    test("a note closed through the board (removed: its history kept, no longer current) leaves the notes document", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-notes:1"]);
      await write(b.process, "fo-board:1", [{ op: "remove", path: "/notes/1" }]);
      await expectTold(b, "fo-notes:1", [[{ op: "remove", path: "/notes/1" }]]);
      await assertCopiesHold(b, copies);
    });

    test("an add never makes a second live note: one at /- that meets an id a client named is refused as already there (409), as a plain row's is (todo #16)", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-notes:1"]);
      const code = async (ops: unknown[]) => (await b.process.call("delta", { doc: "fo-board:1", ops })).error?.code;
      // the seed's sequences stop at the rows it holds: 2 is the next each would mint
      await write(b.process, "fo-board:1", [{ op: "add", path: "/notes/2", value: { text: "named" } }]);
      expect(await code([{ op: "add", path: "/notes/-", value: { text: "minted" } }])).toBe(409);
      await write(b.process, "fo-board:1", [{ op: "add", path: "/courses/3", value: { name: "named" } }]);
      expect(await code([{ op: "add", path: "/courses/-", value: { name: "minted" } }])).toBe(409);
      expect(content((await b.process.call("open", { doc: "fo-notes:1" })).result).notes).toEqual({
        "1": { id: 1, weddings_id: 1, text: "bring chairs" },
        "2": { id: 2, weddings_id: 1, text: "named" },
      });
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

    test("a course renamed and then removed through its own document in one write is undone as it was before the write, then its drink; redone, and undone again", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-course:1", "fo-board:1", "fo-menu:1"]);
      const removed = await write(b.process, "fo-course:1", [
        { op: "replace", path: "/courses/name", value: "Gone" },
        { op: "remove", path: "/courses/1" },
      ], { cursor: "s1" });
      expect(removed.ops).toEqual([{ op: "replace", path: "/courses", value: course(1, "Gone") }, { op: "remove", path: "/courses/1" }, { op: "remove", path: "/drinks/1" }]);
      const back = [{ op: "add", path: "/courses/1", value: course(1, "Soup") }, { op: "add", path: "/drinks/1", value: drink(1, 1, "Sherry") }];
      const taken = [{ op: "remove", path: "/drinks/1" }, { op: "remove", path: "/courses/1" }];
      expect(removed.inverse).toEqual(back);
      const walked = async (way: string) => {
        const { result } = await b.process.call(way, { cursor: "s1" });
        return { ops: result.ops, conflict: result.conflict };
      };
      expect(await walked("undo")).toEqual({ ops: back, conflict: undefined });
      expect(content((await b.process.call("open", { doc: "fo-course:1" })).result)).toEqual({ courses: course(1, "Soup"), drinks: { "1": drink(1, 1, "Sherry") } });
      expect(await walked("redo")).toEqual({ ops: taken, conflict: undefined });
      expect(await walked("undo")).toEqual({ ops: back, conflict: undefined });
      const written = [{ op: "replace", path: "/courses/1", value: course(1, "Gone") }, { op: "remove", path: "/courses/1" }, { op: "remove", path: "/drinks/1" }];
      await expectTold(b, "fo-menu:1", [written, back, taken, back]);
      await expectTold(b, "fo-board:1", [written, back, taken, back]);
      await assertCopiesHold(b, copies);
    });

    test("a household removed and added back through its own document in one write is walked as one row, at its root: undone, redone and undone again", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-household:1", "fo-board:1", "fo-inbox:a@x", "fo-inbox:z@x"]);
      const written = await write(b.process, "fo-household:1", [
        { op: "remove", path: "/households/1" },
        { op: "add", path: "/households/1", value: { weddings_id: 1, email: "z@x" } },
      ], { cursor: "s1" });
      expect(written.ops).toEqual([{ op: "remove", path: "/households/1" }, { op: "add", path: "/households/1", value: household(1, "z@x") }]);
      const dry = await b.process.call("undo", { cursor: "s1", dry: true });
      expect({ ops: dry.result.ops, conflict: dry.result.conflict }).toEqual({ ops: [{ op: "replace", path: "/households", value: { email: "a@x" } }], conflict: undefined });
      const walked = async (way: string) => {
        const { result } = await b.process.call(way, { cursor: "s1" });
        return { ops: result.ops, conflict: result.conflict };
      };
      const as = (email: string) => [{ op: "replace", path: "/households", value: household(1, email) }];
      expect(await walked("undo")).toEqual({ ops: as("a@x"), conflict: undefined });
      expect(await walked("redo")).toEqual({ ops: as("z@x"), conflict: undefined });
      expect(await walked("undo")).toEqual({ ops: as("a@x"), conflict: undefined });
      const inBoard = (email: string) => [{ op: "replace", path: "/households/1", value: household(1, email) }];
      await expectTold(b, "fo-household:1", [[{ op: "replace", path: "/households", value: null }, as("z@x")[0]], as("a@x"), as("z@x"), as("a@x")]);
      await expectTold(b, "fo-board:1", [written.ops, inBoard("a@x"), inBoard("z@x"), inBoard("a@x")]);
      await assertCopiesHold(b, copies);
    });

    test("a course removed, added back and renamed through its own document in one write -- or renamed first too -- is walked as one row, its drink with it: undone, redone and undone again", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-course:1", "fo-course:2", "fo-board:1", "fo-menu:1", "fo-board:2"]);
      const walked = async (cursor: string, way: string) => {
        const { result } = await b.process.call(way, { cursor });
        return { ops: result.ops, conflict: result.conflict };
      };
      const cases: [string, number, number, string, string, unknown[]][] = [
        ["s1", 1, 1, "Soup", "Sherry", []],
        ["s2", 2, 2, "Salad", "Water", [{ op: "replace", path: "/courses/name", value: "Renamed" }]],
      ];
      for (const [cursor, id, wedding, name, drinkName, first] of cases) {
        const doc = `fo-course:${id}`;
        const { ops } = await write(b.process, doc, [
          ...first,
          { op: "remove", path: `/courses/${id}` },
          { op: "add", path: `/courses/${id}`, value: { weddings_id: wedding, name: "New" } },
          { op: "replace", path: "/courses/name", value: "Newer" },
        ], { cursor });
        expect(ops.slice(-3)).toEqual([{ op: "remove", path: `/drinks/${id}` }, { op: "add", path: `/courses/${id}`, value: course(id, "New", wedding) }, { op: "replace", path: "/courses", value: course(id, "Newer", wedding) }]);
        const back = [{ op: "replace", path: "/courses", value: course(id, name, wedding) }, { op: "add", path: `/drinks/${id}`, value: drink(id, id, drinkName) }];
        expect({ cursor, ...(await walked(cursor, "undo")) }).toEqual({ cursor, ops: back, conflict: undefined });
        expect(content((await b.process.call("open", { doc })).result)).toEqual({ courses: course(id, name, wedding), drinks: { [id]: drink(id, id, drinkName) } });
        expect({ cursor, ...(await walked(cursor, "redo")) }).toEqual({ cursor, ops: [{ op: "remove", path: `/drinks/${id}` }, { op: "replace", path: "/courses", value: course(id, "Newer", wedding) }], conflict: undefined });
        expect({ cursor, ...(await walked(cursor, "undo")) }).toEqual({ cursor, ops: back, conflict: undefined });
      }
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

    test("a seat added through a json list named as a JSON string, object or array, or a number spelled another way, is given the JSON the name is, told to the writer and read back by it", async () => {
      const b = backend();
      const names: [string, unknown][] = [['"5"', "5"], ['"a"', "a"], ["{}", {}], ["[]", []], ["5.0", 5], [" 5", 5], ["1e0", 1], ['[1, "a", null]', [1, "a", null]]];
      const lists = names.map(([name]) => `fo-seats-wished:${name}`);
      const copies = await openAll(b.process, [...lists, "fo-seating:1"]);
      let id = 1;
      for (const [name, wishes] of names) {
        const doc = `fo-seats-wished:${name}`;
        const { ops } = await write(b.process, doc, [{ op: "add", path: "/seats/-", value: { weddings_id: 1, table_no: 4, kept: false } }]);
        id += 1;
        expect({ name, ops }).toEqual({ name, ops: [{ op: "add", path: `/seats/${id}`, value: seat(id, 4, false, wishes) }] });
        await b.quiet();
        expect({ name, told: told(b.process, doc).at(-1) }).toEqual({ name, told: ops });
      }
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

    test("a seat that leaves a list's condition, still matching, is not taken for removed: the list is told it left, the custom document a replace, and keeps it -- written through the seating plan, since the list itself may not write it out (todo #6's review)", async () => {
      const b = backend();
      await b.process.call("open", { doc: "fo-seating:1" });
      await write(b.process, "fo-seating:1", [{ op: "replace", path: "/seats/1/kept", value: false }]);
      await b.quiet();
      const copies = await openAll(b.process, ["fo-seats-at:3", "fo-seats-at:open:all"]);
      copies.delete("fo-seats-at:open:all"); // its first read is the backend's own query, not a document's
      expect((await b.process.call("delta", { doc: "fo-seats-at:3", ops: [{ op: "replace", path: "/seats/1/table_no", value: 5 }] })).error?.code).toBe(404);
      await write(b.process, "fo-seating:1", [{ op: "replace", path: "/seats/1/table_no", value: 5 }]);
      await expectTold(b, "fo-seats-at:3", [[{ op: "remove", path: "/seats/1" }]]);
      await expectTold(b, "fo-seats-at:open:all", [[{ op: "replace", path: "/seats/1", value: seat(1, 5, false, { veg: true }) }]]);
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

  describe("an implied document (todo #34)", () => {
    test("it opens before its root row is, empty, and makes no row; a first write that fails makes none; the first that lands makes the row, and is told as written", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-plan:7", "fo-plan:8", "fo-all-courses:"]);
      expect(content(copies.get("fo-plan:7"))).toEqual({ weddings: { id: 7, name: "" }, courses: {}, drinks: {} });
      expect((await b.process.call("open", { doc: "fo-title:7" })).error?.code).toBe(404);   // no row made
      expect((await b.process.call("delta", { doc: "fo-plan:7", ops: [{ op: "add", path: "/courses/10", value: {} }] })).error?.code).toBe(400);
      expect((await b.process.call("open", { doc: "fo-title:7" })).error?.code).toBe(404);   // a failed first write makes none
      const added = await write(b.process, "fo-plan:7", [{ op: "add", path: "/courses/10", value: { name: "Soup" } }]);
      expect(added.ops).toEqual([{ op: "add", path: "/courses/10", value: course(10, "Soup", 7) }]);
      const named = await write(b.process, "fo-plan:8", [{ op: "replace", path: "/weddings/name", value: "the other" }]);
      expect(named.ops).toEqual([{ op: "replace", path: "/weddings", value: { id: 8, name: "the other" } }]);
      await expectTold(b, "fo-plan:7", [added.ops]);
      await expectTold(b, "fo-plan:8", [named.ops]);
      await expectTold(b, "fo-all-courses:", [added.ops]);
      expect(content((await b.process.call("open", { doc: "fo-title:7" })).result)).toEqual({ weddings: { id: 7, name: "" } });
      await assertCopiesHold(b, copies);
    });

    test("its root removed through it, the row and the rows under it go and it opens empty again: a copy is told that empty root; undone, they come back, root first", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-plan:7", "fo-all-courses:"]);
      const added = await write(b.process, "fo-plan:7", [
        { op: "add", path: "/courses/10", value: { name: "Soup" } },
        { op: "add", path: "/drinks/10", value: { courses_id: 10, name: "Sherry" } },
      ], { cursor: "s1" });
      const removed = await write(b.process, "fo-plan:7", [{ op: "remove", path: "/weddings/7" }], { cursor: "s1" });
      expect(removed.ops).toEqual([{ op: "remove", path: "/weddings/7" }, { op: "remove", path: "/courses/10" }, { op: "remove", path: "/drinks/10" }]);
      expect(content((await b.process.call("open", { doc: "fo-plan:7" })).result)).toEqual({ weddings: { id: 7, name: "" }, courses: {}, drinks: {} });
      const undone = await b.process.call("undo", { cursor: "s1" });
      expect({ ops: undone.result.ops, conflict: undone.result.conflict }).toEqual({ ops: [
        { op: "add", path: "/weddings/7", value: { id: 7, name: "" } },
        { op: "add", path: "/courses/10", value: course(10, "Soup", 7) },
        { op: "add", path: "/drinks/10", value: drink(10, 10, "Sherry") },
      ], conflict: undefined });
      await expectTold(b, "fo-plan:7", [
        added.ops,
        [{ op: "replace", path: "/weddings", value: { id: 7, name: "" } }, { op: "remove", path: "/courses/10" }, { op: "remove", path: "/drinks/10" }],
        [{ op: "replace", path: "/weddings", value: { id: 7, name: "" } }, { op: "add", path: "/courses/10", value: course(10, "Soup", 7) }, { op: "add", path: "/drinks/10", value: drink(10, 10, "Sherry") }],
      ]);
      await expectTold(b, "fo-all-courses:", [[added.ops[0]], [{ op: "remove", path: "/courses/10" }], [{ op: "add", path: "/courses/10", value: course(10, "Soup", 7) }]]);
      await assertCopiesHold(b, copies);
    });
  });

  describe("a recompute custom document (todo #35)", () => {
    test("the menu card is read whole, and again on each write to what it watches -- its own wedding's or another's -- told as a root replace; a write to what it does not watch is not told", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-menu-card:1", "fo-board:1", "fo-board:2"]);
      expect(copies.get("fo-menu-card:1")).toEqual({ wedding: "ours", courses: ["Soup"] });
      // each read as the tables stand when it is read: on Postgres, after the write's commit is heard
      const card = (wedding: string, courses: string[]) => [{ op: "replace", path: "", value: { wedding, courses } }];
      await write(b.process, "fo-board:1", [{ op: "add", path: "/courses/10", value: { name: "Fish" } }]);
      await expectTold(b, "fo-menu-card:1", [card("ours", ["Soup", "Fish"])]);
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/weddings/name", value: "our day" }]);
      await expectTold(b, "fo-menu-card:1", [card("ours", ["Soup", "Fish"]), card("our day", ["Soup", "Fish"])]);
      await write(b.process, "fo-board:2", [{ op: "replace", path: "/courses/2/name", value: "Slaw" }]);   // no relevance gate: read again, the same
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/households/1/email", value: "z@x" }]);   // not watched
      await expectTold(b, "fo-menu-card:1", [card("ours", ["Soup", "Fish"]), card("our day", ["Soup", "Fish"]), card("our day", ["Soup", "Fish"])]);
      await assertCopiesHold(b, copies);
    });

    test("a menu card whose wedding is not there is not found (404); it is read-only (403); undone, a write is read again", async () => {
      const b = backend();
      expect((await b.process.call("open", { doc: "fo-menu-card:9" })).error?.code).toBe(404);
      const copies = await openAll(b.process, ["fo-menu-card:1", "fo-board:1"]);
      expect((await b.process.call("delta", { doc: "fo-menu-card:1", ops: [{ op: "replace", path: "/wedding", value: "x" }] })).error?.code).toBe(403);
      await write(b.process, "fo-board:1", [{ op: "remove", path: "/courses/1" }], { cursor: "s1" });
      await expectTold(b, "fo-menu-card:1", [[{ op: "replace", path: "", value: { wedding: "ours", courses: [] } }]]);
      expect((await b.process.call("undo", { cursor: "s1" })).error).toBeUndefined();
      await expectTold(b, "fo-menu-card:1", [
        [{ op: "replace", path: "", value: { wedding: "ours", courses: [] } }],
        [{ op: "replace", path: "", value: { wedding: "ours", courses: ["Soup"] } }],
      ]);
      await b.process.call("close", { doc: "fo-menu-card:1" });
      await write(b.process, "fo-board:1", [{ op: "replace", path: "/courses/1/name", value: "Broth" }]);
      await expectTold(b, "fo-menu-card:1", [
        [{ op: "replace", path: "", value: { wedding: "ours", courses: [] } }],
        [{ op: "replace", path: "", value: { wedding: "ours", courses: ["Soup"] } }],
      ]);   // closed: not read again, not told
      copies.delete("fo-menu-card:1");
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
    test("a row moved through a document to a parent it does not hold is refused (404), as an add there is -- a household to the other wedding, a drink to its course -- and nobody is told (todo #6's review)", async () => {
      const b = backend();
      const copies = await openAll(b.process, ["fo-board:1", "fo-board:2", "fo-menu:1", "fo-drinks:1", "fo-household:1", "fo-course:2"]);
      const code = async (doc: string, ops: unknown[]) => (await b.process.call("delta", { doc, ops })).error?.code;
      expect(await code("fo-board:1", [{ op: "replace", path: "/households/1/weddings_id", value: 2 }])).toBe(404);
      expect(await code("fo-board:1", [{ op: "replace", path: "/households/1", value: { weddings_id: 2 } }])).toBe(404);
      expect(await code("fo-board:1", [{ op: "replace", path: "/drinks/1/courses_id", value: 2 }])).toBe(404);
      expect(await code("fo-board:1", [{ op: "replace", path: "/drinks/1", value: { courses_id: 2, name: "Gin" } }])).toBe(404);
      expect(await code("fo-menu:1", [{ op: "replace", path: "/drinks/1/courses_id", value: 2 }])).toBe(404);
      expect(await code("fo-drinks:1", [{ op: "replace", path: "/drinks/1/courses_id", value: 2 }])).toBe(404);   // its courses left out: their chain, from the tables
      expect(await code("fo-board:1", [{ op: "replace", path: "/drinks/1/courses_id", value: 99 }])).toBe(404);   // no such course
      await expectSilent(b, "fo-board:1", "fo-board:2", "fo-menu:1", "fo-drinks:1", "fo-household:1", "fo-course:2");
      await assertCopiesHold(b, copies);
    });

    test("a list's root row written through the list stays in its scope: a field, a row or a merge that takes it out -- a slot to another wedding's list, a course out of a name's -- is refused (404), the write undone, and nobody is told (todo #6's review)", async () => {
      const b = backend();
      await b.process.call("open", { doc: "fo-slots-of:1" });
      expect((await write(b.process, "fo-slots-of:1", [{ op: "add", path: "/slots/-", value: { price: 1 } }])).ops[0].value.weddings_id).toBe(1);
      await b.quiet();
      const copies = await openAll(b.process, ["fo-slots-of:1", "fo-slots-of:2", "fo-slots-upto:5", "fo-courses-like:So", "fo-courses-like:Fi", "fo-board:1"]);
      const code = async (doc: string, ops: unknown[]) => (await b.process.call("delta", { doc, ops })).error?.code;
      expect(await code("fo-slots-of:1", [{ op: "replace", path: "/slots/1/weddings_id", value: 2 }])).toBe(404);
      expect(await code("fo-slots-of:1", [{ op: "replace", path: "/slots/1", value: { weddings_id: 2 } }])).toBe(404);
      expect(await code("fo-slots-of:1", [{ op: "replace", path: "/slots/1/price", value: 3 }, { op: "replace", path: "/slots/1/weddings_id", value: 2 }])).toBe(404);   // a run: its first write undone too
      expect(await code("fo-slots-of:1", [{ op: "replace", path: "/slots/1/weddings_id", value: 2 }, { op: "replace", path: "/slots/1/weddings_id", value: 1 }])).toBe(404);   // out and back: out is out
      expect(await code("fo-slots-upto:5", [{ op: "replace", path: "/slots/1/price", value: 9 }])).toBe(404);
      expect(await code("fo-courses-like:So", [{ op: "replace", path: "/courses/1/name", value: "Fish soup" }])).toBe(404);
      await expectSilent(b, "fo-slots-of:1", "fo-slots-of:2", "fo-slots-upto:5", "fo-courses-like:So", "fo-courses-like:Fi", "fo-board:1");
      expect(content((await b.process.call("open", { doc: "fo-slots-of:1" })).result).slots).toEqual({ "1": { id: 1, weddings_id: 1, price: 1, starts: null } });
      // one that stays in the scope is written
      await write(b.process, "fo-slots-of:1", [{ op: "replace", path: "/slots/1", value: { weddings_id: 1, price: 2 } }]);
      await write(b.process, "fo-courses-like:So", [{ op: "replace", path: "/courses/1/name", value: "Soup of the day" }]);
      await assertCopiesHold(b, copies);
    });

    test("a course moved to the other wedding through a list, which holds every course, leaves this board and arrives on that one", async () => {
      const b = backend();
      await b.process.call("open", { doc: "fo-board:1" });
      await write(b.process, "fo-board:1", [{ op: "add", path: "/courses/10", value: { name: "Fish" } }]);
      await b.quiet();
      const copies = await openAll(b.process, ["fo-all-courses:", "fo-board:1", "fo-board:2", "fo-course:10"]);
      await write(b.process, "fo-all-courses:", [{ op: "replace", path: "/courses/10/weddings_id", value: 2 }]);
      await expectTold(b, "fo-board:1", [[{ op: "remove", path: "/courses/10" }]]);
      await expectTold(b, "fo-board:2", [[{ op: "add", path: "/courses/10", value: course(10, "Fish", 2) }]]);
      await expectTold(b, "fo-course:10", [[{ op: "replace", path: "/courses", value: course(10, "Fish", 2) }]]);
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
