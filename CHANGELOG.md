# Changelog

## 0.7.6 - 2026-09-01

### Fixed

- no bar for a price


## 0.7.5 - 2026-09-01

### Fixed

- the sidebar block speaks the column's own language


## 0.7.4 - 2026-09-01

### Fixed

- the cost column says what it means


## 0.7.3 - 2026-09-01

### Fixed

- a row missing prices still has price columns


## 0.7.2 - 2026-09-01

### Fixed

- the columns line up with their headings


## 0.7.1 - 2026-09-01

### Fixed

- the models table reads as a table, and folds


## 0.7.0 - 2026-09-01

### Added

- what you can pick, and what each one costs


## 0.6.0 - 2026-08-31

Every figure now reads the same source GitHub bills from. Copilot stopped
writing cost onto its chat spans on 30 August, and four views that measured
spans reported the absence as fact while the month, which reads GitHub, kept
falling.

### Fixed

- today's spend is differenced from GitHub's running total, so it moves
  whenever the month does -- agent mode, the CLI, another machine, github.com
- your pace counts what was billed over the days the period has run, not what
  this machine happened to trace
- the week and period charts draw billed days where GitHub can answer for one,
  and keep measured figures for the days it cannot
- the sustainable figure counts whole days, so the last day of a period no
  longer reads as thousands of credits a day
- figures under a day count hours everywhere, including the status bar tooltip
- the activity bar glyph is the listing's pie, and parses


## 0.5.16 - 2026-08-31

- maintenance only; nothing user-facing changed.


## 0.5.15 - 2026-08-31

### Fixed

- the week and period charts draw what was billed


## 0.5.14 - 2026-08-31

### Fixed

- the pace counts what was billed, not what was measured


## 0.5.13 - 2026-08-31

### Fixed

- the day is differenced from the month, not measured separately


## 0.5.12 - 2026-08-31

### Fixed

- the sustainable line names the span it is averaged over


## 0.5.11 - 2026-08-31

### Fixed

- the tooltip counted days when the figure was hours


## 0.5.10 - 2026-08-31

### Fixed

- sustainable pace counted the hours left, not the days


## 0.5.9 - 2026-08-31

### Fixed

- the footer holds its width while it reads


## 0.5.8 - 2026-08-31

### Fixed

- the sidebar view declares its own icon


## 0.5.7 - 2026-08-31

### Fixed

- three sections in the glyph, and no icon syntax on the listing


## 0.5.6 - 2026-08-31

### Fixed

- the activity glyph is the listing's pie, cut the same way
- the glyph did not parse, so the activity bar drew nothing


## 0.5.5 - 2026-08-31

### Fixed

- on the last day the figure counts hours, not days


## 0.5.4 - 2026-08-31

### Fixed

- warnings wrap, and stop printing the Windows username
- the log promised identifiers were removed and then printed them


## 0.5.3 - 2026-08-31

### Fixed

- a failed refresh left the views showing the last good render


## 0.5.2 - 2026-08-31

### Fixed

- a failed refresh left the views showing the last good render


## 0.5.1 - 2026-08-31

### Fixed

- a failed refresh left the views showing the last good render


## 0.5.0 - 2026-08-31

### Added

- a compact view in the activity bar, beside the tab

### Fixed

- a tintable glyph for the activity bar, and three more figures in it


## 0.4.3 - 2026-08-30

Documentation only. The extension is unchanged from 0.4.2.

- **What is and is not measured, said up front.** The allowance figures come
  from GitHub and cover your whole account; the breakdown is read from what
  Copilot Chat records locally. Work started from the agents window appears
  not to be recorded, so the percentage can fall while the breakdown does not
  move. There is now a table separating what the code determines from what has
  only been observed.
- **Corrections.** The status bar examples predated the daily figure. The
  README claimed the icon encodes the verdict, when severity is the background
  colour and the icon is not. Three shipped commands were missing from the
  command table, including Token Specs. `autoPurge.busyTimeoutMs` was
  documented as a setting after it had stopped being one. The composition
  percentages were one month's data presented as a property of the tool.


