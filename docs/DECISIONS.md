# Decisions and findings

Each entry records what was believed, what the data showed, and what changed.
They are here because every one of them reversed an assumption that looked
safe — and because an agent picking this up later will otherwise re-derive
them or, worse, undo them.

---

## The data source reversal {#source}

**Believed:** `chatSessions/*.jsonl` is the best source for spend. It records
`copilotCredits` directly, needs no configuration, and writes nothing to disk
that was not already there. The trace database is an awkward opt-in.

**Measured:** on one agent-mode session, timestamps aligned side by side —

```
time      agent            model            input   cached   out   credits
12:05:43  panel/editAgent  claude-sonnet-5   25859    24995   709   1.4249  ← in chatSessions
12:06:01  panel/editAgent  claude-sonnet-5   26803    25858   763   1.5164  ← MISSING
12:06:22  panel/editAgent  claude-sonnet-5   27800    26802   778   1.5635  ← in chatSessions
12:06:59  panel/editAgent  gpt-5.6-terra     21736        0   389   5.9007  ← MISSING
12:07:19  panel/editAgent  gpt-5.6-terra     22406    21733   379   1.0576  ← in chatSessions
12:07:33  panel/editAgent  claude-sonnet-5   30960    27799   754   2.1002  ← in chatSessions
```

| source | total |
|---|---|
| `agent-traces.db` | **13.5631** |
| quota delta (ground truth) | **13.6000** |
| `chatSessions.copilotCredits` | 6.1461 |

The missing rows sum to `1.5164 + 5.9007 = 7.4171` against a measured gap of
`7.4539`. `chatSessions` records only **completed** user turns — retried,
cancelled and superseded requests are billed but never written.

**Changed:** `agent-traces.db` became primary. `sessions.ts` survives only for
reconciliation, and its header comment claiming it is "the source of truth for
spend" is now wrong — it predates this finding.

**Also:** this is a correctness differentiator, not a feature gap. Trackers
reading `chatSessions` undercount agent work by roughly the same margin.

---

## The prompt cache is per model, not per thread {#cache}

**Believed:** switching models mid-thread cold-starts the prompt cache, so the
remedy is "finish a thread on the model you started it on."

**Measured:** ordering spans within one session —

```
gpt-5.6-luna      in 18599  cached     0   ← first use of this model
claude-sonnet-5   in 24401  cached     0   ← switch, cold
claude-sonnet-5   in 24401  cached 24400   ← warm
gpt-5.6-terra     in 21736  cached     0   ← switch, cold — 5.90 credits
gpt-5.6-terra     in 22406  cached 21733   ← warm — 1.06 credits
claude-sonnet-5   in 30960  cached 27799   ← switched BACK, still warm
```

That last row disproves the original claim. **Each model keeps its own cache.**
Only the *first* request to a given model within a thread pays full price;
returning to one used earlier stays warm. Every miss in that session is
explained by first-use.

The 5.90-vs-1.06 pair is the headline number for the whole product: near-identical
prompt sizes, **5.6×** the cost, and `cached_tokens` is per-request in
`agent-traces.db` and in no other local source.

---

## Auto mode was invisible, and it made the advice wrong {#auto}

**Believed:** the trace database's `request_model` would carry the
`copilot/auto` alias when Auto was selected.

**Measured:** `request_model` and `response_model` are identical on every row —
both already resolved. No attribute records the selection mode. But
`copilot/auto` is the single most common `modelId` in the session files on the
a test install (110 occurrences, more than any concrete model).

**Why it mattered:** the panel was advising *"claude-sonnet-5 took 66% of your
spend — worth switching away from for routine turns."* If Auto chose that
model, that is advice about a decision the user never made.

**Changed:** `selection.ts` replays the session append-log for two fields per
request (`modelId`, `result.metadata.resolvedModel`), and `selection` became a
rollup dimension. Under Auto, both the model-mix and cache-miss cards change
their remedy — the lever becomes scope and pinning, not the model picker.

**Replay gotchas** (all three bit during implementation):

- Record 0 is itself a record, `{kind, v}` — the snapshot is in `v`, not at top
  level.
- A `kind: 2` append at `k: ['requests']` carries an **array**, not one object.
- `resolvedModel` lives at `result.metadata.resolvedModel`, one level deeper
  than it looks.

---

## Output tokens cost 4x input, and the rate card can be solved for {#rate-card}

**Believed:** cost is a single opaque total per request, so composition could
only be reported by token count.

