# finn — lessons

Mistakes shipped, surprising failure modes encountered, and what we
changed in response. Append-only, numbered, dated.

Format borrowed from `juergenvh/wintermute/LESSONS.md`:

> **NN. <slug>** — <one-line summary>
> *Date.* What happened. Symptom. Root cause. Fix. (Optional: meta
> note on what kind of mistake this was.)

The point of this file is to make it cheap to *not* repeat a class
of mistake. If a recurring footgun is documented here and the next
person hits the same one, that is an indictment of the doc rather
than the person — fix the doc.

---

## 1. README escape sequences in markdown — 2026-05-07

When writing the initial finn README, em-dashes (`—`) and one set
of typographic quotes were emitted as literal `\u2014` / `\"`
sequences in the markdown text rather than as the actual UTF-8
characters. 13 occurrences total.

**Symptom:** README rendered correctly nowhere — the literal string
`\u2014` appeared in place of every em-dash. Caught by the user on
visual inspection at `git push` time.

**Root cause:** Output produced via a tool path that JSON-escapes
strings before writing, but the `write` operation expects already-
decoded UTF-8 text. When the same hand writes "—" interactively,
no escaping happens; when the same hand writes a long markdown
document via a tool, the escape leak is invisible at composition
time.

**Fix:** Two layers.

1. Replaced the literal sequences with proper UTF-8 in commit
   `77e8edc`.
2. Added a pre-commit habit: after every markdown write, run
   `grep -P '\\u[0-9a-fA-F]{4}|\\\\["nrt]' file.md` as a smoke
   check. Zero hits = clean.

**Meta:** This is a tooling/composition hazard, not a knowledge
gap. The remediation is mechanical (the grep), not educational.

---

## 2. SvelteKit scaffolder overwrites existing files — 2026-05-07

Running `npx sv create --template minimal --types ts --no-add-ons .`
in a non-empty directory (which already had a curated README and
.gitignore from an earlier commit) silently overwrote both files
with the SvelteKit template defaults.

**Symptom:** After scaffolding, `README.md` was the SvelteKit
welcome text instead of finn's design document; `.gitignore` was
the minimal SvelteKit set instead of the carefully curated finn
patterns (db files, secrets, exports, etc.).

**Root cause:** `--no-dir-check` was passed to suppress the
"directory not empty" prompt. That flag is mainly meant for
non-interactive mode in CI, not for "preserve existing files
when their names collide with the template."

**Fix:** Restored `README.md` from `git checkout`. Manually merged
the template's `.gitignore` patterns into the existing curated set.

**Meta:** Not a bug in `sv` — the flag does what it says on the
tin. But the surface that a user typing the command sees does
not warn them that their files are about to die. For a tool that
is mostly used in fresh empty directories, this is fine; for the
rare cases (like ours) where you intentionally scaffold *into* a
repo that already has shape, the cost is high.

For future similar work: either scaffold into a tmp directory and
copy files across, or commit current files first so a `git checkout`
recovery path exists. We did the latter accidentally and it saved
us.

---

## 3. Production server.js with unverified import paths — 2026-05-07

The first iteration of `server.js` imported the WS attach helper
and connector registry from speculative paths in `build/server/...`
that I had not actually verified against an `npm run build` output.
The paths were marked as `// PATH UNVERIFIED` in comments but the
file would not have run.

**Symptom:** None during development (we only ran `npm run dev` for
a while). Caught on the first deliberate `npm run build && node
server.js` test, several hours later, when the imports failed
because the paths did not exist in the actual build output.

**Root cause:** SvelteKit's `adapter-node` only bundles modules
*reachable from a route or hook*. The WS attach helper lives next
to `server.js`, not inside a SvelteKit route, so it was never in
the build output. The speculative import paths assumed a layout
adapter-node does not produce.

