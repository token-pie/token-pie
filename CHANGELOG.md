# Changelog

## 0.1.7

Fixes the **What to change** section showing no recommendations on accounts with
a large allowance. A finding had to be worth 1% of the credits you have left, so
on a plan with a few thousand credits remaining nothing qualified until you were
already close to the cap. A recommendation now also appears when it accounts for
a real share of what you have actually spent.

Recommendations are still withheld below ten messages of history, where there is
not yet enough to call anything a habit.

Findings that give an upper bound rather than a measurement now say, on hover,
what the bound assumes.

Layout: recommendations no longer sit flush against each other or against the
text above them, and the advice text is shorter. Every collapsible section now
shares one header style and a clearer chevron, so it is obvious what can be
opened. **Where the credits went** is now its own section rather than appearing
to be part of **What to change**, so recommendations are no longer mixed in with
reference figures, and it now comes first — advice about spend you have not
looked at yet is hard to act on. Recommendations start collapsed.

The title carries the pie mark, and a line under it says what a credit actually
is, what it is worth, and how far back the panel keeps history, with a link to
GitHub's own documentation, and a GitHub mark linking to the repository.

Spend is now labelled **credits** everywhere; some figures previously read
`cr`.

The chart of cost by position in the chat no longer occupies the top of **What
to change**. It restated what the sentence below it already said, and a
cost-per-message figure cannot tell you whether the habit is worth changing. The
recommendation now says how much of your spend sits in long threads, and the
per-position figures moved into **Where the credits went** with the other
breakdowns. That comparison is also withheld until at least three messages sit
in each position it compares.

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
