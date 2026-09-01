# Models view — specification

Status: **draft, awaiting sign-off**. Nothing is built yet.

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
| vs cheapest | derived | multiple of the cheapest **listed** model on a blended basis |
| your cost/message | rollups + solved | only when the gate is met; otherwise the reason |
| context | LM API | max input tokens, when reported |

A model with a **long-context variant** shows both rows, marked, because the
card holds both and the long tier is roughly double.

The sidebar carries a three-line reduction: cheapest available, the model you
spend most on, and the multiple between them.

## Invariants

These are the things a test must be able to *fail*. Each is checkable against
data the view did not itself produce.

1. **No blank money.** Every listed model shows a price or an explicit "not in
   the published card" — never an empty cell, a dash, or a zero standing in
   for absence.
2. **The multiple is anchored.** `vs cheapest` is exactly `1×` for exactly one
   row, and `≥ 1×` for every other. If two models tie for cheapest, both read
   `1×`.
3. **Measurement is gated, and says so.** `your cost/message` appears only for
   models with at least `pricing.minObservations` billed messages. Below that
   the cell states the shortfall ("needs 6, has 1"), never `0.00`.
4. **Availability is not inferred from usage.** A model in your rollups that
   the LM API does not offer is listed as *no longer available*, not silently
   dropped — that is precisely what happened when the frontier models went.
5. **Unavailable is not unpriced.** A model the API offers but the card does
   not price still appears, marked unpriced. The reverse — priced but not
   offered — is excluded from the table and counted in a footnote.
6. **One unit on the page.** All money is credits per 1M tokens, stated in the
   header. No per-1k figures, no dollars.
7. **A stale card admits it.** If the card's `effective` date is older than the
   current billing period's start, the view says the prices predate the period
   it is advising on.
8. **The API's silence is a state.** If `selectChatModels` returns nothing —
   no consent, older VS Code, no Copilot — the view renders the card's models
   with an explicit "this is the published list, not your list" banner. It
   never renders an empty table.

## States the fixtures must render

Every bug this month came from a state no fixture had ever drawn. These are
the ones this view can reach, and each needs a fixture *before* the code:

- an account with **one** model available (multiple column degenerates)
- a model available but absent from the card (new release, card not refreshed)
- a model in the card and in your history but **no longer offered** (the
  frontier case)
- zero billed messages on every model (fresh period — your Sep 1 state)
- exactly `minObservations - 1` messages on one model (the boundary)
- a model with a long-context variant priced at a different multiple
- the LM API unavailable or returning an empty list
- a card whose `effective` date is after the period start

## Non-goals

- **No routing, no switching.** VS Code exposes no API to change the model in
  Copilot's own agent mode. This view informs a human decision; it does not
  make one.
- **No forecasting per model.** "You would have saved X by using Luna" needs a
  counterfactual token count this extension cannot honestly produce.
- **No editorialising.** No "recommended" badge. Cheapest is not best, and the
  view has no way to know whether Luna could have done the work.

## Open questions

1. **Does listing models require consent?** `vscode.lm.selectChatModels` may
   prompt on first use. If it does, the view must work without it (invariant
   8) and the prompt must be triggered by the user opening the view, never at
   activation.
2. **Blended multiple, or per-column?** A single `vs cheapest` number needs an
   input:output ratio to blend on. Options: your own measured ratio (honest,
   varies), a fixed 10:1 (stable, arbitrary), or drop the column and let the
   reader compare input and output separately.
3. **Where does it live?** A third webview, a section on the existing panel, or
   a tab on the specs page.