**Fix:** Introduced a parallel TypeScript build for server-side
modules outside the SvelteKit graph: `tsconfig.server.json`
compiles `src/lib/server/**/*.ts` into `dist-server/`. `server.js`
now imports from there, which is a tree we control and verify.
`npm run build` runs both compilations.

Documented in `src/lib/server/README.md` so the convention is
discoverable for the next person adding a server-side module.

**Meta:** "Verbatim-or-nothing" applies to import paths too. When
you write a file path you have not opened, you are guessing,
even if the guess is structurally plausible. Mark the guess
explicitly (we did) and verify before declaring it works (we
did, the second time around).

---

## 4. Idempotent seed is first-write-wins — 2026-05-07

`scripts/seed.ts` is idempotent on the agent's `name` column: if
a `dixie` row already exists, the seed leaves it alone. This is
correct behaviour for re-running the seed without duplicating
rows. But it has a sharp edge: the row's `config` is *also* not
re-written, so the URL captured at first insert stays in the DB
forever.

**Symptom:** On the Mac host, after `npm install && npm run
db:migrate && npm run db:seed && npm run dev`, sending a message
in the `spike` channel produced `agent <id> error: fetch failed`
in the chat. A direct `curl` to the same URL with the same token
worked. Connector code was correct.

**Root cause:** The seed had been run *twice* on the Mac. The
first run was in a shell that did not have `FINN_OPENCLAW_BASE_URL`
exported, so the seeded `dixie.config.base_url` ended up as the
loopback default `http://127.0.0.1:18789/v1` — which is the
gateway's address from the *VM's* perspective, not the Mac's.
The second run was idempotent and did nothing. Connector then
tried to reach the loopback URL on the Mac, where no gateway is
listening.

**Fix:**

1. SQL one-liner to repair an existing row:
   ```sql
   UPDATE agents
     SET config = json_set(config, '$.base_url', 'http://192.168.64.2:18789/v1')
   WHERE name = 'dixie';
   ```
   No restart needed — the connector reads agent config from the
   DB on every call.

2. `docs/setup-mac.md` and `docs/setup.md` now have a prominent
   ⚠️ block before the seed step explaining the first-write-wins
   semantics, with the SQL fix and a verify step.

**Meta:** Idempotency is a contract about *not duplicating*, not
about *staying in sync with the world*. The seed is not a config
manager. When a row's content depends on environment that may
change between seed runs, the user has to know (or the seed has
to grow into a config-management script with proper diff
semantics, which is a different job).

---

## 5. Vite binds IPv6 `::1` only on macOS — 2026-05-07

`npm run dev` on macOS binds the dev server to `::1`, not
`127.0.0.1`. `localhost` resolves to `::1` first via the system
resolver, so browsers work; but a plain `curl http://127.0.0.1:5173/`
returns `000` (connection refused).

**Symptom:** During Mac-host setup triage, the user ran
`curl http://127.0.0.1:5173/api/channels` and got nothing. This
looked like the server wasn't responding. Five minutes of confusion
followed before checking with `localhost` instead.

**Root cause:** Vite's default behaviour on macOS — picks the
first IPv6 address it can bind to. Not specific to finn.

**Fix:** None needed in finn itself. Documented as a triage step
in `docs/setup-mac.md` §"Troubleshooting": when in doubt, use
`localhost` (which the browser uses anyway). If a script needs
to hit IPv4 specifically, pass `--host 127.0.0.1` to the dev
script.

**Meta:** Operator surprise, not a bug. Worth writing down because
the failure looks like the server is broken when it is not.

---

## 6. Vite duplicates module instances between plugin host and SSR graph — 2026-05-07

While wiring CRUD endpoints, REST handlers needed to push WS
`state_changed` events live to all connected browsers. The first
implementation kept the active `WebSocketServer` in module scope
inside `src/lib/server/ws/attach.ts` — obvious place, would work
in every other Node app I have written.

It didn't work in dev. Live broadcasts silently no-op'd.