## 0.4.2 - 2026-08-30

- Listing only. The Marketplace page now shows the status bar item and says
  that clicking it is what opens the panel, and two captions that quoted
  figures their own screenshots contradicted have been corrected. The
  extension itself is unchanged from 0.4.1.


## 0.4.1 - 2026-08-29

### Fixed

- **An exhausted allowance no longer blanks half the panel.** A week with
  nothing spent in it draws its seven days rather than disappearing, today's
  spend is shown even when there is no allowance left to measure it against,
  and the pace tiles keep their places when a figure cannot be computed.
- **The over-quota figure was too faint to read.** "9,114 credits over" took
  its red from a chart colour, which measured 3.36:1 against a light theme
  where 4.5:1 is the floor for text that size.


## 0.4.0 - 2026-08-29

### Added

- today's spend against a budget, beside the month's remainder
- explain the daily figure, and fix its denominator again
- the credit definition hangs off a figure, not the card
- two columns, one for the month and one for the days
- how the month was spent, not just how much

### Fixed

- say which direction the day figure runs
- the day caption dropped its unit and invented a decision
- a budget that shrinks as you spend cannot be spent to the line
- name which quota each percentage is a share of
- the hint pushed the card apart instead of sitting over it
- the verdict card was mostly the spaces between things
- the verdict sentence took a row to itself for no reason


## 0.3.3 - 2026-08-28

### Fixed

- a day key is a local day, and half the code read it as UTC
- an empty database is not a broken install, and notes need room


## 0.3.2 - 2026-08-28

### Fixed

- ingest looked for a span name the database may not use
- coverage judged history, not what was actually recorded
- one model is one row, and a floor says it is a floor


## 0.3.1 - 2026-08-28

### Fixed

- the rate note said "that" with nothing to point at


## 0.3.0 - 2026-08-28

### Added

- reconcile github's period spend against ours on the panel
- make every gate a setting, with its provenance
- publish the prices and the gates as things you can see and set
- the console answers before it explains
- three settings, fourteen rules, and prices that keep checking
- a week beside the verdict, instead of a run of days below it

### Fixed

- name the cache-write premium the fresh-input row was hiding
- date the rate card so a price change cannot reach backwards
- a credit figure is no better than the conversion behind it
- give the hero figure room, and a way into the console
- the console's table, its spacing, and a withheld comparison
- the rate card was two tables pretending to be one
- one spacing scale, and a test that measures it
- chart colours are fills, and I kept using them as text
- headless runs were fighting the browser you had open
- write previews where the browser can read them
- select the group blurb through its parent, not by class alone
- a price list that is not published yet is not a failure
- the rendering harness leaked a Chrome process on every run
- drop TP from the status bar, and say which way the percent runs
- the narrow-layout check was testing the wide layout


## 0.2.1

### Added

- **What each conversation cost.** By project and by model both report an
  average; two sessions in the same project measured 2.25 and 1.56 credits a
  message. **Where the credits went** now breaks spend down by conversation,
  with cost per message beside it, labelled by project and start time.

## 0.2.0

### Added

- **Thinking you are billed for but never see.** Models that reason before
  answering charge for that text at the output rate, and it was invisible. It
  now appears under **Copilot's replies** as *thinking, never shown* — measured
  at 15% of reply cost on real usage. Models that report none show no row.
  **By model** also carries a thinking column, so the difference is visible
  where you choose between models — measured here at 15% and 24% for two models
  against none for the other two.
- **What input and output actually cost, in one sentence.** The breakdown showed
  that replies are a sliver of your tokens and a slab of your bill, but left you
  to work out the ratio. It now says it: measured on your own messages, a token
  Copilot writes costs 4x one you send new and 50x one it reads back from cache.
  The breakdown also carries a **Per token** column — `1x` for new input, `0.08x`
  from cache, `4x` for replies — so the price sits beside the volume and the cost
  instead of having to be worked out from them. Its two share columns are named
  **% of spend** and **% of text** rather than both being called *Share*.
