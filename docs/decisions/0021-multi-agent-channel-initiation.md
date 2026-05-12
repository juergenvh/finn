# ADR 0021 — Multi-agent channel initiation: forcing functions for spread vs convergence

- **Status:** discovery
- **Date:** 2026-05-12
- **Deciders:** Jürgen, Dixie
- **Related:** ADR-0015 (auto-approve channels), ADR-0020
  (roundtrip cap), issue #80 (mermaid diagram rendering — the
  4-hop session that produced this observation), workspace
  daily log 2026-05-11, `docs/lessons.md` #14.

## Status note

This ADR is at **discovery** stage. It records a substantive
pattern observed on 2026-05-11, captures the design space, and
sketches the implementation options. It does **not** yet pin a
decision; that comes in a follow-up ADR (or a promotion of this
one to `accepted` with the chosen option) once we have a second
or third multi-agent session against the pattern.

## Context

On 2026-05-11 evening, Jürgen ran a 4-hop multi-agent design
session in a finn channel with three agents (Wintermute, Gwen,
Dixie), auto-approve toggled on, roundtrip cap = 4. The output
was a substantial concept for mermaid-diagram rendering in
bubbles (issue #80 captures the technical conclusion;
`ADR-0021-draft-from-issue-80` content lives in the issue body).

Wintermute's closing reflection identified **four structural
elements** that made the session productive rather than
redundant. These are the elements this ADR pins:

### 1. Setup-prompt before the substantive anstoss

Jürgen sent a setup message to the whole channel at 21:28:

> Folgendes Testszenario. Ich werde gleich eine Nachricht an
> einen von euch schicken, und werde ihn dann bitten, den Inhalt
> mit den anderen beiden zu diskutieren. Dabei habe ich für
> diesen Channel den Approval Flow ausgeschaltet, also ihr
> sendet via die mentions die Nachrichten dann direkt ohne dass
> ich da eingreife. Es gibt ein Limit von 4 hops bevor eine
> Nachricht von mir kommen muss um das limit zu resetten.
> Soweit das Szenario.

Three pieces of context were established **before** the topic
arrived:

- **Mode:** discussion among three agents, not single-shot
  reply.
- **Topology:** auto-approve active, no user intervention
  between hops.
- **Constraint:** 4-hop cap, reset by user message.

The substantive anstoss landed three minutes later (21:31), in
an already-framed discourse context.

### 2. The anstoss carried three forcing functions in one sentence

> @dixie ich möchte nicht nur Bilder in der Nachrichten Bubble
> haben, sondern auch mermaid diagrame richig darstellen können.
> Soweit der Wunsch — kannst du das sinnvoll (!) mit den anderen
> beiden soweit bringen, dass ihr alle Feedback dazu gebt und
> mir dafür ein Konzept präsentiert?

The single anstoss sentence encoded:

- **Topic frame:** "Mermaid" (not "rendering in general", not
  "UI for the chat view"). Narrow.
- **Required output:** "ein Konzept präsentiert" — a concept,
  not a brainstorm.
- **Quality constraint:** "sinnvoll (!)" — explicitly excludes
  the option of building something structurally unattractive.

Without the topic frame, agents would have spread across all UX
themes. Without the required output, the session would have
been brainstorm-shaped, not conclude-shaped. Without the
quality constraint, sub-par options would have lived in the
final concept.

### 3. Hop 1 distributed roles explicitly

The initiator (Dixie) opened the channel discussion with:

> Wintermute: Agent-Realität / Diagramm-Sprachen-Wahl.
> Gwen: Security/SVG + UX.

This was **not enforced by the anstoss**. Dixie could have
written "@wintermute @gwen — what do you think about
mermaid?" and triggered a convergence loop where all three
agents drifted toward the most obvious architectural theme
(security, in this case). Wintermute's observation:

> Wenn du den Flow institutionalisierst: der Initiator (hier
> ich) sollte die Rollen in der Eröffnungsnachricht explizit
> verteilen [...] Das hat den Spread erzwungen.

The role distribution was a *contingent* good move — repeated
sessions cannot rely on the initiator making it again.

### 4. Hop limit acted as a quality constraint

Wintermute's verbatim:

> Auch wertvoll: Hop 4 als harte Grenze ist gut. Das hat mich
> gezwungen, die Performance-Frage in einem Hop komplett
> auszuformulieren statt in zwei zaghaften. Ohne Limit hätten
> wir's auf 6-7 Hops gestreckt.

This reframes ADR-0020's roundtrip cap. ADR-0020 motivated the
cap as **loop defence** (a quantitative guarantee that two
agents pinging each other cannot run away). This session shows
the cap also has a **qualitative** effect: it forces each
contribution to be complete-in-itself rather than tentative.
Constraint produces sharpness.

## Decision space

The four elements above are **organisational pattern**, not
features. The decision finn has to make is *how much, if any,
of this pattern do we encode in the product*.

### Option A — Document only

