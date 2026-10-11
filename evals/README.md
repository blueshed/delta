# Skill evaluations

`delta-doc.json` holds three scenarios for the shipped `delta-doc` skill, each aimed at a trap
the skill exists to prevent. They are not run by `bun test` and do not ship to npm.

To run one by hand: in a fresh, empty folder, start a new Claude Code session with the skill
loaded (copy `.claude/skills/delta-doc/` into the folder's `.claude/skills/`), give it the
`query` word for word, then check the code it writes against each line of
`expected_behavior`. Every line should hold. Run each scenario with and without the skill to
see what the skill adds.
