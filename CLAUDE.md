# Token Pie — working context

Read this before changing anything. It records intent, the invariants that are
not obvious from the code, and the findings behind them. `docs/ARCHITECTURE.md` has the module map and diagrams;
`docs/DECISIONS.md` has the evidence behind each finding.

## What this is for

A developer on a metered Copilot plan cannot answer the only question that
matters — **"will I still be able to work this week?"** — from anything GitHub
ships. The billing dashboard is org-scoped, lagging, and says nothing about
what to do differently.

Token Pie runs locally on each developer's machine, reads telemetry Copilot
already writes, and answers three questions in this order:

1. **Will I be throttled?** Measured burn rate joined to live remaining quota.
2. **What should I change?** Findings derived from that machine's own spend.
3. **Where did it go?** By model, workspace, and how the model was chosen.

Everything stays on the machine. No server, no account, no telemetry of our own.

## The thesis

Other trackers report *what you spent*. That is a solved problem and not worth
shipping. The differentiation is threefold, in descending order of durability:

1. **Correct spend.** `agent-traces.db` is the only local source that matches
   the bill. The obvious alternative undercounts by ~55% on agent work.
2. **Quota-joined projection.** Spend without a denominator or a horizon is not
   information. Nothing else reads `copilot_internal/user`.
3. **Cache economics.** `cached_tokens` is per-request in `agent-traces.db` and
   in no other source. Fresh input bills at **12.5×** cached input, measured.
4. **A solved rate card.** Cost is linear in the three token classes, so the
   per-class rates can be recovered by least squares from the user's own
   requests — exactly, R² = 1.00000. Output bills at **4× fresh input**, which
   is why anything reported by token count misstates where the money went.
   Note that on a cache-writing model "fresh" *is* cache-write, so the 1×
   baseline carries a premium and output is 5× against plain input.

If a change makes one of those weaker, it is the wrong change.

## Invariants — do not break these

- **Every VS Code window runs its own copy of this extension against the same
  store.** Writes must be safe across processes: unique scratch filenames, no
  assumption that a file you just wrote is still there. A shared
  `rollup.json.tmp` crashed a second window with ENOENT.
- **Nothing written to the log may contain a home directory.** The broken state
  invites the user to share it. Route messages through `redactPaths`.
- **`agent-traces.db` is read-only, with exactly one exception.** Every VS Code
  window runs its own extension host writing to that file. `src/purge.ts` is the
  only permitted writer. Everything else opens `mode=ro&immutable=1`.
- **Never claim a number we did not measure.** No list-price estimates, no
  inferred pricing. Every displayed figure traces to a span attribute, a quota
  snapshot, or arithmetic over those. If it is a bound rather than a
  measurement, it is labelled as one (`Advice.bounded`).
- **`node:sqlite` requires `setReadBigInts(true)`.** OTel nanosecond timestamps
  exceed `MAX_SAFE_INTEGER` and the driver *throws*. Always go through
  `prepare()` in `src/schema.ts`.
- **The status bar is `<mark> TP | <state>`, and there are exactly three marks.**
  `$(pie-chart)` ready, `$(sync~spin)` working, `$(warning)` broken. The mark
  says what the *extension* is doing, never how much allowance is left —
  severity is the background colour. The click follows the mark: report when
  ready, nothing while working, the log when broken. A fourth mark, or
  `$(flame)`/`$(copilot)`/`$(graph)` anywhere in the code, fails the build.
- **Identify as `token-pie/<version>`, never as Copilot.** Probed against a
  live account: `copilot_internal/user` returns 200 for either user agent, so
  the Copilot identity buys nothing and misattributes this traffic in GitHub's
  logs.
- **The diagnostic dump strips account identifiers** (`login`,
  `analytics_tracking_id`, org lists). It exists to report an unfamiliar plan
  shape; the account it came from is not part of that.
- **Never impersonate Copilot.** No `$(copilot)` glyph, no unlabelled readouts
  of GitHub's numbers. The status bar and tooltip carry a name of our own in
  every state. See `DECISIONS.md#attribution`.
- **A floor is never an input to the projection.** Backfilled history is
  `source: 'reported'` and excluded from `burnPerDay`. Understating the burn
  rate tells someone they are safe when they are about to be cut off.
- **Materiality is measured against the allowance, never in absolute credits.**
  An absolute floor fires on a five-request user and stays silent for someone
  spending 500 a day. Add new detectors to the same rule.
