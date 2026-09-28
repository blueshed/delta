/**
 * Another process on the same SQLite file (tests/sqlite-processes.test.ts):
 * the path's documents over it, driven by one JSON command per line on stdin,
 * each answered with one JSON line on stdout.
 *
 *   { do: "call", action, msg }  -> the backend's answer
 *   { do: "hold", ms, sql }      -> takes the write lock, runs `sql`, answers
 *                                   "held", and commits `ms` later
 */
import { Database } from "bun:sqlite";
import { registerDocs } from "../../src/server/sqlite";
import { createLocal } from "../../src/server/local";
import { setLogLevel } from "../../src/server/logger";
import { pathDocs, pathSchema } from "./path";

setLogLevel("silent");
const db = new Database(process.argv[2]!);
const local = createLocal();
registerDocs(local.server, db, pathSchema, pathDocs, [], { ledger: true });
const say = (answer: unknown) => process.stdout.write(`${JSON.stringify(answer)}\n`);
say("ready");

for await (const line of console) {
  const cmd = JSON.parse(line);
  if (cmd.do === "call") say(await local.call(cmd.action, cmd.msg));
  else if (cmd.do === "hold") {
    db.run("BEGIN IMMEDIATE");
    db.run(cmd.sql);
    say("held");
    setTimeout(() => db.run("COMMIT"), cmd.ms);
  }
}
