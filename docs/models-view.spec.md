# Models view — specification

Status: **built**, first shipped in 0.7.0. Amendments made during the build
are recorded where they belong rather than appended, with the reasoning kept.

## The decision it serves

An enterprise account ran dry fifteen days before its reset, and when it came
back the frontier models were gone. The question that matters is no longer
"where did my credits go" — the panel answers that — but **"of the models I
can pick right now, which one should I reach for, and what does it cost me
against the others?"**

That question is asked *before* spending, which is why no existing surface
answers it: the panel and the specs page are both built from rollups, so a
model you have not used yet does not appear anywhere in this extension.

## Sources, and what each is worth

| source | gives | trust |
|---|---|---|
| `vscode.lm.selectChatModels({ vendor: 'copilot' })` | the models this account can actually pick, with ids and context limits | authoritative for availability, and the only thing that is |
| `rate-card.json` | published price per 1M tokens, per variant | published, dated, may be stale |
| solved prices (`pricing.solve`) | what *you* were actually billed per token | measured, needs `pricing.minObservations` billed messages on one model |
| rollups | your messages, tokens and credits per model | measured, partial by nature |

The view is a **join across all four**, and each cell must say which source it
came from when they disagree.

## Content

One table, ordered by cost ascending — cheapest first, because that is the
order the decision is made in.

| column | source | notes |
|---|---|---|
| model | LM API | display name; the id in a tooltip |
| input / output | card | credits per 1M tokens |
| cache read / write | card | credits per 1M tokens |
| your cost/message | rollups + solved | only when the gate is met; otherwise the reason |
| context | LM API | max input tokens, when reported |

A **question mark** beside each name opens a one-line description of what the
vendor says the model is for, from GitHub's model comparison page. Only the
marker is the control; the name stays ordinary selectable text, because a
Foundry-prefixed id is fifty characters and copying it is the other thing
anyone does in this column.

The descriptions live in the rate card beside the prices, so the existing
refresh keeps them current -- there is no second thing to update. A fetched
card that carries no descriptions keeps the ones already held rather than
blanking them, so a source that improves the figures cannot lose the words.

A model with a **long-context variant** shows both rows, marked, because the
card holds both and the long tier is roughly double. Only the default row
carries the description: the long tier is the same model at a different rate,
and repeating its description under a second heading says there are two.

Ten rows stand and the rest fold into a `details`, because a list of thirty
models is a reference table, not a decision aid. It was seven; ten is what a
reader asked for, and the number is one constant.

The sidebar carries a two-line reduction: the cheapest available and the model
you spend most on, one line each -- name, role, and the two rates set right so
the digits of one sit under the digits of the other.

## Invariants

These are the things a test must be able to *fail*. Each is checkable against
data the view did not itself produce.

1. **No blank money, and no hijacked rows.** Every listed model shows a price
   in each money column or a dash in it — never a zero standing in for
   absence. Why a row has no prices is said with a label beside its name
   (**not published**, **not offered**), not by a sentence spanning the money
   columns: a row missing prices still has four price columns, and a colspan
   across them breaks the geometry of the one row a reader is already
   puzzled by.
2. **The cheapest is marked, per column.** Exactly one row carries the mark in
   each of input and output, and every row that ties for cheapest carries it
   too. Input and output are marked independently: a model can be cheapest to
   send to and dearest to hear back from.

   Originally a single blended `vs cheapest` multiple. Dropped: blending needs
   an input:output ratio, that ratio is a property of your prompts rather than
   of the models, and inventing one puts a made-up number in the column the
   decision is read from.
3. **Measurement is gated, and says so in English.** `your cost/message`
   appears only for models with at least `pricing.minObservations` billed
   messages, and carries its unit — `2.38 credits`, never a bare `2.38` in a
   column that could as easily be counting messages. Below the gate the cell
   says `not yet billed` or `2 of 6 billed`; it is never `0.00`, and never the
   gate talking about itself ("needs 6, has 1") in a column headed by what it
   is withholding. A row with no measurement of its own — a long-context
   variant, which is the same model at another rate — shows a dash rather than
   nothing at all.