- **Never compare models that do different work.** Use `substitutes()`. The
  comparing the dearest agent model against the thread-title model produced a
  saving of 88% of a bill that no user could have acted on.
- **Guards over coverage.** Refusing to report is correct when the sample is
  thin. A rate needs >1 day; a cached baseline needs ≥2 requests; a rate card
  needs ≥6 observations and R² ≥ 0.999. Do not lower these to make a card
  appear.
- **Every credit must be accounted for.** If a view splits spend, the parts sum
  to the same total the by-model table shows, or it says what is missing and
  why. A third of the bill once vanished silently between two sections.
- **One denominator per sentence.** Comparing a share of tokens against a share
  of spend requires both over the same population.
- **Never chain the first render behind the network.** `activate()` shows the
  status bar before any I/O; local ingest fills it, and the entitlement adds the
  denominator when it arrives. Every outbound request carries a timeout. See
  `DECISIONS.md#slow-start`.
- **The pipeline shares one thread with the editor.** `ingestAll` and
  `backfill` are async and yield between units of work; never make them
  synchronous again, and never add a synchronous pass over all transcripts or
  all spans. `scripts/responsive.test.mjs` fails if a refresh blocks a 5ms
  timer for more than a second.
- **Announce every phase.** A slow start must look like progress, not a hang —
  `progress.ts` plus `$(sync~spin)` in the status bar.
- **History is immutable, so read it once.** Transcript digests (size + mtime)
  persist in the store; an unchanged file is never reopened, including after a
  restart. Anything added to the scan must be incremental in the same way, and
  its bookkeeping must be prunable to the window.
- **Ingest runs every 120 seconds — keep it that cheap.** Transcripts are cached
  by path/size/mtime and skipped entirely outside the 30-day window. Re-reading
  a year of files on every tick froze the extension host for minutes.
- **A command the UI tells the user to run must change what the UI says.**
  `checkQuota()` fetched into a local and discarded it, so the status bar kept
  asking for a check that had already succeeded. See `DECISIONS.md#quota-loop`.
- **Never collapse distinct failures into one message.** "Not signed in" and
  "signed in, no metered quota" both said *run Check Quota*; the second cannot
  be resolved by running it, so the instruction has no effect.
- **Measure the render, do not eyeball it.** Screenshot the page and read the
  leftmost ink per row before claiming a layout is fixed. A ragged column read
  as "messed up" for three rounds; the pixel measurement found it in one
  (28 / 44 / 46 — a hidden swatch shifted one row and left children 2px from
  their parent). `/tmp` scripts in the ARCHITECTURE preview section show how.
- **Delete decoration that stopped meaning something.** Those swatches colour-
  coded bars that had already been removed; they survived only to misalign the
  column they sat in.
- **Label every number, every time.** This is the most repeated fault in this
  UI's history: an icon that read as a fill meter, a tile showing `275` with no
  unit, a chart column of bare credits, `23.05` with no "credits" after it. A
  number needs a unit on it or a column header over it — and a header must
  match the alignment of its cells, or it reads as belonging to the column
  beside it. `selftest.mjs` checks the alignment rule.
- **Write for a developer, not for the telemetry.** No word appears in the UI
  that a developer would not use themselves: *message*, not "turn"; *what you
  send*, not "input tokens"; *new, and cached for next time* / *repeated, from
  cache*, not "fresh"/"cached". If a label needs explaining, it is the wrong
  label. That first label is chosen from `cacheWriteTokens`, not fixed: on a
  provider that bills no cache write it reads *new, charged in full*.
- **One screen, one job.** The default view shows the verdict and what to
  change. Every breakdown lives behind a single `<details>`. Adding a section
  is not free — three open tables read as a wall, and a wall is what stops
  anyone finding the one number that mattered.
- **A breakdown is not an insight.** By-model and by-workspace tables answer
  "where did it go", which is reference material. At least one view must answer
  "what did I do that cost this", in units a developer thinks in — a request, a
  turn, a thread — never a rate per 1,000 tokens.
- **`--vscode-charts-*` are fill colours, not text colours.** Nothing
  guarantees a chart colour contrasts with anything as text; the editor's
  warning foreground is ~2.9:1 on a light theme. Text uses
  `--vscode-foreground`, `--vscode-textLink-foreground`, or a description
  colour; accents live on dots, borders and grounds, which carry no legibility
  burden. `npm run test:rendering` measures every text run in both themes.
