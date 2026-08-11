# A complete skill list, in columns that fit

Two defects, both visible in the first real screenshot of the dashboard.

## The dashboard undercounts skills

`[Skills] 18 · ~40k tok if all read`, on a machine with 22 skills loaded.
Missing: `merge`, `open-pr`, `rebase`, `worktree` — every skill whose
frontmatter carries `disable-model-invocation: true`.

The cause is the data source. `dashboard/skills.ts` recovers skills by parsing
the `<available_skills>` block out of `ctx.getSystemPrompt()`, and
`formatSkillsForPrompt` builds that block from
`skills.filter((s) => !s.disableModelInvocation)` (`core/skills.js:258`). A
skill excluded from the model's prompt is invisible to us.

The count is wrong, the token total understates the real cost, and — worst —
the omitted skills are precisely the ones invoked *by name*. A menu that hides
the entries you have to type is backwards.

No test caught it because every fixture skill was model-invocable.

## Skills come from `getCommands()` instead

`ctx`/`pi.getCommands()` already backs `[Prompts]`. For skills it returns
(`core/agent-session.js:1837`):

```js
this._resourceLoader.getSkills().skills.map((skill) => ({
    name: `skill:${skill.name}`,
    description: skill.description,
    source: "skill",
    sourceInfo: skill.sourceInfo,
}))
```

Straight from the resource loader, unfiltered — the same list pi prints in its
own `[Skills]` section. `createSkillSourceInfo` (`core/skills.js:90`) builds
that `SourceInfo` from the skill's `filePath`, so `sourceInfo.path` is the
absolute `SKILL.md`: `measureSkills` and `skillScope` keep working untouched,
and the previously hidden skills get size bars like everything else.

This also improves the dependency. Parsing `<available_skills>` reads prompt
text pi never promised to keep stable; `SlashCommandInfo` is a declared type in
pi's `.d.ts`. `parseSkills` and its round-trip test against
`formatSkillsForPrompt` — the drift detector that guarded the weaker
dependency — are deleted with it.

`parseContextFiles` stays: `[Context]` still comes from the system prompt.

**Not doing:** marking which skills the model can auto-invoke. It is real
information — a `disable-model-invocation` skill never fires on its own — but
the only source for it is the system prompt, and reintroducing that dependency
for a label is not worth it. Additive later.

## Columns are sized for the terminal, not the names

At 183 columns the skills block wastes half the screen:

```
    coordinator                                              ▂    finish-pr
```

`columnCount` caps at 3, so `labelWidth = floor((183 - 4 - 4) / 3) - 2 = 56`.
Every name is padded to 56 characters, so a bar sits up to 45 spaces from the
name it belongs to and reads as belonging to the next column.

The column width should follow the names, not the terminal:

```
cellWidth = min(longest label, MAX_LABEL) + BAR_SUFFIX
columns   = clamp(1, MAX_COLUMNS, floor((width - indent + GUTTER) / (cellWidth + GUTTER)))
```

`MAX_LABEL = 40` keeps one pathological name from starving the rest;
`MAX_COLUMNS = 6` keeps a very wide terminal from becoming a wall of narrow
columns. At 183 columns with ~30-character names that yields five tight
columns; at 120 it still yields three; below 90, one.

`columnCount(width)` loses its meaning as a pure function of width and is
replaced by a helper taking the cells as well. The width invariant is
unchanged and its tests must keep detecting: no rendered line may exceed the
terminal width.

## Tests

- A fixture skill with `disable-model-invocation: true` must appear in the
  rendered screen and in the count. This gap existed only because no fixture
  had one.
- Skills sourced from `getCommands()`: the `skill:` prefix is stripped, the
  description survives, and `sourceInfo.path` drives size and scope.
- Column layout at 60/90/120/183 columns: bars sit one space after their
  label, and no line exceeds the width — re-verified by the existing gutter
  mutation, which must still fail.
