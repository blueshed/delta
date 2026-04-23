---
description: "Release a new version of @blueshed/delta (patch | minor | major)."
argument-hint: "patch | minor | major"
---

# /publish

Release pipeline. The bump level is `$ARGUMENTS` (one of `patch`, `minor`, `major`).

Execute the steps below **in order**. Abort on any failure without making further changes. Running this skill IS the authorisation to publish — complete it end-to-end, including the push, without pausing for mid-flight confirmation.

## 1. Validate arguments

If `$ARGUMENTS` is not exactly `patch`, `minor`, or `major`, abort and print:

```
Usage: /publish patch|minor|major
```

## 2. Preflight

Run these checks. If any fails, report the problem and stop.

1. **Branch is main.** `git rev-parse --abbrev-ref HEAD` must be `main`.
2. **Worktree is clean.** `git status --porcelain` must be empty.
3. **Up to date with origin.** Run `git fetch --quiet origin main`, then:
   - `git rev-list --count HEAD..origin/main` must be `0` (not behind).
   - `git rev-list --count origin/main..HEAD` must be `0` (not ahead). If ahead, tell the user to push their existing commits first.

## 3. CI gate

Run `bun run ci` (compose up → type check → full test → compose down). If it exits non-zero, abort — do not edit any files.

## 4. Compute next version

Read `package.json` and parse `.version` as semver `x.y.z`. Compute:

- `patch` → `x.y.(z+1)`
- `minor` → `x.(y+1).0`
- `major` → `(x+1).0.0`

Refuse if the current version isn't strict `\d+\.\d+\.\d+`.

## 5. Bump package.json

Rewrite `.version` in `package.json` to the new value. Preserve formatting (2-space indent, trailing newline).

## 6. Promote CHANGELOG

Open `CHANGELOG.md`. There must be a `## [Unreleased]` section — that's the author's record of what's shipping. If it's missing, **abort** and tell the user to write the Unreleased section first; revert the `package.json` bump before exiting.

Replace the literal line `## [Unreleased]` with `## [<new-version>] — <today in YYYY-MM-DD>`.

## 7. Commit and tag

```
git add package.json CHANGELOG.md
git commit -m "Release v<new-version>"
git tag -a v<new-version> -m "Release v<new-version>"
```

## 8. Push

Run:

```
git push origin main --follow-tags
```

This is the moment the release goes public. If the push fails (non-fast-forward, auth rejection, hook failure), report the exact error and stop — do NOT retry with `--force`, `--no-verify`, or any other bypass flag. The local commit and tag remain; the user can investigate and decide how to recover.

## 9. Report

Report to the user in this shape:

```
Released and pushed v<new-version>.

  commit  <short-sha> "Release v<new-version>"
  tag     v<new-version>

Inspect:
  git show v<new-version>
```

CI will now pick up the tag and run the publish workflow.