**Measured:** cost is linear in the three token classes, and every request is
one observation of that line:

```
cost = fresh x A + cached x B + output x C
```

Least squares over 7 billed `claude-sonnet-5` spans returns, in credits per
1,000 tokens:

| class | rate | relative to fresh |
|---|---|---|
| fresh input | **0.25000** | 1x |
| cached input | **0.02000** | 0.08x |
| output | **1.00001** | **4.00x** |

R² = 1.00000, max residual 0.0000 credits, four degrees of freedom. Exact round
numbers — this is the published rate card, recovered from telemetry. Verified
by hand: `24.401x0.25 + 0.342x1.00 = 6.44225` against a billed `6.4422`.

**Changed, three places:**

1. **The composition bar was misleading.** It sat under the heading "what you
   are paying for" — a cost claim — while showing token counts:

   | | by token | by cost |
   |---|---|---|
   | fresh context | 32% | **72%** |
   | cached context | 66% | **12%** |
   | model output | **2%** | **16%** |

   Output was understated eightfold. It is now weighted by cost wherever a card
   is known, and falls back to tokens with an explicit label when it is not.

   Two follow-on bugs surfaced only when the finished bar was read against the
   by-model table on live data. The bar showed the priced models alone, so
   7.90 of 23.05 credits — **34% of the bill** — vanished between two sections
   of one screen; unattributable spend is now a fourth, hatched segment. And
   the sentence beneath it divided output *tokens* by every model's tokens
   while dividing output *cost* by priced spend alone. Both rounded to 2% on
   the sample data, so the discrepancy was not visible in the output. Both denominators are now the priced subset, and a test pins the
   reconciliation.

2. **The cache multiple was wrong.** Dividing whole-request cost by input
   tokens let output cost inflate the cached side. The real penalty is
   `A / B = 12.5x`, not the 4.9x previously reported.

3. **Model comparison became a counterfactual.** Rather than dividing two
   pooled per-token averages — which conflates price with how much each model
   chose to write — the dear model's exact token basket is re-priced at the
   other model's measured rates. It stays `bounded` because whether the cheaper
   model needs more turns is not knowable from telemetry.

**Design:** only sufficient statistics are kept — a symmetric 3x3 XᵀX and a 3x1
Xᵀy per model — so the fit stays incremental like the rest of the rollup and no
requests are retained. `mergeStats` is associative, and a test pins that merged
halves equal the whole.

**Guards, because a fit can lie.** `solve()` returns `undefined` rather than a
guess when: fewer than 6 observations (3 parameters needs degrees of freedom to
spare); the system is singular (token classes that never varied independently);
any coefficient is negative; or R² < 0.999. That last one matters — a real rate
card fits *exactly*, so a mediocre fit means the model is wrong, not noisy.
Zero-cost requests are excluded entirely: they carry no rate information and
would drag every coefficient toward zero.

Note on how much of the analysis is derived rather than fixed: the rate card is
computed from the user's own spend. The advice thresholds around it remain
hand-picked constants.

---

## Content retention, and why purge exists {#privacy}

**Believed:** `github.copilot.chat.otel.captureContent: false` stops prompt and
response text being stored. This is what the documentation leads you to expect.

**Measured:** in copilot-chat 0.62.0 `captureContent` gates only the BYOK path.
The operative control is `maxAttributeSizeChars`, whose default of `0` means
**unlimited**. Three call sites call `truncate(x)` with no limit argument and
cannot be reached by configuration at all:

- `gen_ai.output.messages`
- `gen_ai.tool.definitions`
- the `tools_available` event

**Changed:** `purge.ts` deletes those payloads after each ingest. Order is
load-bearing — **probe → DELETE → `wal_checkpoint(TRUNCATE)` → VACUUM →
checkpoint**. Two bugs came from getting it wrong: deleted rows persisted in
`-wal` (800 KB) until checkpointed, and VACUUM *before* checkpoint folded stale
WAL back into the compacted file.

**Cost, measured:** a 59.6 MB backlog purges in 34 ms; steady state 2.9 ms;
no-op 0.4 ms. Under a held `BEGIN EXCLUSIVE` it reports `skippedBusy` after
289 ms and never throws.

`docs/upstream-issue.md` drafts the bug report for the three unreachable call
sites. **Not yet filed.**

---

## Ranking: measured before bounded {#ranking}

