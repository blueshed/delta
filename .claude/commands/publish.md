---
description: "Release a new version of @blueshed/delta (patch | minor | major)."
argument-hint: "patch | minor | major"
---

# /publish

The release procedure shared by railroad, delta and eta: the same steps in all three, with only
the table below differing. The bump level is `$ARGUMENTS` (`patch`, `minor` or `major`).

| | |
|---|---|
| Package | `@blueshed/delta` |
| Published | npm, public |
| Gate | `bun run ci` |
| Skills stamped with the version | `.claude/skills/delta-doc/SKILL.md` |

Run the steps in order. Stop at the first failure without changing anything further. Running this
command is the authorisation to release -- carry it through to the end, the push included, without
asking again. Bun only: never `npm` or `npx`, and never `npm publish` from here (CI does it).

## 1. Arguments

`$ARGUMENTS` must be exactly `patch`, `minor` or `major`; otherwise stop and print
`Usage: /publish patch|minor|major`.

## 2. Preflight

1. The branch is `main`: `git rev-parse --abbrev-ref HEAD`.
2. The working tree is clean: `git status --porcelain` prints nothing.
3. Not behind origin: `git fetch --quiet origin main`, then `git rev-list --count HEAD..origin/main`
   is `0`. Commits ahead of origin are fine -- they go out with the release in step 7.
4. `CHANGELOG.md` has a `## [Unreleased]` section with something under it. It is the record of
   what is shipping, written as the work landed; if it is missing or empty, stop and say so.

## 3. Gate

Run the gate command in the table. If it fails, stop -- no file has been edited yet.

## 4. Bump

Parse `.version` in `package.json` as strict `x.y.z` (refuse anything else) and compute the next:
`patch` → `x.y.(z+1)`, `minor` → `x.(y+1).0`, `major` → `(x+1).0.0`. Write it back, keeping the
2-space indent and the trailing newline.

## 5. Stamp

In each skill listed in the table, replace the frontmatter line `version: x.y.z` with the new
version (insert it after `name:` if it is missing). Change nothing else in the skill.

## 6. Promote the changelog

Replace the line `## [Unreleased]` with `## [<new version>] - <today, YYYY-MM-DD>`, and put a fresh,
empty `## [Unreleased]` above it.

## 7. Commit, tag, push

```
git add package.json CHANGELOG.md .claude/skills/delta-doc/SKILL.md
git commit -m "Release v<new version>"
git tag -a v<new version> -m "Release v<new version>"
git push origin main --follow-tags
```

If the push is refused (not a fast-forward, auth, a hook), report the exact error and stop. Never
retry with `--force`, `--no-verify` or any other bypass: the commit and tag stay local for the
person to decide.

## 8. GitHub release -- this is what publishes to npm

`.github/workflows/publish.yml` runs on `release: published`, not on a tag. A tag alone publishes
nothing.

```
gh release create v<new version> -t v<new version> --notes-from-tag
```

If `gh` is missing or not signed in, report the exact error and stop: the release needs a person.

## 9. Confirm on npm

```
gh run watch $(gh run list --workflow=publish.yml --limit 1 --json databaseId --jq '.[0].databaseId') --exit-status
bun info @blueshed/delta version
```

The version npm reports must be the new one. If the workflow fails or npm still has the old
version, report the run's URL and stop.

## 10. Report

```
Released @blueshed/delta@<new version>.

  commit   <short sha>
  tag      v<new version>
  release  https://github.com/blueshed/delta/releases/tag/v<new version>
  npm      @blueshed/delta@<new version>
```
