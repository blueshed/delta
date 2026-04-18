import { Pool } from "pg";
import { createWs } from "@blueshed/delta/server";
import {
  createDocListener,
  docTypeFromDef,
  registerDocType,
  defineDoc,
  type DocType,
} from "@blueshed/delta/postgres";
import { wireAuth, upgradeWithAuth } from "@blueshed/delta/auth";
import { jwtAuth, type User } from "@blueshed/delta/auth-jwt";
import type { DeltaOp } from "@blueshed/delta/core";
import { setup } from "./setup";
import index from "./client/index.html";

const ADMIN_URL =
  process.env.PG_ADMIN_URL ?? "postgres://{{DB}}:{{DB}}@localhost:5434/{{DB}}";
const APP_URL =
  process.env.PG_APP_URL ?? "postgres://{{APP_ROLE}}:{{APP_ROLE}}@localhost:5434/{{DB}}";
const JWT_SECRET = process.env.JWT_SECRET ?? "dev-secret-change-me";
const PORT = Number(process.env.PORT ?? {{PORT}});

// 1. Apply init_db/*.sql to the database (framework + users + tables + app policies).
await setup(ADMIN_URL);

// 2. Two pools: admin (auth mutates users), app-role (doc queries bind RLS).
const adminPool = new Pool({ connectionString: ADMIN_URL });
const appPool = new Pool({ connectionString: APP_URL });

// 3. WebSocket server + auth wiring.
const ws = createWs();
const auth = jwtAuth({ pool: adminPool, secret: JWT_SECRET });
wireAuth(ws, auth);
ws.upgrade = upgradeWithAuth(ws, auth);

// 4. Per-user 'todos:<userId>' doc type. Identity-checks and injects owner_id.
const genericTodos = docTypeFromDef(
  defineDoc("todos:", {
    root: "todos",
    include: [],
    scope: { owner_id: ":id" },
  }),
  appPool,
  { auth },
);

const myTodos: DocType<{ userId: number }, User> = {
  prefix: "todos:",
  parse(name) {
    const m = name.match(/^todos:(\d+)$/);
    return m ? { userId: Number(m[1]) } : null;
  },
  async open(ctx, name, msg, identity) {
    if (!identity || Number(identity.id) !== ctx.userId) return null;
    return genericTodos.open({}, name, msg, identity);
  },
  async apply(ctx, name, ops, identity) {
    if (!identity || Number(identity.id) !== ctx.userId) {
      throw Object.assign(new Error("Forbidden"), { code: 403 });
    }
    const safeOps: DeltaOp[] = ops.map((op) =>
      op.op === "add" && op.path === "/todos/-"
        ? { ...op, value: { ...(op.value as object), owner_id: ctx.userId } }
        : op,
    );
    return genericTodos.apply({}, name, safeOps, identity);
  },
};
registerDocType(myTodos);

// 5. LISTEN/NOTIFY fan-out.
await createDocListener(ws, appPool, { auth });

// 6. Serve.
const server = Bun.serve({
  port: PORT,
  routes: {
    "/": index,
    [ws.path]: ws.upgrade,
  },
  websocket: ws.websocket,
  development: { hmr: true, console: true },
});
ws.setServer(server);

console.log(`{{APP}} server listening on http://localhost:${server.port}`);