- **Never state a cost claim in tokens.** Output bills at 4× fresh input and
  12.5× cached, so a token-weighted bar under a cost heading is wrong. Weight
  by cost, or label the units plainly.

## Hard-won findings

Each of these reversed an earlier assumption. Full evidence in `DECISIONS.md`.

| Finding | Consequence |
|---|---|
| `chatSessions.copilotCredits` omits retried/cancelled requests you were billed for (~55% shortfall) | `agent-traces.db` is primary, not the session files |
| `invoke_agent` spans repeat their child `chat` span's token counts | Ingest filters `operation_name = 'chat'`; without it every agent turn doubles |
| The prompt cache is **per model**, not per thread | Only the *first* request to a model in a thread pays full price; returning to it stays warm |
| `request_model` is already resolved — Auto is invisible in the trace DB | Selection mode is recovered from session files (`src/selection.ts`) |
| `spans.turn_index` is NULL in copilot-chat 0.62.0 | No per-turn join. Attribution is `(chat_session_id, resolved model)` |
| `maxAttributeSizeChars` defaults to `0` = **unlimited**, and three call sites ignore it | Prompts/responses persist in plaintext; `purge.ts` deletes them after ingest |
| `has_quota: false` means quota *remains* is false, not that no quota exists | Never gate on it; a spent allowance reports false. See `DECISIONS.md#has-quota` |
| A plan can return snapshots with no binding quota | Status bar shows `--` legitimately; say so instead of asking for a re-check |
| A phantom allowance is one with `entitlement: 0`, not one with `has_quota: false` | `isBinding()` tests entitlement only |
| Cost is linear in fresh/cached/output tokens, so the rate card is solvable | `pricing.ts` recovers it exactly; output is 4× fresh input and 12.5× cached |
| GPT-5.6 Luna and Terra publish a cache-write price too, but emit no `cache_creation` attribute on this account | Only Anthropic's path populates it here. Do not infer "no cache write" from a missing attribute alone |
| The solved "fresh" rate 0.25 is the published **cache-write** price ($2.50/M), not input ($2.00/M) | On sonnet, `cache_creation` covers all but 64 of the tokens that missed the cache, so the two classes are one population. Output is 5× plain input |
| Every credit figure is an exact token count x an **assumed** multiplier | `creditsPerNanoAiu` is `estimated` until `periodCoverage` returns `complete`; findings inherit that through `weakest()` and render with `~` |
| A fetched rate card never reprices earlier spend | Cards carry `effective` and accumulate; a comparison uses the card in force when the window opened, and is withheld outright when the window straddles a change |
| Cache-write counts have **no column** on `spans` — only `gen_ai.usage.cache_creation.input_tokens` | Pulled as an attribute like `nano_aiu`. Absent on providers that do not bill it, which is a fact, not a gap |
| GitHub's period spend and ours are different windows and different scopes | `reconcile.ts` `periodCoverage` compares them over the same days and names the remainder as spend this install cannot see |
| Token composition ≠ cost composition | Output was 2% of tokens but 16% of spend. Never report a cost claim by token count |
| `agent-traces.db` has no retroactive contents | History starts the day tracing is enabled. Transcripts may fill some of the gap; most carry no cost data. See `DECISIONS.md#history` |
| The whole thread is re-sent every turn | A warm turn at depth 8–15 cost 3.6× one at depth 2–3. Tracked as `depth` buckets in the store |

## Layout