**Observed in rendering:** the model-mix card claimed `33.67 cr` and sorted
*above* the cache card's `25.57 cr`. But the model-mix figure is an upper bound
— it assumes every turn could have moved to the cheaper model, which is untrue
and is not the recommendation. A speculative saving outranked money
demonstrably already burned.

**Changed:** `Advice.bounded` marks upper bounds. Sorting puts measured
findings first *regardless of magnitude*, and bounded stakes render as
`≤ 33.67 cr` in grey so the ordering does not read as a sorting bug. Pinned by
a test asserting cache-miss ranks first despite the smaller number.

---

## Guards that exist because they failed {#guards}

| Guard | The failure it prevents |
|---|---|
| `MIN_DAYS_FOR_RATE = 1` | Was `0.5` — exactly the "one heavy afternoon" case the comment above it said to exclude. A single day's burst projected a throttle. |
| `MIN_BASELINE_REQUESTS = 2` | A single cached request is too small a sample to derive a rate from. |
| `MIN_CACHE_FACTOR = 1.5` | Ordinary variance reported as a finding. |
| `isBinding()` | `governingSnapshot` returned a phantom `premium_interactions` quota (`0/0`, `has_quota: false`) on an account with 99.2% remaining. |
| `seen: Record<id, timestamp>` | Storing bare ids meant a pass counting nothing wiped memory, and the next pass re-counted the 5-minute overlap. |
| `operation_name = 'chat'` | `invoke_agent` repeats its child's 18,183 tokens, doubling every agent turn. |

These are not tunable knobs. Lowering one to make a card appear reintroduces
the bug it was written for.

---

## Advice that survives other people's data {#fleet}

**The concern:** the detectors are hand-written, the remedy text is literal
prose, and the thresholds were chosen against a single dataset. Would any of it hold up
across a team?

**Measured** by running `advise()` against synthetic developer profiles. Three
failures, all of them confident and arithmetically correct:

| profile | what it said | why it was wrong |
|---|---|---|
| heavy user, 2,412 cr | "save 2,130 credits by switching from sonnet to gpt-mini" | gpt-mini writes thread titles; it cannot do agent work. 88% of a bill, fictional |
| light user, 2.2 cr of history | a 1.00 cr cache finding | `MIN_CREDITS_AT_STAKE = 0.5` is meaningless next to a 1,477-credit allowance |
| 15 models, none dominant | compared the 12%-of-spend model against the cheapest | with no dominant model the pairing is arbitrary |

**Changed, two things:**

1. **Materiality is measured against the allowance, not in absolute credits.**
   An absolute floor cannot generalise -- 0.5 credits is noise to someone
   spending 500 a day and half the history of someone who has made five
   requests. `MIN_SHARE_OF_ALLOWANCE = 0.01` asks the question that means the
   same thing for everyone: would fixing this move the throttle date? Without a
   known allowance it falls back to share of observed spend.

2. **Models are only compared when they do the same work.** `substitutes()`
   pairs models only if they share a user-facing `operation`, which is what
   kept the mini-model trap from firing.

**Pinned** by `scripts/fleet.test.mjs`, which asserts *silence* as much as
advice: a disciplined single-model user, a five-request user and a
completions-only user must all produce nothing. A card that appears for
everyone is not a finding.

**Still true, and worth stating plainly:** there are three detectors and the
`detail` field of each -- the remedy, 49 to 83 words -- is literal prose with
zero to one computed values in it. The numbers generalise; the advice sentences
assume a chat-thread workflow. A developer working mainly through inline
completions or the CLI gets a correct number attached to a remedy that does not
fit how they work.

---

## The quota-check loop {#quota-loop}

**Observed in testing:** the status bar said *"no quota data yet. Run
Token Pie: Check Quota"*. Running it reported *"quota check complete — 3
snapshot(s)"*. The status bar then said *"no quota data yet. Run Token Pie:
Check Quota"*. Meanwhile Copilot's own status bar read **Quota reached** — the
one moment this tool exists for.

**Three faults, stacked:**

1. **The command threw away what it fetched.** `checkQuota()` assigned to a
   local `const e`, printed it, and returned. The module-level `entitlement`
   was only ever assigned by the *silent* background refresh, so the command
   the status bar told the user to run could not, by construction, change what
   the status bar said.

2. **The account choice never stuck.** `checkQuota()` passed
   `clearSessionPreference: true` on every invocation, forcing the picker each
   time. That had been added so a user on the wrong GitHub account could switch
   — but it also meant the silent refresh afterwards had no remembered
   preference to use. It now tries the remembered account first and only forces
   the picker when that account turns out to have no Copilot access.

