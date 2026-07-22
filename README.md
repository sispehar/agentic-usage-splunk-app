# Agentic Usage — Splunk Dashboard App

**Vendor-neutral team observability for agentic coding harnesses.** One pair of
dashboards — tokens, cost, adoption, live sessions — that works identically
whether your team runs **Claude Code, Claude Desktop, Cowork, Gemini CLI, or
OpenAI Codex CLI**, because every harness's telemetry is normalized upstream to
the OpenTelemetry GenAI semantic conventions by the
[`ai-harness-otel`](https://github.com/sispehar/ai-harness-otel) collector
config. The dashboards query only that normalized contract (`gen_ai.*` /
`agentic.*` names) and never touch harness-native naming.

Built entirely from 11 custom Canvas/DOM visualizations (no native Splunk
panels), dark + light theme, Dashboard Studio v2.

## Dashboards

- **Overview** — distinct users, total tokens, estimated cost, net lines of code, cache
  hit ratio, team leaderboard, token timeline, rate-limit friction, adoption,
  model mix, activity heatmap, and the **Harness Mix** donut (token share per
  harness).
- **Sessions** — live session board (context fill %, per-session estimated cost/tokens/
  tools), active sessions/users, burn rate, top sessions, event feed, live
  ticker.
- **Data Health** — the setup screen: an ingest checklist (collector →
  harness metrics → events → identity) with per-step instructions, ingest-rate
  timeline, and per-harness last-seen board. See
  [First run: Data Health](#first-run-data-health).

Overview and Sessions carry a **Harness** filter (All / Claude Code / Claude
Desktop / Cowork / Gemini CLI / Codex) and a user filter. While no telemetry
is arriving, both show a banner linking to Data Health; the banner disappears
on its own once data flows.

## What's inside

| Path | Role |
|---|---|
| `agentic_usage/` | The deployable Splunk app (dashboards, conf, built viz bundles) |
| `examples/cu_*/` | Source of truth for the 11 visualizations (standalone viz apps) |
| `shared/` | Embedded fonts + light-theme CSS prepended to every viz at build |
| `otel/` | Splunk deployment overlay for the ai-harness-otel collector base + deploy doc |
| `test-harness.html` | Browser-based viz test harness (see TEST-HARNESS.md) |
| `.claude/skills/splunk-viz/` | Claude Code skill used to develop the visualizations |

## The visualizations

| Viz | Type (`agentic_usage.*`) | Used for |
|---|---|---|
| KPI Tile | `cu_kpi` | Single hero numbers with accent + delta |
| Leaderboard | `cu_leaderboard` | Per-user tokens / cost / cache table |
| Stat Panel | `cu_stat` | Number + progress bar / key-value pairs |
| Area Chart | `cu_area` | Token usage over time by type |
| Donut | `cu_donut` | Model mix, harness mix |
| Heatmap | `cu_heatmap` | Tokens by day × hour |
| Ranked Bars | `cu_bars` | Top sessions |
| Activity Feed | `cu_feed` | Session events (errors, compactions, agents) |
| Session Board | `cu_sessions` | Live session rows with context-fill meter |
| Live Ticker | `cu_ticker` | Scrolling activity strip |
| Checklist | `cu_checklist` | Ingest setup ladder + self-hiding no-data banner |

## Requirements

- Splunk Enterprise **10.4** (verified), Dashboard Studio v2
- Node 16+ to build the visualizations
- An OpenTelemetry Collector running the
  [ai-harness-otel](https://github.com/sispehar/ai-harness-otel) normalization
  config (otelcol-contrib ≥ 0.156 or Splunk OTel Collector)

## Build & install

```bash
./agentic_usage/build.sh          # builds all vizs, merges, packages dist/agentic_usage.tar.gz
```

Install via **Apps → Manage Apps → Install app from file**, then restart (or
bump `_bump`) so the custom visualizations register.

## Splunk setup

### Indexes

The collector writes to two indexes (names are only referenced through macros —
see below):

```ini
# indexes.conf
[agentic]
homePath   = $SPLUNK_DB/agentic/db
coldPath   = $SPLUNK_DB/agentic/colddb
thawedPath = $SPLUNK_DB/agentic/thaweddb

[agentic_metrics]
homePath   = $SPLUNK_DB/agentic_metrics/db
coldPath   = $SPLUNK_DB/agentic_metrics/colddb
thawedPath = $SPLUNK_DB/agentic_metrics/thaweddb
datatype   = metric
```

`agentic_metrics` **must** be a metric index (`datatype = metric`) — the
Overview panels are `mstats` queries and return nothing from an event index.
Create a HEC token with access to both.

### Macros (single edit points)

`agentic_usage/default/macros.conf` — override in `local/macros.conf`:

- `` `agentic_data` `` → `index=agentic` (events)
- `` `agentic_metrics` `` → `index=agentic_metrics` (metrics)
- `` `harness_key(2)` `` → canonical harness key used by every filter and
  grouping. Prefers a well-known `service.name` (that's what tells Claude
  Code / Claude Desktop / Cowork apart — they share one collector lane), falls
  back to the collector's stable `agentic.harness.name` discriminator so a
  custom `OTEL_SERVICE_NAME` still lands in the right bucket, and keeps the
  raw `service.name` for unrecognized producers.
- `` `harness_label(1)` `` → display name per harness key. **Adding a harness
  to the collector? Add it to `harness_key(2)`, `harness_label(1)`, and the
  Harness dropdown items in the two dashboards — that's the whole app-side
  change.**

### Context-window lookup

`agentic_usage/lookups/agentic_model_context.csv` maps model-name wildcards to
context-window sizes (used by the Sessions board's context-fill %). First
match wins, unmatched models fall back to 200 000. Tune by editing the CSV
(e.g. when a new model family ships).

## Getting data in

Deploy the normalizing collector and point every harness at it — full
instructions in [`otel/README.md`](otel/README.md) and the
[ai-harness-otel README](https://github.com/sispehar/ai-harness-otel). The
short version:

- **Claude Code / Claude Desktop / Cowork** — `CLAUDE_CODE_ENABLE_TELEMETRY=1`,
  `OTEL_METRICS_EXPORTER=otlp`, `OTEL_LOGS_EXPORTER=otlp`,
  `OTEL_EXPORTER_OTLP_ENDPOINT=https://<collector>:4317`. On Team/Enterprise,
  set these once in **managed settings** (admin console or
  `managed-settings.json` via MDM) — nobody configures their own laptop.
- **Gemini CLI** — `settings.json` `telemetry` block (`enabled`, `target:
  "local"`, `otlpEndpoint`). `user.email` appears only with Google auth;
  otherwise the anonymous installation id is used.
- **Codex CLI** — `config.toml` `[otel]`: set `exporter`, **`metrics_exporter`**
  (defaults to OpenAI's own `statsig`!), and `trace_exporter` to `otlp-grpc`,
  plus the **`x-user-email` header** — Codex has no built-in user identity, and
  without the header its `user.email` remains absent.

The normalized contract's exhaustive backend-facing catalog is documented in
[ai-harness-otel/ATTRIBUTE_REFERENCE.md](https://github.com/sispehar/ai-harness-otel/blob/main/ATTRIBUTE_REFERENCE.md),
with mapping behavior and failure modes in
[NORMALIZATION.md](https://github.com/sispehar/ai-harness-otel/blob/main/NORMALIZATION.md).

The dashboards use the additive `agentic.token.usage` Sum for cross-harness
accounting. Searches include only `total` and `exclusive`
`agentic.token.relationship` values in overall totals; `subset` categories are
used only for breakdowns such as cache ratio. This avoids counting cached or
reasoning tokens twice.

## First run: Data Health

Install the app before any telemetry exists — that's the expected order. Open
**Data Health** (third nav entry) and work the checklist top-down; each step
turns OK as the pipeline comes up:

1. **Collector → Splunk** — the collector's own `otelcol_*` self-metrics reach
   `agentic_metrics` (proves otelcol is running and HEC export works, even
   before any harness connects).
2. **Harness metrics** — `agentic.token.usage` datapoints arrive.
3. **Agent events** — `agentic.*` events arrive in `index=agentic`.
4. **User identity** — the share of metric datapoints carrying
   `user.email`/`user.id`.

Each failing step shows its fix inline (collector env vars, per-harness
telemetry settings, logs exporter, identity headers). Until steps 1–3 pass,
Overview and Sessions display a banner linking here; it renders nothing once
data flows. After setup, the page stays useful as ingest observability:
metric/event volume tiles, a 24 h ingest-volume timeline, and a per-harness
last-seen board (OK ≤ 1 h · WARN ≤ 24 h · ERROR older).

Dashboard-editor note: the banner is an invisible block overlaid on each
dashboard's top row (last entry in the layout `structure` array) — in the
Studio editor it sits above the KPI tiles by design.

## Deployment invariants & data caveats

The searches assume a few things about how the collector is deployed. Violating
them doesn't error — panels silently show less, so read this once:

- **Per-user panels need identity on *metrics*.** The Overview's user dropdown,
  DISTINCT USERS, leaderboard, and adoption panels group metric datapoints by
  `user.email`/`user.id`. The collector's optional
  `low-cardinality-metrics.yaml` profile strips exactly those from metric
  resources — do **not** deploy that profile with this app. (The Sessions
  board is log-based and unaffected; logs always retain identity.)
- **Custom `OTEL_SERVICE_NAME` values** are folded into their canonical
  harness bucket via `agentic.harness.name` (see `harness_key(2)`), so they
  stay filterable — but within the Claude lane they can't be told apart from
  Claude Code proper, since Desktop/Cowork are distinguished only by their
  well-known service names. Prefer leaving `OTEL_SERVICE_NAME` unset.
- **The Contract drift panel** (Overview, bottom row) counts the drift
  signatures NORMALIZATION.md tells consumers to watch: `agentic.token.usage`
  points missing `agentic.token.type`/`agentic.token.relationship`,
  `agentic.api_request` events without `gen_ai.usage.input_tokens`, raw source
  keys surviving on normalized events (`input_tokens`, `*_token_count`,
  `cost_usd*`, `duration_ms`, `model`, …), events that kept a harness-prefixed
  name that previously normalized, and `agentic.change.type` values the LOC
  panel doesn't recognize. Anything > 0 means the collector pin and the
  harness version have drifted apart and every other number on the page may
  under-count. This is the one panel that deliberately probes non-contract
  key names (fail-open drift evidence per NORMALIZATION.md), and it ignores
  the User/Harness filters — drift is pipeline-global.
- **Producer-defined enum values in SPL** (values, not names, so outside the
  versioned contract): NET LINES OF CODE assumes `agentic.change.type` is
  `added`/`removed` (both Claude and Gemini pass their `type` through
  verbatim; unrecognized values surface in the drift footnote instead of
  being silently dropped), and the Sessions board's context-fill estimate
  prefers Claude's `agentic.query.source="repl_main_thread"` requests, with a
  null-safe fallback for harnesses that don't emit `query.source`.
- **Claude emits no `agentic.session_started` *event*** (metric only) — the
  Sessions ticker never shows "started a session" for Claude-family
  harnesses; SESSIONS TODAY uses the metric and covers all harnesses.
- **The Sessions time picker drives only the user dropdown** — every panel
  pins its own live window (30 m / 60 m / today / 4 h / 24 h) by design.

## Known per-harness gaps (iteration 1)

- **Estimated cost is Claude-only** — Gemini/Codex report no cost telemetry
  (and the pinned GenAI semconv defines no cost convention at all). The cost
  KPIs are labeled "· CLAUDE ONLY" on the dashboards, show `n/a` when the
  Harness filter is Gemini CLI/Codex, and the leaderboard/session-board cost
  columns render `—` for users or sessions with no cost datapoints, so "no
  data" is never displayed as `$0`.
- **Provider** appears on the session board only when the harness reports
  `gen_ai.provider.name` (or a trusted gateway supplies it). The collector does
  not infer provider from the harness vendor.
- **Codex** reports fewer event kinds (no compaction/subagent/permission
  events); its per-response input total can make context-fill % approximate.
  Legacy (pre-0.128) Codex synthesis emits token points without a model
  dimension — they land in the AI Models donut's "Unknown" slice — and its
  `source_specific` cache-creation category is excluded from totals, exactly
  as the relationship contract prescribes.
- **Lines of code** come from Claude and Gemini only; commits/PRs from Claude
  only.

## Developing a visualization

Viz source lives in `examples/{viz}/` — never edit the merged copies under
`agentic_usage/appserver/` (regenerated by the build). Use the browser harness:

```bash
python3 -m http.server 8080   # then open test-harness.html
```

See `TEST-HARNESS.md`, `EMBEDDING.md`, and the `splunk-viz` skill for the full
workflow.

Validate every production data-source search against a sibling collector
checkout before committing:

```bash
scripts/validate-dashboard-contract.rb ../ai-harness-otel/ATTRIBUTE_REFERENCE.md
```

## License

Apache-2.0
