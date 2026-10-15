/**
 * One pointer grammar: `splitPath` (src/core.ts, which `applyOps`, `dom-ops`
 * and every backend use) asked the pointer vectors (`pointerVectors`,
 * src/pointer-vectors.json), published in `./testing` so another parser
 * (dzql's, in Postgres) answers them alike.
 */
import { describe, expect, test } from "bun:test";
import { splitPath } from "../src/core";
import { pointerVectors } from "../src/testing";

/** The segments a pointer splits into, or null when it is malformed. */
const core = (path: string): string[] | null => {
  try { return splitPath(path); } catch { return null; }
};

describe("one pointer grammar", () => {
  for (const { pointer, segments } of pointerVectors) {
    test(`${JSON.stringify(pointer)}: in splitPath`, () => {
      expect(core(pointer)).toEqual(segments);
    });
  }
});