3. **`unknown` was one state pretending to be one situation.** "Not signed in"
   and "signed in, but every allowance came back unlimited or without a
   remaining figure" both produced the same message telling the user to run a
   command. For the second, that command has already run and cannot help. This
   is the plausible shape of a Business plan, and it is the loop with no exit.
   `Projection.unknownReason` now separates them and the tooltip says which.

**Also changed:** the notification counted snapshots, which says nothing about
whether the status bar can now show anything. It reports the outcome instead --
either the live figure, or that nothing came back with both a limit and a
remaining figure.

**Pinned** by four checks in `projection.test.mjs` covering not-signed-in,
all-unlimited, phantom-only, and limit-without-remaining.

---

## `has_quota` means "quota remains", not "a quota exists" {#has-quota}

**Believed:** `has_quota: false` marks a phantom allowance that does not apply
to this account. That reading came from a Free-plan payload where
`premium_interactions` reported `entitlement: 0, remaining: 0,
has_quota: false` beside a chat allowance with 99% intact, and
`governingSnapshot` had wrongly picked it. `isBinding` was written as
`hasQuota === true && !unlimited && entitlement > 0`.

**Measured** on an exhausted Business seat:

```
premium_interactions  entitlement=10000  remaining=0  percent_remaining=0
                      unlimited=false    has_quota=false   credits_used=19114
```

`has_quota` came back **false because the quota was spent**, next to a real
10,000-credit entitlement and 19,114 credits actually used. The Free-plan
sample could not distinguish the two readings, because there `entitlement` was
0 as well.

**Consequence:** requiring `has_quota === true` made Token Pie report "no
metered quota to project against" at the exact moment Copilot's own status bar
displayed **Quota reached**. The one state the tool exists to warn about was
the one state it could not see.

**Changed:** `isBinding` is now `!unlimited && entitlement > 0`. That still
excludes the Free-plan phantom, which has `entitlement: 0`, and it is pinned by
fixtures from both plans.

**Also added:** an `exhausted` verdict. A burn rate cannot say anything useful
once the allowance is gone, so the projection stops and the only fact that
matters -- when it comes back -- becomes the headline. The panel reports the
overage (`19,114 used against 10,000 allowed`) because the payload carries it.

---

## There is no history before you switch tracing on {#history}

**Reported:** "it isn't pulling any historical info already available on my
machine."

**Measured** against an install with roughly a year of prior Copilot use:

| source | span | volume |
|---|---|---|
| `agent-traces.db` | 2026-08-26 09:39 → 12:07 | **2.5 hours**, 45 spans |
| `chatSessions/*.jsonl` | 2025-07-26 → 2026-08-26 | **13 months**, 42 files |

`agent-traces.db` is written only from the moment the exporter setting is
enabled and holds nothing retroactively. The transcripts do reach back — but of
42 files, **38 contained no cost data whatsoever**: no `promptTokens`, no
`copilotCredits`, no `resolvedModel`. VS Code only began recording those
recently. Nothing before that is recoverable at any price.

**Changed:**

1. **`backfill.ts`** recovers what the transcripts *do* record, for days the
   trace database does not cover, capped at a rolling 30 days to match what the
   panel displays.
2. **Recovered days are marked `source: 'reported'`** and are excluded from
   `burnPerDay`. The transcripts omit retried and cancelled messages — roughly a
   55% shortfall on agent work — and an undercount in the burn rate tells
   someone they are safe when they are about to be cut off. It is a floor shown
   as history, never an input to the projection.
3. **The header states the real coverage** ("Aug 26 only") instead of claiming
   "last 30 days" over one day of data, with a note explaining that recording
   started on a given date and what the transcripts could or could not add.
4. **Diagnostics report the audit**: transcripts found, oldest, how many carry
   cost, messages recovered — so the same question can be answered on any
   machine without guessing.

**In short:** Token Pie starts from zero and becomes useful from the day it is
enabled. It cannot reconstruct earlier usage, and the panel states the date its
records begin rather than presenting an empty view.

---

## Activation appeared to hang {#slow-start}

**Reported:** the status bar item vanished, Check Quota did nothing, and after
a window reload nothing happened for several minutes -- then running Check
Quota by hand made the item appear.

**Cause, from `activate()`:**

```ts
void refreshEntitlement().then(() => refresh(false));
```