- **By model** and **By project** now show how many tokens each accounted for,
  which is what explains why a total is the size it is.

## 0.1.7

### Fixed

- **Recommendations never appeared on accounts with a large allowance.** A
  finding had to be worth 1% of the credits remaining, so on a plan with a few
  thousand left nothing qualified until you were already near the cap — the
  **What to change** section stayed empty however much you spent. A
  recommendation now also appears when it accounts for a real share of what you
  have actually spent.
- The timestamp beside the title no longer drifts out of line with it.

### Changed

- **Where the credits went** is its own section and now comes first; advice
  about spend you have not looked at yet is hard to act on. It was previously
  indistinguishable from a recommendation.
- Recommendations start collapsed, share one header style with the breakdowns,
  and carry a clearer chevron so it is obvious what can be opened.
- Spend is labelled **credits** everywhere; some figures previously read `cr`.
- The chart of cost by position in the chat no longer occupies the top of
  **What to change** — it restated the sentence beneath it, and a
  cost-per-message figure cannot tell you whether the habit is worth changing.
  The recommendation now says how much of your spend sits in long threads, and
  the per-position figures moved into **Where the credits went**.
- Advice text is shorter, and sections no longer sit flush against each other.

### Added

- A line under the title saying what an AI Credit is, what it is worth, and how
  far back the panel keeps history, linking to GitHub's own documentation.
- The pie mark on the title and the report tab, and a GitHub mark linking to the
  repository. Links open in your browser rather than replacing the panel.
- Findings that give an upper bound rather than a measurement now say, on hover,
  what the bound assumes.

### Withheld rather than guessed

- No recommendations below ten messages of history — not enough to call anything
  a habit.
- The cost-by-position comparison needs at least three messages in each position
  it compares; it previously stated a multiple from as few as two.

## 0.1.6

The extension now identifies itself to GitHub under its own name rather than
Copilot's. Diagnostics no longer print your account name or tracking id.

## 0.1.5

Fixes the screenshots not appearing on this page.

## 0.1.4

Fixes a crash when more than one VS Code window is open. Each window keeps its
own copy of the extension writing to the same file, and they could collide on
the temporary file used to save it, leaving one window reporting an error and
no usage recorded. Each write now uses its own temporary file, and a refresh
already under way is joined rather than started again.

Paths written to the log are shortened to `~` so the log can be shared without
carrying your account name.

## 0.1.3

Local, machine-wide visibility into GitHub Copilot spend, with a throttle
projection joined to your live allowance.

### What it does

- **Answers "will I be throttled?"** Measured burn rate against the allowance
  remaining on your account, projected at the reset date. The status bar carries
  the verdict; clicking it opens the report.
- **Says what to change**, with the measurement attached — including how much
  more a message costs later in a long conversation, and what a cold prompt
  cache costs against a warm one.
- **Shows where the credits went** — by kind of text, by model, by project, and
  by whether you or Auto chose the model.

### Where the numbers come from

- Spend is read from the cost Copilot reports per request, not estimated from a
  price list, and not from the chat transcript's own credit figure, which omits
  messages you retried or cancelled and were still charged for.
- Per-token prices are solved from your own billed messages, so composition is
  weighted by what each kind of token actually costs rather than by token count.
- Nothing leaves the machine apart from one call to the endpoint Copilot itself
  uses, to read your remaining allowance.

### Setup

Trace collection is off by default and Copilot keeps no cost history from
before you enable it. Run **Token Pie: Enable Local Trace Collection**, then
**Token Pie: Check Quota**. See the README for what is stored on disk and how
to keep prompt text out of it.

### Known limits

- History begins the day you enable collection. Up to 30 days is recovered from
  VS Code's own chat transcripts where they recorded cost, marked as a floor and
  excluded from the projection.
- The credit conversion is calibrated against a single reconciliation; check
  absolute figures against your billing dashboard.
- Free, Individual and Business plans are covered by recorded fixtures.
  Enterprise is unverified.
- Advice is derived from your own data, but the remedies assume a chat-thread
  workflow; inline completions and the CLI are not covered.
