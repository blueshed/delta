/**
 * Custom documents (`defineCustomDoc`), the same on SQLite and Postgres: who
 * holds each (a membership document's views, a recompute document's
 * subscribers), who may still hear a document, and what a write tells them.
 *
 * SQLite's `query`, `recompute` and `owns` answer at once, Postgres's with a
 * promise, so each step takes either (`after`): on SQLite it all runs at once,
 * and a write is told before it answers.
 */
import { changedFields, joinPath, splitPath, type DeltaOp } from "../core";
import { authless, isAuthError, ownerless, type DeltaAuth } from "./auth";
import type { createLogger } from "./logger";
import { trackUnsubscribe } from "./server";

export type MaybePromise<T> = T | Promise<T>;
export const isPromise = <T>(x: MaybePromise<T>): x is Promise<T> => typeof (x as any)?.then === "function";
/** `f` of `x`: at once when `x` is a value, once it settles when it is a promise. */
const after = <T, U>(x: MaybePromise<T>, f: (t: T) => MaybePromise<U>): MaybePromise<U> => (isPromise(x) ? x.then(f) : f(x));

/** Why a socket may not hear a document: the gate's refusal (401), or the owner's (404). */
export type Refusal = { code: number; message: string };
export const NOT_FOUND: Refusal = { code: 404, message: "Not found" };
export type Owns<I> = (identity: I, docName: string) => boolean | Promise<boolean>;

/** What each backend's `CustomDocDef` says; `H` is the handle its reads take (SQLite's database, Postgres's pool). */
export interface CustomDoc<C = unknown, I = any, H = any> {
  /** Doc name prefix (e.g. "sites-in-bbox:"). */
  prefix: string;
  /** Collections whose writes reach it (per row for a membership def, the whole doc for a recompute def). */
  watch: string[];
  /** Parse the portion of docName after prefix into criteria. */
  parse: (docId: string) => C;
  /** MEMBERSHIP def (flat, per-row fan-out) -- `query` + `matches`. The rows this doc exposes, keyed by collection. */
  query?: (handle: H, criteria: C, identity?: I) => MaybePromise<Record<string, any[]>>;
  /**
   * True when `row` belongs in a doc opened under `criteria` (membership def),
   * for the subscribers who are `identity`. The row is the write's, which no
   * RLS filters: check it against the identity here.
   */
  matches?: (collection: string, row: any, criteria: C, identity?: I) => boolean;
  /** RECOMPUTE def (whole-doc) -- `recompute` INSTEAD of query/matches. Null: not found. */
  recompute?: (handle: H, criteria: C, identity?: I) => MaybePromise<any>;
  /**
   * With an `auth` module: may `identity` open `docName`? False answers 404.
   * With auth, a custom doc needs this or `shared: true`: `registerDocs` and
   * `createDocListener` refuse one with neither.
   */
  owns?: Owns<I>;
  /** With an `auth` module: every identity that passes the gate may open every doc of this prefix. */
  shared?: boolean;
}

/** Default-deny: with auth, each custom doc says who owns it, or that it is shared; without, neither (nothing would ask). */
export function assertOwned(defs: CustomDoc[], auth: DeltaAuth<any> | undefined): void {
  const wrong = defs.find((d) => (auth ? !d.owns && !d.shared : d.owns || d.shared));
  if (wrong) throw (auth ? ownerless : authless)(wrong.prefix, "defineCustomDoc");
}

/**
 * One prefix, one document: refused where a prefix comes twice in `prefixes`,
 * or `taken` says another document has it already -- else one would silently
 * answer for the other (todo #76).
 */
export function assertOnePrefix(prefixes: string[], taken: (prefix: string) => boolean = () => false): void {
  const twice = prefixes.find((p, i) => taken(p) || prefixes.indexOf(p) < i);
  if (twice !== undefined) throw new Error(`"${twice}" names two documents -- a name is answered by one document: give each its own prefix`);
}

/** Rows keyed by id. */
export function toMap(rows: any[]): Record<string, any> {
  const m: Record<string, any> = {};
  for (const row of rows) m[row.id] = row;
  return m;
}

/** Send to one socket while it is open; a closing socket is passed over. */
export function sendTo(client: any, data: unknown): void {
  try { if (client.readyState === undefined || client.readyState === 1) client.send(typeof data === "string" ? data : JSON.stringify(data)); }
  catch { /* the socket may be closing */ }
}