Capture the pattern as `docs/lessons.md` #14 (in flight with
this PR) and rely on the user to remember it. Zero finn-side
code. Zero UI-touch. The pattern is operational guidance for
the user, not a feature.

**Cost:** the pattern works only when the user happens to
remember. As Jürgen put it: "es war wohl pures Glück dass ich
das Thema initial erklärt hatte und auch die Hops mitgegeben
hatte". Glück is exactly what shouldn't be load-bearing.

### Option B — Channel-level template field

Each channel can carry a free-form `initiation_template`
string in `settings_channel` (or `channels`). When the user
opens a fresh channel view, finn renders the template as a
collapsed hint above the input box: *"Suggested setup-prompt
for this channel: [...]"*. The user can copy/paste, edit,
ignore.

The template is **per-channel** because the right framing
depends on who's in the channel and what it's for. A
"strategy" channel and a "bug-triage" channel need different
templates.

**Cost:** one Drizzle migration, settings-surface UI
addition, channel-view hint rendering, ADR-0019 settings
update. Mid-sized PR.

**Benefit:** the user gets prompted with the pattern without
needing to remember it; the template captures
channel-specific framing once and reuses it. Edits to the
template happen in `/settings`, not in the chat itself.

### Option C — Initiator-role template + role-distribution helper

Beyond a free-form template, finn could provide structured
support specifically for the role-distribution step (#3
above):

- The channel's member list in `/settings` carries an
  optional `intended_role` text per member.
- When the user @-mentions the channel as a whole (e.g.
  `@all` or no @-mention with multiple recipients), finn
  expands the message into per-recipient `@-mentions` with
  the role appended: *"@wintermute (Agent-Realität),
  @gwen (Security/SVG)"*.

This crosses the §1 boundary from ADR-0015 (finn surfaces
facts, the user decides) — finn would be doing *expansion* on
the user's message rather than just passing it through. That
might be acceptable when the expansion is mechanical
(member-list lookup) and reversible (user can edit the
expanded message before send), but it needs explicit
acceptance.

**Cost:** larger. Settings UI for per-member role labels,
member-resolution logic in the message-input flow, edge
cases around partial role assignment, undo affordance.

**Benefit:** the role-distribution step happens by default,
not by initiator discipline.

### Option D — Settings-surface "channel kind" with built-in initiator template

If a channel carries metadata like
`kind: 'discussion' | 'broadcast' | 'triage' | 'pair'`, finn
can ship reasonable default initiator templates per kind and
let the user override.

**Cost:** introduces a concept ("channel kind") that doesn't
exist today. Risk of premature taxonomy — three kinds today
might want eight tomorrow, and renaming an enum value is
disruptive.

**Benefit:** least friction for the *common* case; the user
doesn't have to compose a template, just pick a kind.

## Initial recommendation

**B is the strongest candidate for a v1.** It captures the
"setup-prompt before anstoss" element (the user pastes the
template before sending the substantive message), it makes the
role-distribution explicit (the template body names the roles),
and it stays inside the §1 boundary (no implicit
expansion — the user sees and edits exactly what gets sent).

A and D are weaker:

- A leaves it on luck.
- D introduces taxonomy debt for a marginal usability win over B.

C is interesting but requires a separate decision about
finn-doing-expansion-on-user-messages. Worth its own discovery
ADR if it comes back.

This recommendation is **not yet locked in**. Promote this ADR
to `accepted` after the second multi-agent session against the
pattern produces evidence one way or the other.

## Out of scope (this ADR)

- The auto-approve toggle itself (ADR-0015).
- Roundtrip cap mechanics (ADR-0020) — this ADR only
  *re-interprets* the cap as also a quality constraint, not just
  a loop defence.
- Multi-agent topology decisions like "which agents go in which
  channel" — that stays a user-owned configuration question.

## Persistence (if B is chosen)

- New column `settings_channel.initiation_template TEXT` (nullable).
- One-line migration analogous to `0005_third_marvel_apes.sql`.
- `/api/settings/channel/[id]` accepts the field in PATCH bodies
  with `z.string().max(...).nullable().optional()`.
- Channel-view renders a collapsed hint when the field is set
  and the channel has more than one agent member.

No backfill needed; null means "no template" which is the
current behaviour.

## Open questions

- **Should the template be exposed in the channel header or only
  in `/settings`?** The header is more discoverable but takes
  pixel-budget away from the conversation. A collapsible hint
  above the input box, dismissable per session, is probably the
  right shape — but that's a UI sketch, not a decision.
- **Does the template re-render on every fresh session, or only
  the first time a channel has fewer than N messages?** The
  former is annoying for established channels; the latter
  requires a heuristic for "fresh".
- **Markdown or plain text?** Plain text is simpler; markdown
  matches the rest of finn's chat surface (ADR-0016). Plain text
  for v1, markdown can be a later upgrade.

## Related lessons

`docs/lessons.md` #14 captures the *generalised* pattern (how to
initiate a multi-agent design session well) as operational
guidance. This ADR captures the *finn-specific* product
implications.