The first status bar render was chained behind a call to
`api.github.com/copilot_internal/user`. Until that resolved, nothing was ever
shown. There was no timeout on the request, so on a proxied corporate network
it could stay pending indefinitely and the extension looked dead. Running Check
Quota by hand performed its own fetch and -- after the fix that made that
command commit its result -- finally rendered the item. That is the reported
sequence exactly.

**Changed:**

1. **The item is shown synchronously in `activate()`**, before any I/O, reading
   `Token Pie …`. Nothing is chained behind the network any more: local ingest
   runs first and produces a usable panel, and the entitlement adds the
   denominator when it arrives.
2. **`fetch` carries `AbortSignal.timeout(15s)`.** A request with no deadline
   stalls every caller that awaits it.
3. **Transcripts are parsed at most once per change.** `readTurns` caches by
   path, size and mtime, and skips any file untouched since before the 30-day
   window -- so a year of old transcripts is never opened. Before this, every
   ingest re-read and re-parsed every transcript on the machine, and ingest
   runs every 120 seconds.

**Measured after:** cold ingest 30ms, subsequent ticks 13-14ms on a machine
with 43 transcripts.

**Then made asynchronous outright.** Deferring the first refresh only moved the
freeze a few milliseconds later -- the pipeline was still one synchronous pass
holding the extension host's only thread. `ingestAll` and `backfill` are now
async and yield to the event loop between units of work: one trace database,
and every eight transcripts. `progress.ts` announces each phase, and the status
bar shows it with a spinning icon:

```
$(pie-chart) TP | $(sync~spin) usage
$(pie-chart) TP | $(sync~spin) history 24/61
$(pie-chart) TP | $(sync~spin) allowance
$(pie-chart) TP | 98%
```

The order matters too: local work runs first and the allowance is fetched last,
because the network only supplies a denominator and everything else can be
answered from the machine alone.

`scripts/responsive.test.mjs` measures this rather than asserting it -- a 5ms
interval timer runs during a real refresh and the test records the longest
stretch it could not fire. Currently 30ms.

---

## Attribution — never impersonate Copilot {#attribution}

The status bar read `$(copilot) 98%`. That borrows GitHub's own mark to report
a number GitHub did not produce, and reads as a first-party Copilot readout.

**Changed:** the Copilot glyph is gone entirely rather than labelled — the mark
is the part doing the misleading. The name ships in every state, and severity
*replaces* the pie mark rather than sitting beside it so the item never widens
in the state where it most needs to be read:

```
$(pie-chart) TP | 98%                     on track
$(pie-chart) TP | 6.2d left               tight        (yellow background)
$(pie-chart) TP | 2.1d left               will exhaust (red background)
$(pie-chart) TP | 5.0d to reset           used up      (red background)
$(pie-chart) TP | $(sync~spin) history 24/61   working
$(pie-chart) TP | error                   last refresh failed
```

Three marks, and the mark answers one question: what is the extension doing?

| mark | means | click |
|---|---|---|
| `$(pie-chart)` | showing you something | opens the report |
| `$(sync~spin)` | still reading | does nothing -- there is no report yet |
| `$(warning)` | broken, or it hit errors it survived | opens the log |

Severity never touches the icon: it is the background colour, so an exhausted
allowance is `$(pie-chart) TP | 5.0d to reset` on red. Swapping the glyph for a
flame made the item hard to find in a bar that already holds the branch name
and the problem counts, and the name shortened to `TP` for the same reason --
the state after the separator is what the reader came for.

Errors a refresh *survives* count too. Per-database failures are collected
rather than thrown, so a machine where every read failed would otherwise show a
contented pie chart beside no data. Anything in `result.errors` earns the
warning mark while keeping whatever figure is available.

The hover carries the same obligation and now opens with the name.

**Still open:** the Marketplace listing has the same exposure. It needs an
explicit "not affiliated with GitHub" line before the publisher goes live.

---

## Why not build on an existing tracker {#fork}

Several Copilot usage trackers already exist, and adopting one was considered.
They read spend from `chatSessions` rather than the trace database, which is
the measurement problem described in [the data source reversal](#source): the
transcript omits retried and cancelled messages, so agent work is undercounted.
None of them join spend to the live allowance from `copilot_internal/user`;
budgets are figures the user enters.

Adopting one would have meant inheriting the undercount and rewriting the
analysis on top of it, so the differentiating parts were built directly:
accurate spend, quota-joined projection, and cache economics.

This is a note about architecture, not about the quality of anyone else's work.