**Symptom:** Manual REST POST against the dev server returned
`201 Created`, the DB had the row, but a connected WebSocket
client saw zero events. No errors in the server log. No errors
in the client console. Just nothing.

**Root cause:** Vite has two module-resolution contexts in dev:

1. Vite's plugin host loads `dev-plugin.ts`, which calls
   `attachWebSocketServer()`. From here, the plugin host has
   its own copy of `attach.ts`'s module state (including
   `activeWss`).
2. SvelteKit's SSR graph loads the route handlers under
   `src/routes/api/.../+server.ts`. They import the same
   `attach.ts`, but **a different copy** with its own
   `activeWss = null`.

The REST handlers were calling `broadcastStateChange()` on the
SSR-side copy, where `activeWss` was permanently null. The
broadcast hit the no-op guard and returned silently.

Production never has this problem because `server.js` collapses
everything into one shared module graph.

**Fix:** Park the reference on `globalThis` (process-wide,
shared across both module graphs). Six lines, fully documented
in `attach.ts` and ADR-0008.

**Meta:** I tried unifying the import specifiers between
`dev-plugin.ts` and the route handlers first — my first
hypothesis was that Vite resolution could be tricked into one
cache entry. Wrong; the dual cache is a property of the host,
not of the path.

The lesson is broader than the fix: **dev-mode and prod-mode
module graphs are not the same thing.** When a file is loaded
through multiple resolver paths in dev, module-scope state
should be assumed to be plural unless proven otherwise. This
applies to any bundler with a plugin system (Vite, esbuild,
Rollup, webpack), not just Vite. If a piece of state genuinely
must be shared across loader contexts, `globalThis` is the
right tool, not module scope.

---

## 7. OpenAI streaming usage opt-in — 2026-05-09