```
src/
  extension.ts   activation, commands, timers, status bar. Host wiring only.
  locate.ts      finds agent-traces.db across channels/profiles
  schema.ts      real schema + the setReadBigInts() helper. START HERE.
  ingest.ts      spans -> rollups. The 'chat' filter is load-bearing. Async.
  backfill.ts    history from VS Code's transcripts, for days traces miss
  progress.ts    load phases + the yield that keeps the editor responsive
  store.ts       our rollup, versioned. Bump VERSION on any Rollup change.
  workspaces.ts  chat_session_id -> repo name
  selection.ts   (chat_session_id, model) -> auto | manual | mixed
  quota.ts       copilot_internal/user fetch (re-exports entitlement)
  entitlement.ts quota logic, deliberately vscode-free so it is testable
  projection.ts  burn rate x remaining quota -> verdict
  pricing.ts     solves the per-token rate card from sufficient statistics
  advice.ts      rollups -> ranked findings, each with its evidence.
  confidence.ts  measured | bounded | estimated, and how doubt propagates.
                 `estimated` is emitted by conversionConfidence() and combined
                 in advise(); nothing else may claim a credit figure is measured
  tuning.ts      every gate in one place, with its provenance. Settings are
                 GENERATED from it -- run `npm run sync:settings` after editing
  ratecard.ts    GitHub's published prices as data; the second opinion on the
                 solved card. Bundled snapshot, user override, weekly fetch.
                 Cards are APPENDED with an effective date, never replaced -- a
                 new price must not judge spend that predates it
  console.ts     the debug console: the conversion, the rate card, the gates
                 (marked when withholding), the pipeline. `npm run console`
  report.ts      the webview. No scripts; <details> for progressive disclosure.
  purge.ts       the only writer to a database we do not own
  sessions.ts    session-file turns; used for reconciliation, NOT for spend
  reconcile.ts   two cross-checks: units (quota delta vs session
                 credits) and scope (GitHub's period spend vs ours)
```

## Before publishing

```bash
npm run preflight        # checks the packaged .vsix, not the source
```

Source being correct does not mean the package is. Every check in there
represents something that passed an isolated review and still shipped broken --
most recently a README image that resolved only through a redirect, which the
Marketplace does not follow, so the picture silently never appeared. Run it
against the artefact you are about to upload.

## Verifying a change

```bash
npm test            # 244 checks across nine suites
                    #   entitlement  quota shapes, incl. an exhausted Business seat
                    #   projection   verdicts, and why "unknown" is three situations
                    #   advice       card arithmetic and the auto/manual split
                    #   pricing      the solved rate card and its refusals
                    #   depth        thread-depth buckets and turn ordinals
                    #   fleet        advice across differently-shaped developers
                    #   backfill     recovering history without double counting
                    #   responsive   the pipeline must not block the editor
                    #   confidence   measured / bounded / estimated, and combining
                    #   selftest     the whole pipeline on a synthetic database
npm version minor   # patch|minor|major; hooks run tests + open a changelog entry
npm run audit       # user-facing commits since the last tag vs changelog bullets
npm run build       # clean, compile, test, package, preflight
npm run preview     # render THIS machine's rollup as the panel, in a browser
npm run why         # why each recommendation did or did not appear
npm run probe       # dump the real schema on this machine
npm run verify      # confirm no plaintext content is retained
```

`npm test` must pass before any commit. The selftest builds a synthetic
`agent-traces.db`, so it runs anywhere; the probe needs a real one.

Before concluding anything about what the panel shows, run `npm run preview` and
look at it. Do not infer a section's contents from the code or from a
screenshot: a section can be empty on real data while every fixture renders it,
which is how an advice floor once suppressed every card on a live account with
the whole suite green. `npm run why` prints the gate arithmetic behind a missing
recommendation.

To see the panel without launching VS Code, render it headless — see
`docs/ARCHITECTURE.md` — *Previewing the panel*. **Look at the output.** Two layout
faults (a one-bar chart, a share bar that read as an empty meter) survived
review and were only caught by screenshotting it.

## Known gaps

- **`creditsPerNanoAiu` is calibrated against one quota delta on one plan**
  (13.5631 measured vs 13.6000 consumed). Evidence, not proof.
- **Only Free and Individual quota shapes have been seen.** Business is
  untested and is what the target org runs. This is the largest risk to the
  product: the whole headline is the quota join.
- **Advice remedies are literal prose.** The `detail` field of each card is 49
  to 83 words with zero to one computed values. Numbers generalise across
  developers; the sentences assume a chat-thread workflow. See
  `DECISIONS.md#fleet`.
- **There are three detectors.** A developer whose waste is of a fourth kind
  gets nothing — which is the right failure, but it is a limit.
- **Advice thresholds are hand-picked constants**, not derived from the
  observed distribution. The *rate card* is now solved from real data, but the
  thresholds around it (`MIN_CACHE_FACTOR`, `MIN_SHARE_AT_STAKE`, …) are still
  judgement. Deriving them needs history from several machines — blocked on
  distribution, not on code.
- **A rate card needs 6 billed requests on one model.** Below that the cache
  and model-mix cards fall back to pooled per-token averages, which are
  confounded by output mix. Both paths say which one they used.
- **`USER_FACING` in `advice.ts` is a regex over `agent_name`.** It will
  misclassify agent names nobody has seen yet.
