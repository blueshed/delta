/**
 * fan-out workload -- what a write costs as the names ever opened grow, with
 * ten open (todo #73). A scoped document (`fanout:<owner>`) is found by the
 * names of its prefix, so each write asks every candidate whether it holds the
 * row. Ten are opened through a listener, as an app opens them; the rest were
 * opened once and closed, which leaves their names behind in `_delta_versions`.
 * The write's cost should not grow with them.
 */
import { Pool } from "pg";
import { createDocListener, defineDoc, defineSchema, docTypeFromDef, generateSql, registerDocType, clearRegistry } from "../../src/server/postgres";
import { createWs } from "../../src/server/server";
import { setLogLevel } from "../../src/server/logger";
import { computeStats, type Stats } from "../adapter";

const schema = defineSchema({
  fanout_items: { columns: { owner_id: "integer", value: "integer" }, temporal: false },
});
const doc = defineDoc("fanout:", { root: "fanout_items", include: [], scope: { owner_id: ":id" } });
const OPEN = 10;

/** One write's time (ms) through `fanout:1`, with `everOpened` names of the prefix left behind. */
export async function runFanout(pgUrl: string, everOpened: number): Promise<Stats> {
  setLogLevel("silent");
  const pool = new Pool({ connectionString: pgUrl, max: 4 });
  const ws = createWs();
  ws.setServer({ publish() {} });
  clearRegistry();
  registerDocType(docTypeFromDef(doc, pool));
  const listener = await createDocListener(ws, pool);
  try {
    await pool.query(generateSql(schema, [doc]));
    await pool.query("TRUNCATE fanout_items; DELETE FROM _delta_versions WHERE doc_name LIKE 'fanout:%'");
    await pool.query("INSERT INTO fanout_items (id, owner_id, value) SELECT g, g, 0 FROM generate_series(1, $1::int) g", [OPEN]);
    // opened once and let go: what delta_open leaves behind
    await pool.query("INSERT INTO _delta_versions (doc_name, version) SELECT 'fanout:' || g, 0 FROM generate_series($1::int, $2::int) g", [OPEN + 1, everOpened]);
    // ten open now, through the listener
    const client = { data: {}, readyState: 1, send() {}, subscribe() {}, unsubscribe() {} };
    for (let i = 1; i <= OPEN; i++) await ws.websocket.message(client, JSON.stringify({ id: i, action: "open", doc: `fanout:${i}` }));
    await Bun.sleep(100);

    const write = (n: number) => pool.query("SELECT delta_apply('fanout:1', $1)", [JSON.stringify([{ op: "replace", path: "/fanout_items/1/value", value: n }])]);
    for (let i = 0; i < 5; i++) await write(i);   // warm-up
    const samples: number[] = [];
    const until = performance.now() + 3000;
    while (samples.length < 10 || (performance.now() < until && samples.length < 500)) {
      const t0 = performance.now();
      await write(samples.length);
      samples.push(performance.now() - t0);
    }
    return computeStats(samples);
  } finally {
    await listener.destroy();
    await pool.query("DROP TABLE IF EXISTS fanout_items CASCADE; DELETE FROM _delta_docs WHERE prefix = 'fanout:'; DELETE FROM _delta_collections WHERE collection_key = 'fanout_items'; DROP SEQUENCE IF EXISTS seq_fanout_items; DELETE FROM _delta_versions WHERE doc_name LIKE 'fanout:%'; DELETE FROM _delta_ops_log WHERE doc_name LIKE 'fanout:%'");
    await pool.end();
  }
}
