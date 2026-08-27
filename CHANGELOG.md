# Changelog

## 0.1.1 — documentation and test isolation

No change to how the extension behaves.

- Reworded the documentation and source comments: removed references to
  specific machines and environments, and replaced subjective asides with the
  technical reasoning behind each decision.
- Replaced a section comparing a named third-party extension with a neutral
  note on why the trace database was chosen over the chat transcripts.
- Fixed test isolation: fixture-based runs read the real user directories
  through `backfill`, so live chat transcripts could leak into their counts.
  Session directories are now injectable and the pipeline tests pass `[]`.

## 0.1.0 — first public release

Local, machine-wide visibility into GitHub Copilot spend, with a throttle
projection joined to your live allowance.

### What it does

- **Answers "will I be throttled?"** — measured burn rate against the remaining
  allowance read from GitHub, projected at the reset date. The status bar shows
  the verdict; clicking opens the report.
- **Says what to change**, with the measurement attached. Every finding carries
  the numbers behind it and states whether they are exact or a bound.
- **Shows where the credits went** — by kind of text, by model, by project, and
  by whether *you* or Auto chose the model.

### Where the numbers come from

- Spend is read from `copilot_chat.copilot_usage_nano_aiu`, the cost Copilot
  reports per request — not estimated from a price list, and not the chat
  transcript's `copilotCredits`, which omits the messages you retried or
  cancelled and were still charged for (~55% short on agent work).
- **Per-token prices are solved from your own billed messages**, so composition
  is weighted by what each kind of token actually costs. On measured data
  output bills at 4× fresh input and 12.5× cached.
- Nothing leaves the machine. One network call, to the endpoint Copilot itself
  uses, for your remaining allowance.

### Known limits

- **History starts the day you enable trace collection.** Copilot keeps none
  from before that. Up to 30 days is recovered from VS Code's own chat
  transcripts where they recorded cost, marked as a floor and excluded from the
  projection.
- `tokenPie.creditsPerNanoAiu` is calibrated against a single quota
  reconciliation. Check absolute figures against your billing dashboard.
- Free, Individual and Business plans are covered by recorded fixtures,
  including an exhausted Business seat. Enterprise is unverified.
- Advice is derived from your own data, but the remedies are written for a
  chat-thread workflow; inline completions and the CLI are not covered.

### Privacy

Copilot's trace database stores prompt and response text in plain text, and
`captureContent: false` does not stop it. Setup sets
`maxAttributeSizeChars` to 1, and Token Pie deletes the payloads that setting
cannot reach after every ingest. See **Content capture** in the README before
enabling this anywhere but your own machine.
