// Per-user DocType wrapper. Drop this pattern into server.ts alongside
// createDocListener. Substitute {{COLL}} (collection key) and {{USER_COL}}
// (owner column in your table) for the app.
//
// The wrapper does two things docTypeFromDef alone cannot:
//   1. Rejects open/apply when the authenticated identity.id doesn't match
//      the user id parsed from the doc name (defence in depth; the RLS
//      policy also catches this at the DB, but the 404 keeps it cheap).
//   2. Injects owner_id on add ops so a client can't forge rows for other
//      users. WITH CHECK on the policy would catch this too, but it's
//      better as a structural invariant than a policy-rejection round-trip.
import {
  docTypeFromDef,
  defineDoc,
  registerDocType,
  type DocType,
} from "@blueshed/delta/postgres";
import type { User } from "@blueshed/delta/auth-jwt";
import type { DeltaOp } from "@blueshed/delta/core";

const generic = docTypeFromDef(
  defineDoc("{{COLL}}:", {
    root: "{{COLL}}",
    include: [],
    scope: { {{USER_COL}}: ":id" },
  }),
  appPool,
  { auth },
);

const myType: DocType<{ userId: number }, User> = {
  prefix: "{{COLL}}:",
  parse(name) {
    const m = name.match(/^{{COLL}}:(\d+)$/);
    return m ? { userId: Number(m[1]) } : null;
  },
  async open(ctx, name, msg, identity) {
    if (!identity || Number(identity.id) !== ctx.userId) return null;
    return generic.open({}, name, msg, identity);
  },
  async apply(ctx, name, ops, identity) {
    if (!identity || Number(identity.id) !== ctx.userId) {
      throw Object.assign(new Error("Forbidden"), { code: 403 });
    }
    const safeOps: DeltaOp[] = ops.map((op) =>
      op.op === "add" && op.path === "/{{COLL}}/-"
        ? { ...op, value: { ...(op.value as object), {{USER_COL}}: ctx.userId } }
        : op,
    );
    return generic.apply({}, name, safeOps, identity);
  },
};

registerDocType(myType);
