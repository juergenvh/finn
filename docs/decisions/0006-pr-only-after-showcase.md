# ADR 0006 — PR-only workflow after first end-to-end showcase

- **Status:** accepted
- **Date:** 2026-05-07
- **Deciders:** Jürgen, Dixie
- **Supersedes:** —

## Context

From `e86f868` (initial commit, 2026-05-06) through `8817154`
(2026-05-07), every change to finn landed via direct push to
`main`. That was the right speed for a spike: design decisions
were happening live, code was uncommitted experiment, and the
overhead of branch + PR + review for every small fix would have
broken the rhythm.

By the evening of 2026-05-07 the situation was different:

- finn was deployed end-to-end on two machines (VM and Mac).
- The architecture had shape: 5 ADRs, separate connector layer,
  approval flow, schema, two setup guides.
- The first real-world bug had been triaged through the docs
  (lessons #4: idempotent-seed first-write-wins). Doc and code
  were finally tracking each other.
- A roadmap of substantive work was queued (CRUD UI, log
  surface, mention autocomplete, real Anthropic connector,
  tests, three open discoveries: rich rendering, streaming,
  session memory).

At that point, the cost-of-speed inversion happens: review,
branching, and explicit merge gates become net positive, not net
negative. They surface assumptions, they create review-time
breaks for second thoughts, and they leave a more legible commit
history.

## Decision

**Effective from this ADR's commit forward, all changes to
`main` go through pull requests.** Direct push is disabled at
the GitHub repo settings level (branch protection on `main`).

The rule applies to **everyone**: Jürgen as project owner,
Dixie as the agent doing most of the writing, any future
contributor.

## What this commits us to

1. **Branch protection on `main`.** GitHub's branch-protection
   rules disallow direct push, require PRs to merge.
2. **Branch naming** is documented in
   [`docs/contributing.md`](../contributing.md). For solo work,
   `feat/<short-slug>`, `fix/<short-slug>`, `docs/<short-slug>`,
   `chore/<short-slug>` are the conventions. No hard
   enforcement; just the convention.
3. **PR review** is by Jürgen (the human-in-the-loop is the
   only review at single-user scale). Dixie may open PRs and
   may not merge her own; the merge button is on Jürgen's side
   of the workflow.
4. **PR description** repeats the commit message template we
   already use: what changed, why, what was verified.
5. **Direct merge of long-running review-light branches is
   fine.** This is not a security workflow; it is a thinking
   pause. Squash-merges keep `main`'s history flat.

## What this does **not** commit us to

- CI gates. Tests do not exist yet; CI gates are a separate
  ADR if and when they do.
- Approval-required-from-someone-other-than-author. Single-user
  setup; making this absolute would block the workflow whenever
  Jürgen is offline.
- Forced linear history. Squash-merge is the default; merge
  commits are allowed if a branch deserves to be preserved as
  a unit.
- Issue templates, label discipline, or milestone assignments.
  These are optional and can be added later without revisiting
  this ADR.

## Why "after first end-to-end showcase"

The phrase pins the trigger for this rule, not just the date.
The trigger was 'finn is real enough that the cost of accidental
breakage exceeds the cost of a review pause.' A future contributor
asking 'why aren't we direct-pushing during a sprint' should be
able to read this ADR and understand: because we already crossed
the line where that was right.

If we ever start a *new* spike inside finn (a from-scratch sub-
project, a major refactor in a feature branch that won't merge
back for weeks), that branch can have its own faster
local rules — but the merge into `main` still goes through a PR.

## Consequences

- **No more direct pushes from Dixie's tooling to `main`.** When
  Dixie ships work she opens a branch, opens a PR, and asks for
  review. The CLI command pattern becomes:

  ```bash
  git checkout -b feat/<slug>
  # ... commits ...
  git push -u origin feat/<slug>
  gh pr create --title "<...>" --body "<...>"
  ```

- **The commit message convention stays.** PR title + body should
  reflect the eventual squash-merge commit's title + body, so
  the merged history reads like the originals.
- **Co-authored-by lines** survive squash because the bodies do.
- **Dependabot, future bots:** when they exist, they get the
  same treatment. No special-casing.
- **Tagging release versions** is a follow-up question, separate
  ADR if it ever matters.

## How to undo

If this rule turns out to be expensive (e.g. it makes
single-keystroke fixes painful enough that we routinely batch
them up and forget to ship them), open a successor ADR that
supersedes this one and explain why. Don't quietly bypass it;
that defeats both the gate and the discipline.
