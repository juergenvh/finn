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
