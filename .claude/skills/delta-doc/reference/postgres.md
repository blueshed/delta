# Moving on to Postgres: dzql

SQLite is delta's last step of its own. Move on when servers share the data (each process told
live of another's writes), or people should see only their own (row-level security). That step
is **dzql**: delta compiled into Postgres, answering the same wire and the same cases
(`testing.md`).

The definitions stay as they are: `defineSchema` and `defineDoc` still come from delta. What was
`@blueshed/delta/postgres` (and `./pglite`, `./auth-jwt`) is dzql's:

```ts
// before
import { applyFramework, applySql, generateSql, createDocListener, docTypeFromDef } from "@blueshed/delta/postgres";
import { openPglite } from "@blueshed/delta/pglite";
import { jwtAuth } from "@blueshed/delta/auth-jwt";

// after
import { applyFramework, applySql, generateSql, createDocListener, docTypeFromDef } from "dzql/postgres";
import { openPglite } from "dzql/pglite";
import { jwtAuth } from "dzql/auth-jwt";
```

Carry the rows with `exportTables` / `importTables` (`backends.md`). From a shell, `dzql sql`
writes your tables, `dzql init` vendors the framework SQL, and `dzql migrate` runs migrations on
Postgres.
