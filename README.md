# Agentic Usage — Splunk Dashboard App

**Vendor-neutral team observability for agentic coding harnesses.** One pair of
dashboards — tokens, cost, adoption, live sessions — that works identically
whether your team runs **Claude Code, Claude Desktop, Cowork, Gemini CLI, or
OpenAI Codex CLI**, because every harness's telemetry is normalized upstream to
the OpenTelemetry GenAI semantic conventions by the
[`ai-harness-otel`](https://github.com/sispehar/ai-harness-otel) collector
config. The dashboards query only that normalized contract (`gen_ai.*` /
`agentic.*` names) and never touch harness-native naming.

Built entirely from 10 custom Canvas/DOM visualizations (no native Splunk
panels), dark + light theme, Dashboard Studio v2.

## Dashboards

- **Overview** — distinct users, total tokens, cost, net lines of code, cache
  hit ratio, team leaderboard, token timeline, rate-limit friction, adoption,
  model mix, activity heatmap, and the **Harness Mix** donut (token share per
  harness).
- **Sessions** — live session board (context fill %, per-session cost/tokens/
  tools), active sessions/users, burn rate, top sessions, event feed, live
  ticker.

Both carry a **Harness** filter (All / Claude Code / Claude Desktop / Cowork /
Gemini CLI / Codex) and a user filter.

## What's inside

| Path | Role |
|---|---|
| `agentic_usage/` | The deployable Splunk app (dashboards, conf, built viz bundles) |
| `examples/cu_*/` | Source of truth for the 10 visualizations (standalone viz apps) |
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
- `` `harness_label(1)` `` → display name per `service.name` value. **Adding a
  harness to the collector? Add its label here and (optionally) a dropdown
  entry in the two dashboards — that's the whole app-side change.**

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
  without the header its usage lands under `user.email="unknown"`.

The normalized contract (event names, `gen_ai.*` attributes, metric names,
divergences from the spec) is documented in
[ai-harness-otel/NORMALIZATION.md](https://github.com/sispehar/ai-harness-otel/blob/main/NORMALIZATION.md).

## Known per-harness gaps (iteration 1)

- **Cost is Claude-only** — Gemini/Codex report no cost telemetry, so the cost
  KPI, burn rate, and leaderboard cost column under-count for them.
- **Codex** reports no terminal type (board shows "—") and fewer event kinds
  (no compaction/subagent/permission events); its per-response `input_tokens`
  may be cache-inclusive, so context-fill % is approximate.
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

## License

Apache-2.0
