/**
 * One walk rule: `planWalk` (src/server/ledger.ts, SQLite and the JSON file)
 * asked the walk vectors (`walkVectors`, src/walk-vectors.json), published in
 * `./testing` so another planner (dzql's, in Postgres) answers them alike.
 */
import { describe, test, expect } from "bun:test";
import { joinPath, splitPath } from "../src/core";
import { planWalk } from "../src/server/ledger";
import { walkVectors, type WalkVector } from "../src/testing";

const { schema, vectors } = walkVectors;
const children = Object.entries(schema).filter(([, t]) => typeof t.parent === "string");

/** The rows removing `key` would take with it: its children in the document, and theirs. */
const under = (current: any) => (key: string): string[] => {
  const [coll, id] = splitPath(key);
  return children.filter(([, t]) => t.parent === coll).flatMap(([child]) =>
    Object.values<any>(current[child] ?? {}).filter((r) => String(r[`${coll}_id`]) === id).flatMap((r) => {
      const at = joinPath(child, String(r.id));
      return [at, ...under(current)(at)];
    }));
};


const core = (v: WalkVector) => {
  const plan = planWalk(v.entry, v.current, under(v.current));
  return { ops: plan.ops, ...(plan.conflict.length ? { conflict: plan.conflict } : {}) };
};

describe("one walk rule", () => {
  for (const v of vectors) {
    test(`${v.name}: in planWalk`, () => {
      expect(core(v)).toEqual(v.expected);
    });
  }
});