const message = (err: any): string => String(err?.message ?? err);

type Rows = Record<string, Record<string, any>>;

/**
 * The custom documents of one registration, over `handle`, and the rule a
 * socket hears any document by. `answers`: may a custom doc answer a name by a
 * prefix this long (not where a longer one, a table document's or another
 * registration's, matches it).
 */
export function createCustomDocs<I, H>(opts: {
  defs: CustomDoc<any, I, H>[];
  handle: H;
  auth?: DeltaAuth<I>;
  publish: (channel: string, data: unknown) => void;
  log: ReturnType<typeof createLogger>;
  answers?: (docName: string, length: number) => boolean;
}) {
  const { handle, auth, log } = opts;
  type Def = CustomDoc<any, I, H>;
  const byPrefix = new Map(opts.defs.map((d) => [d.prefix, d]));
  const watched = new Set(opts.defs.flatMap((d) => d.watch));

  // Membership docs: one view per doc name and identity (without auth, per
  // name) -- its query's rows, and the subscribers who are that identity -- so
  // one identity's rows are never served to another. A view whose rows were
  // dropped (`forget`) is queried again. Recompute docs: their criteria and
  // subscribers by name, read again per subscriber, never kept.
  type View = { docName: string; def: Def; criteria: unknown; identity: I | undefined; doc: Rows | null; subs: Set<any> };
  const views = new Map<string, View>();
  const recomputes = new Map<string, { def: Def; criteria: unknown; subs: Set<any> }>();
  // a recompute that waits on a read runs after the one before it of the same name, so a slow one never lands last
  const chains = new Map<string, Promise<void>>();

  const identityKey = (identity: I | undefined): string =>
    auth?.asSqlArg && identity !== undefined ? String(auth.asSqlArg(identity)) : JSON.stringify(identity);
  const viewKey = (docName: string, identity: I | undefined): string =>
    auth ? `${docName}\u0000${identityKey(identity)}` : docName;
  const rowsOf = (def: Def, rows: Record<string, any[]>): Rows => Object.fromEntries(def.watch.map((c) => [c, toMap(rows[c] ?? [])]));
  const watching = (def: Def, ops: DeltaOp[]) => ops.some((op) => def.watch.includes(splitPath(op.path)[0]!));

  /** The custom doc a name is: the longest prefix it starts with, as a table document's (`_delta_find_doc`). */
  function find(docName: string): { def: Def; docId: string } | null {
    let found: Def | undefined;
    for (const [prefix, def] of byPrefix) {
      if (docName.startsWith(prefix) && (!found || prefix.length > found.prefix.length)) found = def;
    }
    return found && (opts.answers?.(docName, found.prefix.length) ?? true) ? { def: found, docId: docName.slice(found.prefix.length) } : null;
  }

  /** `client`, who is `identity`, opens `docName`: a recompute doc read as it, a membership doc its view, queried as it unless an open has. Null: not found. */
  function open(client: any, docName: string, { def, docId }: { def: Def; docId: string }, identity: I | undefined): MaybePromise<any> {
    if (def.recompute) {
      const criteria = recomputes.get(docName)?.criteria ?? def.parse(docId);
      return after(def.recompute(handle, criteria, identity), (doc) => {
        if (doc == null) return null;
        let held = recomputes.get(docName);
        if (!held) recomputes.set(docName, (held = { def, criteria, subs: new Set() }));
        held.subs.add(client);
        return doc;
      });
    }
    const key = viewKey(docName, identity);
    const criteria = views.get(key)?.criteria ?? def.parse(docId);
    const rows = views.get(key)?.doc ?? after(def.query!(handle, criteria, identity), (r) => rowsOf(def, r));
    return after(rows, (doc) => {
      const view = views.get(key) ?? { docName, def, criteria, identity, doc: null, subs: new Set() };   // an open of the same view may have landed meanwhile
      view.doc ??= doc;
      views.set(key, view);
      view.subs.add(client);
      return view.doc;
    });
  }

  /** Take `client` off `docName` (every name, when none); a doc nobody holds goes. */
  function leave(client: any, docName?: string): void {
    for (const [key, view] of views) {
      if ((docName === undefined || view.docName === docName) && view.subs.delete(client) && !view.subs.size) views.delete(key);
    }
    for (const [name, held] of recomputes) {
      if ((docName === undefined || name === docName) && held.subs.delete(client) && !held.subs.size) recomputes.delete(name);
    }
  }

  /** Drop the rows of `docName`'s views (every view's, when none): each is queried again (`reread`) before it is next told. */
  function forget(docName?: string): void {
    for (const view of views.values()) if (docName === undefined || view.docName === docName) view.doc = null;
  }

  /** Query again each view someone holds whose rows were dropped. */
  function reread(): void {
    for (const view of views.values()) {
      if (view.subs.size && !view.doc) void after(view.def.query!(handle, view.criteria, view.identity), (r) => { view.doc = rowsOf(view.def, r); });
    }
  }

  // A socket hears a document while it may open it (todo #17): an open asks
  // the gate and the document's `owns`, and so does every request; a change
  // told asks them again of each socket it is told to, and a socket refused is
  // let go of the document and told so -- `{ doc, error: { code, message } }`,
  // 401 from the gate, 404 from owns -- which the client acts on. Taken off a
  // document, or its session run out, it hears no more though it asks for
  // nothing. The gate is asked of each socket (cheap by contract), `owns` once
  // per identity per change. Without auth nothing is asked.
  type Asked = Map<string, MaybePromise<Refusal | null>>;

  /** Why `client` may no longer hear `docName`, or null. `as`: a membership view's identity, which the socket must still be. */
  function mayHear(client: any, docName: string, owns: Owns<I> | undefined, asked: Asked, as?: string): MaybePromise<Refusal | null> {
    let gated: I | { error: string };
    try { gated = auth!.gate(client); }
    catch (err) { log.error(`gate for ${docName}: ${message(err)}`); return { code: 401, message: "Authentication failed" }; }
    if (isAuthError(gated)) return { code: 401, message: gated.error };
    const key = identityKey(gated);
    if (as !== undefined && key !== as) return NOT_FOUND;   // the socket is someone else now: the view is not theirs
    if (!owns) return null;
    if (!asked.has(key)) {
      const no = (err: any) => { log.error(`owns ${docName}: ${message(err)}`); return NOT_FOUND; };
      let answer: MaybePromise<Refusal | null>;
      try { answer = after(owns(gated, docName), (yes) => (yes ? null : NOT_FOUND)); }
      catch (err) { answer = no(err); }
      asked.set(key, isPromise(answer) ? answer.catch(no) : answer);
    }
    return asked.get(key)!;
  }

  /**
   * Let go of `docName` each of `subs` that may no longer hear it: taken off
   * it (`dropped` says so to the backend) and told why. At once, unless an
   * `owns` answers with a promise.
   */
  function letGo(docName: string, subs: Set<any> | undefined, owns: Owns<I> | undefined, { as, dropped }: { as?: string; dropped?: () => void } = {}): MaybePromise<void> {
    if (!subs?.size) return;
    const asked: Asked = new Map();
    const go = (client: any, refused: Refusal | null) => {
      if (!refused) return;
      subs.delete(client);
      try { trackUnsubscribe(client, docName); } catch { /* the socket may be closing */ }
      dropped?.();
      sendTo(client, { doc: docName, error: refused });
      log.info(`let go of ${docName}: ${refused.code} ${refused.message}`);
    };
    const waiting: Promise<void>[] = [];
    for (const client of [...subs]) {
      const refused = mayHear(client, docName, owns, asked, as);
      if (isPromise(refused)) waiting.push(refused.then((r) => go(client, r)));
      else go(client, refused);
    }
    if (waiting.length) return Promise.all(waiting).then(() => {});
  }

  /** Before the custom docs watching what `ops` changed are told: let go each socket that may no longer hear one -- by its own def's owns. */
  function letGoWatching(ops: DeltaOp[]): MaybePromise<void> {
    const waiting: Promise<void>[] = [];
    const wait = (w: MaybePromise<void>) => { if (w) waiting.push(w); };
    for (const [name, held] of recomputes) if (watching(held.def, ops)) wait(letGo(name, held.subs, held.def.owns));
    for (const view of views.values()) if (watching(view.def, ops)) wait(letGo(view.docName, view.subs, view.def.owns, { as: identityKey(view.identity) }));
    const prune = () => {
      for (const [key, view] of views) if (!view.subs.size) views.delete(key);
      for (const [name, held] of recomputes) if (!held.subs.size) recomputes.delete(name);
    };
    if (!waiting.length) return prune();
    return Promise.all(waiting).then(prune);
  }

  /** Tell the custom docs watching what `ops` changed: a recompute doc read again, whole; a membership view, row by row. */
  function tell(ops: DeltaOp[]): void {
    for (const [name, held] of recomputes) if (held.subs.size && watching(held.def, ops)) recompute(name, held.def, held.criteria, held.subs);
    tellRows(ops);
  }

  /** Read a recompute doc again for each subscriber, as it (once per identity), and send it as a root replace -- after the last read of it. */
  function recompute(docName: string, def: Def, criteria: unknown, subs: Set<any>): void {
    const run = () => readEach(docName, def, criteria, subs);
    const before = chains.get(docName);
    const done = before ? before.then(run) : run();
    if (!isPromise(done)) return;
    const mine: Promise<void> = done.then(() => { if (chains.get(docName) === mine) chains.delete(docName); });
    chains.set(docName, mine);
  }

  function readEach(docName: string, def: Def, criteria: unknown, subs: Set<any>): MaybePromise<void> {
    const reads = new Map<string, MaybePromise<any>>();
    const failed = (err: any) => log.error(`recompute ${docName}: ${message(err)}`);
    let last: Promise<void> | undefined;   // once a read waits, the sends after it wait their turn
    for (const client of subs) {
      try {
        let identity: I | undefined;
        if (auth) {
          const gated = auth.gate(client);
          if (isAuthError(gated)) continue;   // signed out since it opened: never read it as nobody
          identity = gated;
        }
        const key = viewKey(docName, identity);
        if (!reads.has(key)) reads.set(key, def.recompute!(handle, criteria, identity));
        const doc = reads.get(key);
        const send = (d: any) => { if (d != null) sendTo(client, { doc: docName, ops: [{ op: "replace", path: "", value: d }] }); };
        if (isPromise(doc) || last) last = (last ?? Promise.resolve()).then(() => doc).then(send, failed);
        else send(doc);
      } catch (err) {
        failed(err);
      }
    }
    return last;
  }

  /**
   * A row the view holds, brought up to the row a write told (`now`, whole) in
   * the shape its query gave it: the fields it has, each as the query read it
   * -- one it read as text (`id::text`) stays text. Like with like, so a view
   * is told what changed of what it holds, never a field it has not.
   */
  const asHeld = (held: Record<string, unknown>, now: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(held).map(([f, h]) => {
      if (!Object.hasOwn(now, f)) return [f, h];
      const v = now[f];
      return [f, typeof h === "string" && v !== null && typeof v !== "object" && typeof v !== "string" ? String(v) : v];
    }));

  /** Each membership view, per row of `ops`: a row that arrives is an add, one that stays a replace of each field it holds that changed, one that leaves a remove. */
  function tellRows(ops: DeltaOp[]): void {
    const viewsOf = new Map<string, number>();
    for (const view of views.values()) if (view.subs.size) viewsOf.set(view.docName, (viewsOf.get(view.docName) ?? 0) + 1);
    for (const op of ops) {
      // A row at whatever path the write told it: /<coll>/<id>, or a single
      // document's root, /<coll>, whose id is its own. A told row is whole.
      const [coll, at] = splitPath(op.path) as [string, string | undefined];
      const row = (op as any).value as any | undefined;
      const id = at ?? (row?.id != null ? String(row.id) : undefined);
      if (id === undefined || !watched.has(coll)) continue;
      for (const view of views.values()) {
        const { def, doc } = view;
        if (!def.matches || !def.watch.includes(coll) || !view.subs.size || !doc) continue;
        const was = doc[coll]![id];
        let told: DeltaOp[];
        if (row != null && def.matches(coll, row, view.criteria, view.identity)) {
          const now = was != null ? asHeld(was, row) : row;
          doc[coll]![id] = now;
          told = was != null ? changedFields(joinPath(coll, id), was, now) : [{ op: "add", path: joinPath(coll, id), value: row }];
          if (!told.length) continue;
        } else if (was != null) {
          delete doc[coll]![id];
          told = [{ op: "remove", path: joinPath(coll, id) }];
        } else continue;
        // The only view of its name: its subscribers are the channel's. Else
        // each view's own subscribers, so one identity's rows reach only it.
        const change = { doc: view.docName, ops: told };
        if (viewsOf.get(view.docName) === 1) opts.publish(view.docName, change);
        else {
          const raw = JSON.stringify(change);
          for (const c of view.subs) sendTo(c, raw);
        }
      }
    }
  }

  return { size: byPrefix.size, find, open, leave, forget, reread, letGo, letGoWatching, tell };
}
