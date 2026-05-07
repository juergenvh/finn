# finn — contributing

This is the workflow for changes to `juergenvh/finn`. The rules
were locked in by [ADR-0006](decisions/0006-pr-only-after-showcase.md);
this file is the operational reference.

## tl;dr

```bash
git checkout -b <type>/<slug>
# do the work, commit
git push -u origin <type>/<slug>
gh pr create --title "<...>" --body "<...>"
# Jürgen reviews and merges
```

Direct pushes to `main` are blocked at the repository level.

## Branch naming

| Prefix    | When to use it                                            |
| --------- | --------------------------------------------------------- |
| `feat/`   | new capability, even if small                             |
| `fix/`    | a bug fix; usually links a lessons.md or an issue         |
| `docs/`   | README, ADRs, setup guides, lessons — no code change      |
| `chore/`  | tooling, deps, build, repo config; nothing user-visible   |
| `refactor/` | structural change, no behaviour change                  |

Slugs are short and descriptive: `feat/crud-ui`,
`fix/seed-base-url`, `docs/lesson-vite-ipv6`. Avoid encoding
issue numbers; PRs already link issues, branches don't need to.

## Pull-request discipline

### Title

Follows the same convention as commit messages — Conventional-
ish prefix, lowercase, imperative:

- `feat: channel + agent CRUD UI`
- `docs: lessons from the Mac-host setup session`
- `fix(connector): handle empty FINN_OPENCLAW_API_KEY`

### Body

The PR body becomes the squash-merge commit message. Keep it
the way the project's existing commits already read:

```
## What

<one paragraph: the change in plain language>

## Why

<context, ADR pointers, or links to issues>

## How verified

<svelte-check, build, smoke-tested with X, or 'docs only'>
```

### Linked issues

If the PR closes an issue, add `Closes #N` near the bottom of
the body. GitHub auto-closes on merge.

### Co-authored-by

Authored as Dixie, with `Co-authored-by: Jürgen <…>` for
real collaborations. Survives squash because it lives in the
PR body.

## Reviewing

For now, reviews are Jürgen's responsibility. The expected
review pass:

- Does the change match the description?
- Are the new docs / ADRs internally consistent with existing
  ones?
- Does it preserve the invariants pinned by current ADRs
  (append-only messages, scoped operator headers, prefixed
  ids, …)?
- Has it been smoke-tested? (The PR body should say.)

This is **not** a security review and **not** a code-style
review beyond what feels right. It is a "would I be happy
finding this in `git log` six months from now" review.

## Merging

- Default: **squash and merge**, with the PR title+body as the
  commit message.
- Exception: a branch that deserves to be remembered as a unit
  (e.g. a refactor with multiple discrete commits each worth
  preserving) can use **rebase and merge**. Avoid merge
  commits.
- After merge, delete the branch.

## What does NOT need a PR

Genuinely nothing day-to-day. The exception is the bootstrap
of this very workflow — the commit that introduces ADR-0006,
this `contributing.md`, and turns on branch protection — was
allowed to land directly. From that commit forward, everything
else goes through a PR.

## Why this discipline now

ADR-0006 has the long answer. The short version: finn passed
the line where 'two more keystrokes to merge' costs less than
'one accidental breakage because nobody else looked.'

If the rule ever feels wrong, the response is to open a
successor ADR, not to quietly bypass.
