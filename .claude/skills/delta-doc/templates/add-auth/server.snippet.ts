// Add auth to an existing delta server. Paste this block after createWs()
// and before any registerDocType calls. Substitute {{DB}} / {{APP_ROLE}}.
//
// Requires init_db/002-users.sql to be present (run `delta init --with-auth`).
import { Pool } from "pg";
import { wireAuth, upgradeWithAuth } from "@blueshed/delta/auth";
import { jwtAuth } from "@blueshed/delta/auth-jwt";

const ADMIN_URL = process.env.PG_ADMIN_URL ?? "postgres://{{DB}}:{{DB}}@localhost:5434/{{DB}}";
const APP_URL   = process.env.PG_APP_URL   ?? "postgres://{{APP_ROLE}}:{{APP_ROLE}}@localhost:5434/{{DB}}";

const adminPool = new Pool({ connectionString: ADMIN_URL });
const appPool   = new Pool({ connectionString: APP_URL });

const auth = jwtAuth({ pool: adminPool, secret: process.env.JWT_SECRET! });
wireAuth(ws, auth);                         // registers login / register / authenticate / logout as WS "call" actions
ws.upgrade = upgradeWithAuth(ws, auth);     // reads cookies / Authorization header during handshake

// Pass { auth } into every docTypeFromDef(...) so queries wrap in withAppAuth
// and RLS policies bind to app.user_id.
// Pass { auth } into createDocListener(ws, appPool, { auth }) so open/delta
// messages go through the gate.