4. **Availability is not inferred from usage.** A model in your rollups that
   the LM API does not offer is listed as *no longer available*, not silently
   dropped — that is precisely what happened when the frontier models went.
5. **Unavailable is not unpriced.** A model the API offers but the card does
   not price still appears, marked unpriced. The reverse — priced but not
   offered — is excluded from the table and counted in a footnote.
6. **One unit on the page.** All money is credits per 1M tokens, stated in the
   header. No per-1k figures, no dollars.
7. **An unread card admits it.** If the card has not been *fetched* in over
   four weeks, the view says so and names the command that refreshes it.

   This was first written as "flag a card whose prices took effect before the
   period began", which is nearly always true — prices are set before the
   periods they apply to — so it printed a warning on every render. A warning
   that is always on is a warning nobody reads. What is worth saying is that a
   fetch is not happening.
8. **No bar for a price.** The sidebar draws no bar in this block. Every other
   bar in that column is spend against a quota -- the meter, the day, the week
   -- so a price ratio drawn the same way says a model is consuming something,
   which it has not until you send it anything. A ratio between two published
   prices is a fact about a price list, and two figures state it without a
   graphic pretending to measure.
9. **A description is not lost by a refresh.** Notes are card data, so they
   update with the card. A fetched card that omits them falls back to the ones
   already held: a source that publishes better prices and no prose must not
   blank the column. The test loads a stripped card over the bundled one and
   fails if a description disappears.
10. **The API's silence is a state.** If `selectChatModels` returns nothing —
   no consent, older VS Code, no Copilot — the view renders the card's models
   with an explicit "this is the published list, not your list" banner. It
   never renders an empty table.

## States the fixtures must render

Every bug this month came from a state no fixture had ever drawn. These are
the ones this view can reach, and each needs a fixture *before* the code:

- an account with **one** model available (it is cheapest of itself)
- a model available but absent from the card (new release, card not refreshed)
- a model in the card and in your history but **no longer offered** (the
  frontier case)
- zero billed messages on every model (fresh period — your Sep 1 state)
- exactly `minObservations - 1` messages on one model (the boundary)
- a model with a long-context variant priced at a different multiple
- the LM API unavailable or returning an empty list
- a card unread for over four weeks, and one unread for twenty-seven days
  (the boundary either side)
- a model the card describes and one it does not (an empty bubble promises an
  explanation that is not there, so a model with no note gets no marker)
- a fetched card carrying no descriptions at all
- every description open at once, at 320px and in both themes -- a closed
  `details` measures as nothing, so its text would never be contrast-checked
  and never collide with anything

## Non-goals

- **No routing, no switching.** VS Code exposes no API to change the model in
  Copilot's own agent mode. This view informs a human decision; it does not
  make one.
- **No forecasting per model.** "You would have saved X by using Luna" needs a
  counterfactual token count this extension cannot honestly produce.
- **No editorialising.** No "recommended" badge. Cheapest is not best, and the
  view has no way to know whether Luna could have done the work. The
  descriptions say what a model is for; they are the vendor's words, not a
  ranking of them.

## Open questions

1. **Does listing models require consent?** *Settled:* it may prompt, so the
   call is made when someone opens the report and never at activation or on
   the refresh timer. Invariant 10 covers the refusal.
2. **Blended multiple, or per-column?** *Settled:* per-column, and see
   invariant 2 for why.
3. **Where does it live?** *Settled:* a section on the main panel directly
   after the verdict card, and in the sidebar after the weekly burn chart.

## What the invariants caught

Written before the code, and four of them failed on the first run rather than
after you saw them:

- the published list was not rendered when the editor says nothing (invariant 8)
- the cheapest mark used a chart colour measuring 3.59:1 as 13px text, the
  fifth fill-as-text in `report.ts`
- the six-column table pushed the panel 54px sideways at 320px
- a backtick inside a CSS comment terminated the stylesheet's template literal

The staleness rule was itself wrong on first contact with real data, and is
rewritten above with the reason left in place.

Adding the descriptions caught the fold's own test, which counted standing
rows by splitting the page at the first `details` on it. Once every row hid a
description behind a marker, that probe stopped at row one and reported a fold
after a single model -- green code, broken measurement.