Built per-message token-count display (issue #43 part B,
PR #50): SSE-parser learned a discriminated-union shape with
a `usage` variant, dispatcher captured it, schema gained
`tokens_json`, UI rendered a footer. End-to-end green
locally, merged.

**Symptom:** No footer ever appeared in production. Tested
both fresh agent replies and existing rows; backend
clearly worked, code clearly worked, but no `usage` event
ever made it through the parser.

**Root cause:** OpenAI's streaming SSE spec **does not
include the `usage` block in chunks unless the request
explicitly opts in via `stream_options: { include_usage: true }`**.
Without the flag, the stream ends right after the last
`finish_reason` chunk and goes straight to `[DONE]`. The
parser was correct; it just never had a `usage`-bearing
frame to parse, because the request never asked for one.

I had read the OpenAI streaming-format reference for the
*frame shapes* (which is where the `usage` field is
documented) but not for the *request opt-ins*. The flag is
in the spec, plainly visible — I'd internalised "usage
arrives on the last chunk" without the necessary "if you ask
for it" caveat.

**Fix:** PR #51, two two-line additions to `openclaw.ts` and
`openai-compatible.ts` adding the `stream_options` field. No
schema change; existing post-#50 rows with NULL `tokens_json`
stay that way; new replies populate it.

Verified by curl-ing the local gateway with and without the
flag and capturing both responses verbatim into the PR
description, after the fix.

**Meta — the lesson behind the lesson.** For features that
involve a third-party wire contract, **smoke-curl the real
endpoint before opening the PR**, not only after merging it.
Reading the spec correctly is necessary but not sufficient;
specs document what's *possible*, not what a given request
*actually* triggers. Two minutes of `curl --no-buffer` saves
two PRs.

---

## 8. ADR phase plans soft-framed as "later" — 2026-05-09

ADR-0013 broke the streaming + sequencing work into five
phases. Phase 3 ("same shape on the approval-routing relay
path") was framed as a separate PR after phase 2, in the
section header "Implementation phases (suggested)".

**Symptom:** After phase 2 merged (PR #42), Jürgen reported
that approving an agent-to-agent message no longer produced a
streaming bubble — it sat silent until all relays settled and
then dropped at once. UX inconsistency between the user-message
path (streaming, since #42) and the approve-and-relay path
(still non-streaming, scheduled for "later").

**Root cause:** "Separate PR, can wait" reads to the human
maintainer as "low-priority follow-up" and to the user as a
visible regression the moment phase 2 ships. The two paths are
both user-visible flows that shape user expectations together;
shipping one without the other creates a mental "is this a bug
or a feature?" question that doesn't go away until the second
PR lands.

**Fix:** Phase 3 shipped as PR #45 the same day. ADR-0013's
"Implementation phases" section was rewritten in the post-
phase-3 sweep to describe what was actually shipped, with a
"Departure from the plan" note explicitly calling out the
soft-framing.

**Meta — the lesson for future ADR phase plans.** When a
phase change makes two user-visible paths visibly differ from
each other, ship them in tighter sequence (single PR, or
back-to-back PRs landing the same day). Phase boundaries are
fine for risk-isolation in the implementation graph; they are
**not** appropriate UX boundaries to land separately. Re-read
phase plans through the question "if we stop here, will users
notice?" — if yes, the phase boundary was drawn wrong.

---

## 9. DOMPurify v3 ships its own types — 2026-05-09

Building rich-rendering (PR #58, ADR-0016), I reflexively
installed `@types/dompurify` as a devDep alongside the
`dompurify` runtime dep. That path is correct for many libraries
that don't ship types of their own — but `dompurify@3.x` ships
TypeScript declarations directly in its package.

**Symptom:** Three `svelte-check` errors immediately after
adding the import:
```
Cannot find namespace 'DOMPurify'
Type 'TrustedHTML' is not assignable to type 'string'  (×2)
```

The first one was the giveaway. v3's types export `Config` as a
**named type export**, not as a `DOMPurify.<Config>` namespace;
the v2 `@types/dompurify` package declares the legacy namespace
shape and shadows the bundled v3 types when both are present.
Result: the code compiled against the wrong declaration file
and the `sanitize()` overloads picked the wrong return type
(`TrustedHTML | string` instead of just `string`).

**Fix:** Two steps, in this order.

1. `npm uninstall @types/dompurify` to remove the v2-shaped
   shadow.
2. Switch the import to the named-export form:
   ```ts
   import DOMPurify, { type Config as DOMPurifyConfig } from 'dompurify';
   ```

After that, types resolved correctly and svelte-check ran
clean.

**Meta — the lesson behind the lesson.** When adding a typed
library to a project, **check the package's own
`*.d.ts` first** before reaching for `@types/<name>`. Most
modern libraries (anything published in the last 2-3 years)
bundle their own declarations and an `@types` companion only
exists for legacy versions. Installing both creates the kind
of silent type-shadowing that produces oblique errors in
unrelated code (the failing `sanitize()` overload was 30 lines
away from the import that caused the shadow).

A `find node_modules/<pkg> -name '*.d.ts'` is cheap; it would
have surfaced the bundled types in two seconds.

## 10. Symmetric endpoints, asymmetric changes — 2026-05-10

When PR #67 added two UI-derived fields (`model` + `sessionOverride`) to
agent JSON shipped to the client, it updated `/api/agents` but not the
parallel `/api/channels/[id]/members` endpoint. Both endpoints return
the same `AgentInfo` type. The bubble component looked the agent up in
`members`, which is sourced from the channel-members endpoint, not from
the agents endpoint. So the derived fields were always `undefined` for
every agent — the ADR-0018 session badge never rendered, and the
disclosure panel showed `Model: (default)` and `Session override: —` for
every agent including those with a real override configured.

**Symptom:** User test of #67 right after merge: "scheint sich nichts
geändert zu haben" for a `dixie-sagesmith` agent with a real override.
Disclosure showed default-shaped fields.

**Root cause:** Two endpoints share an output type (`AgentInfo`) but
were extended asymmetrically. Type-checking didn't catch it because
`model?` and `sessionOverride?` are *optional* on `AgentInfo` — the
old four-field response still satisfies the type.

**Fix:** #68 mirrored the same derive-from-config logic into the
channel-members endpoint. Both endpoints now share the same shape.

**Meta — the lesson behind the lesson.** When a UI type is served by
more than one endpoint, optional fields on that type are a footgun:
the compiler treats "this endpoint omits the field" as
indistinguishable from "the value is genuinely absent". For the next
time:

- **List the endpoints that produce the type.** Before extending, find
  all `select({...})` blocks that map to the same client type. Trace
  the consumer side too — which calling code reads the new field?
- **Prefer one helper function** for the shape derivation when two
  endpoints share output. The fix in #68 was literally copy-paste of
  the #67 derive block. A `deriveAgentUiBits(connectorType, configJson)`
  helper in `db/agent-config.ts` would have made the symmetry obvious
  and the omission visible.
- **External verification applies to data flows.** I asserted "members
  comes from the same source" without checking. One grep for `members =`
  in `+page.svelte` would have shown the truth in two seconds. Identifier
  discipline is verbatim-or-nothing; data-flow discipline is
  trace-or-nothing.

## 11. PR state not verified before push — 2026-05-10

After Jürgen reported the #67 bug, I pushed the fix as an extra commit
on the same `feat/0018-bubble-header` branch, assuming PR #67 was
still open. It had already been merged. The push went through (the
remote accepted the orphan commit), but the fix wasn't visible
anywhere — not on main, not in any open PR. Jürgen asked "wo ist der
PR für den Fix?" and I had to backtrack: cherry-pick the commit to a
fresh branch off the fresh main, push, open #68.

**Symptom:** Fix committed and pushed; nothing visible on GitHub
because the target PR was already merged.

**Root cause:** I assumed branch state from session memory ("we
merged #65 and #66, #67 was just opened") without calling
`gh pr view 67` to verify. By that point, #67 had been merged too —
Jürgen had said "merge ist durch, mach erstmal weiter" earlier and I
had heard it as a forward-looking instruction, not a state report.

**Fix:** Cherry-pick → fresh branch off updated main → PR #68. Took
30 seconds once I actually looked.

**Meta.** This is the second variant of #10 in one evening: assuming
state instead of querying it. The fix is the same: when a PR is the
target of any new work, `gh pr view <n> --json state` is the cheapest
possible check, and not doing it produced a real misroute. Adding to
my mental routine: *before pushing a fix on a feature branch, verify
the feature PR is still open.* If the answer is "merged", the fix
needs its own branch off main, not a push onto the dead feature
branch.

Also worth noting: this kind of mistake clusters at the end of a long
session. Three vermutung-instead-of-verifizieren misses in 20
minutes around 22:00 on a Sunday is a signal, not just a fact. The
honest move at that point is to slow down or stop, not to keep
pushing.

## 12. Curl-acceptance ceiling for browser bind layers — 2026-05-11

Five PRs shipped on 2026-05-11 (#71, #72, #73, #76, #77) for the
ADR-0019 settings surface. All five passed `npm run check` (0/0) and
all five had explicit curl-acceptance steps in the PR body that
verified the server contract end-to-end. Both gates were green for
the whole stack.

Two bugs shipped anyway, both in the global-settings form:

- **#77** Save button stayed disabled forever — the `$derived` dirty
  check captured a stale snapshot because the dependency tracking
  ran once at render and never re-fired on edit.
- **#79** Save enabled, PATCH rejected with `400` — the
  `<input type="number">` `bind:value` shape returned a string in
  some Svelte 5 bind paths, the zod-strict server schema rejected
  it, the UI showed no feedback because the failure was swallowed
  in `console.error`.

Both would have been caught by 30 seconds of clicking through the
form in a real browser.

**Symptom.** Persistent form-state bugs that survive multiple PRs,
each time the next PR "looks unrelated" until the user pokes at
the UI and finds the previous fix didn't actually fix anything.

**Root cause.** Curl tests the server contract. `svelte-check`
tests types. **Neither tests the bind layer** between DOM input
and `$state` — the part of the stack where Svelte 5's reactivity
rules, the `<input>` element's value-binding semantics, and the
application's commit-on-Save flow have to agree. A 200-line
form-handler can pass curl + check and still be visibly broken.

**Fix.** PR #82 added a Playwright smoke harness with two specs
that would have caught both bugs (Save persists across reload,
Discard reverts edit). The pre-merge rule in
`docs/contributing.md` requires `npm run test:smoke` for any PR
that touches a `+page.svelte`, a form handler, or a Svelte
`bind:`. Server-only and docs-only PRs stay exempt — the rule
scales with what the PR actually changes.

**Meta.** The earlier curl-then-ship discipline (lesson #6,
smoke-curl the wire before opening a PR) is *right* for backend
integration with third-party endpoints. It is *insufficient*
the moment the user-visible surface is a browser form. The two
rules now sit side by side: server contract → curl. Browser bind
layer → smoke spec. Type-check is necessary for both and
sufficient for neither.

## 13. PR-stacks force manual conflict resolution on the merger — 2026-05-12

Three PRs in one morning. #82 (smoke harness) merged cleanly. #83
(auto-approve routing) merged cleanly. Then I opened **#84**
(latency fix for issue #81) on top of `feat/auto-approve-routing`
*while #83 was still in review*, because the latency fix
refactored code that #83 had just introduced.

When Jürgen went to merge #84, the squash-merge of #83 had
rewritten the file layout enough that #84's diff no longer
applied cleanly. The conflict resolution was non-obvious
("do I take the structural change from #84 here, or the
different structural change from #83 there, or some merge of
the two?"). Jürgen: "jetzt muss ich manuell konflikte resolven
bei denen nicht 100% klar ist was ich übernehmen soll. das
unterlassen wir künftig bitte."

**Symptom.** Squash-merged PR-stacks where the second PR's diff
becomes unintelligible after the first one lands, forcing the
merging human into a code-archaeology session to figure out the
intended final state.

**Root cause.** Two separate failures compounded:

1. I treated my own session productivity (keep coding while review
   happens) as more important than the merger's experience.
   Stack-PRs *can* work, but only when the second PR is a strict
   addition to the first — not a refactor of the same lines.
2. The latency-fix PR was over-scoped: 247/190 LOC across 3 files
   for what was conceptually a per-target-promise reordering. A
   minimal-diff version would have been small enough that even a
   stack would have rebased trivially.

**Fix.** Closed #84, deleted the branch, waited for #83 to merge
(took Jürgen ~5 minutes), rebased onto fresh main, opened **#85**
with **+82/-57 lines across 2 files** — same effect, same
benchmark numbers, much smaller review surface. #85 merged
immediately. Net cost: one closed PR, one re-open, ~10 minutes.

**Rule going forward.** One open PR-stack at a time. New work
waits until the current PR is merged, unless the new work
strictly doesn't touch the in-flight files. Docs-only PRs are
almost always safe; anything in the same module as the active
PR is not.

**Meta.** This sits next to lesson #11 (PR state not verified
before push): both are failures to treat the merger as a real
stakeholder with a real workload, not just a code-review rubber
stamp. The minimal-diff principle is the other half of the
coin: when the conceptual change is small, the implementation
should be too. Refactoring the surrounding code is a separate
PR, opened consciously, not sneaked into the bug-fix.

First question on every bug fix going forward: **"what is the
smallest change that fixes this?"** Refactor only as a separate,
conscious next PR, with the bug-fix shipped first.

## 14. Multi-agent session quality is set by initiator discipline — 2026-05-11

On 2026-05-11 evening, Jürgen ran a 4-hop multi-agent design
session (Wintermute + Gwen + Dixie, auto-approve on, roundtrip cap
= 4) and got a substantive output: a complete concept for mermaid-
diagram rendering in bubbles, captured as issue #80. Wintermute's
reflection at the end identified the session quality as
**non-accidental** — the result of four structural choices, any
one of which would have degraded the output.

The four:

1. **Setup-prompt three minutes before the substantive anstoss.**
   Jürgen sent a framing message to the whole channel describing
   the mode ("discussion among three of you, not a single-shot
reply"), the topology ("auto-approve is on, no user intervention
   between hops"), and the constraint ("4-hop cap, reset by user
   message"). The agents received the topic in an *already-framed*
   discourse context.

2. **The substantive anstoss carried three forcing functions in
   one sentence.** Topic frame ("Mermaid"), required output ("ein
   Konzept präsentiert"), quality constraint ("sinnvoll (!)").
   Without the topic frame, the agents would have streamed across
   all UX themes. Without the required output, the session would
   have been brainstorm-shaped, not conclude-shaped. Without the
   quality constraint, sub-par variants would have lived in the
   final concept.

3. **Hop 1 distributed roles explicitly.** The initiator wrote
   "Wintermute: Agent-Reality / diagram-language choice. Gwen:
   Security/SVG + UX." Not asked for, not enforced by the
   anstoss — a contingent good move. Without it, three agents to
   the same question (security) would have produced 4 hops of
   "who phrases it sharpest" rather than concept-work.

4. **The hop limit acted as a quality constraint, not just a loop
   defence.** Wintermute: "Das hat mich gezwungen, die
   Performance-Frage in einem Hop komplett auszuformulieren statt
   in zwei zaghaften. Ohne Limit hätten wir's auf 6-7 Hops
   gestreckt. Constraint → Qualität."

**Symptom (the failure mode this avoids).** Multi-agent sessions
that consume 4+ hops without producing a substantive output —
where the agents converge on the same topic, polish each other's
phrasings, and end up with a polished version of the most
obvious framing rather than the most useful one. The user feels
like "the agents discussed it for a while" without anything to
point at.

**Root cause.** Without explicit framing, three agents will
gravitate toward whatever is most salient in the topic — usually
the most familiar architectural concern. Convergence is
comfortable for the participating agents (everyone is on the
same page) but expensive in terms of session-output diversity.

**Fix (operational).** When initiating a multi-agent session,
structure the open like this:

- *Setup turn* (sent to channel, no @-mention): mode, topology,
  constraint.
- *Anstoss turn* (sent to one agent with @-mention): topic frame +
  required output + quality constraint. One sentence is enough.
- *Hop 1 by the initiated agent*: explicit role distribution to
  the other agents.
- *Roundtrip cap*: short enough to force completeness per hop,
  long enough to allow real exchange. 4 hops worked here.

The "Soweit das Szenario" / "Soweit der Wunsch" framing in
Jürgen's prompts (the cadence of explicitly *closing* the setup
before opening the topic) reads like a small thing but is what
makes the setup-vs-substance boundary visible to the agents.

**Fix (product).** `ADR-0021-multi-agent-channel-initiation`
sketches the design space for encoding parts of this pattern as
a finn feature — currently at `status: discovery`. The strongest
current candidate is a per-channel free-form `initiation_template`
field that finn surfaces as a hint above the input box when a
multi-agent channel is opened, leaving the user to copy/paste
and edit. Decision pending a second or third session against the
pattern.

**Meta.** This lesson sits next to lesson #6 (smoke-curl the wire
before opening a PR): both are about establishing a *frame* before
the substantive work, and both reduce the cost of bad outputs
found late. It also extends the operational principle from
workspace `principles.md`: *"the frame of the anstoss becomes
the frame of the work"* — the corollary is that when the work is
multi-agent and the agents' frames diverge from the initiator's,
the whole session inherits the agents' default frames, not the
initiator's intent. Setup-before-anstoss is what closes that gap.

The whole observation only became visible because Wintermute
reflected explicitly at the end of hop 4 — a fifth structural
element that probably belongs here too but is harder to encode:
the initiator should ask for a meta-reflection from one
participant at the end. *That* is what produced this lesson.

*Verbatim prompts from the session are preserved in the workspace
daily log `memory/2026-05-11.md` for future reference; this entry
is the generalised distillation.*

## 15. JSON-escape sequences in PR bodies — the lesson-#1 repeat — 2026-05-12

Four PR bodies shipped between #83 and #87 contained literal
`\u2014`, `\u2192`, `\u00fc` etc. instead of the actual UTF-8
characters they encode (em-dash, right-arrow, u-umlaut, ...).
Jürgen noticed reading the PR bodies on GitHub: *"ich sehe in
github PR body oft noch die escape sequenz `\u2014`"*.

This is **exactly the same class of bug as lesson #1** — just
in a different surface. Lesson #1 caught it in the README at
`git push` time. This one shipped through four PRs because the
pre-merge gate is `npm run check`, which doesn't scan PR-body
text.

**Symptom.** PR bodies on GitHub render `\u2014` literally
wherever an em-dash was intended. The repository source files
are clean (correct UTF-8); only the PR body — the text that
becomes the squash-merge commit message — carries the escape
sequences.

**Root cause.** The text I produced when authoring PR bodies
went through a pathway where typographic characters got
JSON-escaped rather than UTF-8-encoded. The intermediate
file written for `gh pr create --body-file` already contained
`\u2014` as six literal bytes (`\`, `u`, `2`, `0`, `1`, `4`),
not the three-byte UTF-8 sequence (`0xe2 0x80 0x94`). Direct
verification: `od -c` on the body file showed the literal
backslash-u sequence.

**Fix.**

1. Existing PR bodies (#83, #85, #86, #87) corrected via
   `gh pr edit --body-file` after running
   `sed 's|\u2014|—|g; s|\u2192|→|g; ...'` on the existing
   body text. The merge-commit messages themselves cannot be
   retroactively rewritten without force-pushing main, which
   we don't do; only the PR-body surface (which is what
   readers actually look at) is updated.
2. Same-class bug in `docs/decisions/0011-channel-view-kb-budget.md`
   table cells (`\"Last 200\"`) corrected in this PR.
3. Going forward: PR-body authoring uses **ASCII alternatives**
   for problem characters when in doubt. Em-dash → `--`,
   right-arrow → `->`, en-dash → `-`. Less typographic, more
   robust to whatever escape layer is in the path. The
   repository source markdown (lessons, ADRs, README) can keep
   the proper Unicode characters because `npm run check` plus
   the `git push` visual review catches them — the surface that
   was *not* covered was the PR body itself.
4. Optional belt-and-braces: add a pre-`gh pr create` grep
   check (`grep -P '\\u[0-9a-fA-F]{4}|\\"' body.md` — the same
   pattern from `AGENTS.md` smoke-test for README escapes). If
   it matches, hand-fix before the PR is opened.

**Meta.** Lesson #1 fixed the README path. The bug returned in
a different surface (PR bodies) because the lesson lived in
`lessons.md` for the *repository*, not in a personal authoring
checklist that covers every public output. The honest move is
to extend the lesson to cover every output that becomes
long-term human-readable text — not just files committed to the
repo. PR bodies, ADR comments, issue comments, release notes
are all in scope.

The relevant verification command from `AGENTS.md` is the smoke
test already documented there:

```
grep -P '\u[0-9a-fA-F]{4}|\\["nrt]' file.md
```

I now run this against PR body files (`/tmp/pr-body-*.md`)
before the `gh pr create` call. Two lines, fifteen seconds,
catches the bug class entirely.

**Sub-lesson:** *every* output surface that human eyes will see
deserves the same UTF-8 hygiene as repository files. The
repository is just the most obvious one.
