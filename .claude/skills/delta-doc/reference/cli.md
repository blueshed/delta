# The CLI: `bunx @blueshed/delta`

As `tests/cli.test.ts` drives it: watch a document until an item is added, as an agent would.

```bash
DELTA_TOKEN=$T bunx @blueshed/delta watch items: --json --until "add /items" --for 10000
```

Always the scoped name: `bunx delta` runs an unrelated npm package. The code is `cli.ts`.

## Talking to a running server

```bash
bunx @blueshed/delta open  <docName>                # open, print, exit
bunx @blueshed/delta watch <docName>                # the state, then each change, a JSON line each
bunx @blueshed/delta delta <docName> '<opsJSON>'    # apply; prints the ops as applied
bunx @blueshed/delta call  <method> ['<paramsJSON>']
```

- The URL: `--url`, then `DELTA_WS_URL`, then a `.delta` file in the cwd, then
  `ws://localhost:${PORT:-3100}/ws`.
- `--token <t>` or `DELTA_TOKEN` (prefer the env: a flag shows in `ps`): sent as
  `call authenticate` on connecting, never in the URL. A refused token is the sign-in's 401.
- `--json`: one JSON line per event on stdout, nothing on stderr but errors; nothing is `null`;
  an error is one `{"error":{"code","message"}}` line on stderr, `code` the server's or `0` for
  the CLI's own (connection, bad argument).
- `--timeout <ms>` (default 10000, `0` for ever) for connecting and each answer; past it, exit 1
  with `no answer in <ms> ms: <what>`.
- Exit `0` done, `1` an error (the server's or the connection's), `2` a bad argument.
- `watch` ends (exit 0) at `--count <n>` changes, `--for <ms>` (from the start, before
  connecting; running out before the open is exit 1), or `--until "<op> <path>"` / `--until
  <path>`: an op at or under that path. Changes are row-level: name the row, not a field. An
  error told for the document, or the server closing, is exit 1. Without one it runs until Ctrl-C.
- `delta` asks with `inverse: true`, so it prints the ops as applied on every backend.

## Migrations

```bash
bunx @blueshed/delta migrations make src/db.ts --name quantity   # the next migration, from the schema
bunx @blueshed/delta migrate app.db --app leave --status   # which ran, which are pending
bunx @blueshed/delta migrate app.db --app leave             # run them
```

- The database: a SQLite file, one that is there. A `postgres://` URL or a folder is refused:
  Postgres's commands are dzql's (`dzql migrate`, `dzql sql`, `dzql init`: `postgres.md`).
  `--dir` is the migrations folder (default `./migrations`); `--app` the app whose list it is
  (default none); `--json` prints the answer as a line. Run it with the app stopped, or let the
  app run them at start-up (`migrations.md`).

## Sign-in

```bash
bunx @blueshed/delta link app.db 1   # a link to sign in as person 1: the first person's, on the server
```

- `--origin` names the site (else `ORIGIN`, else Railway's domain); `--opens` a page the link
  opens at. Postgres's is `dzql link` (`auth.md`).

## Skills for Claude Code

```bash
bunx @blueshed/delta install-skills              # → ./.claude/skills/
bunx @blueshed/delta install-skills --user       # → ~/.claude/skills/
bunx @blueshed/delta install-skills --dry-run    # say what it would do
```

- Copies this package's skill and those of `@blueshed/*` packages in `node_modules` (railroad
  ships `railroad` and `bun-route`).
- Another package's skills only when `package.json` names it: `"claudeSkills": ["@acme/widgets"]`
  (a skill is instructions an agent follows). Others are skipped, with a line saying so.
- Re-runs skip identical files; a locally edited copy is overwritten and kept as `.bak`; a file
  the source no longer has is removed (never a `.bak`, never outside the folders it installs).
  Re-run after upgrading a package that ships a skill.
