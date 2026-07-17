# Collector deployment (Splunk)

The dashboards in this app query **only** the normalized telemetry contract
produced by [`ai-harness-otel`](https://github.com/sispehar/ai-harness-otel) —
`gen_ai.*` semconv names plus the documented `agentic.*` namespace. The
normalization logic lives there; this directory holds only the thin Splunk
overlay ([`splunk.yaml`](splunk.yaml)).

## Deploy

1. **Get the normalization base** (pin it — the contract and the dashboards
   move together):

   ```bash
   git clone https://github.com/sispehar/ai-harness-otel
   # or, during local development, use the sibling checkout:
   #   ../ai-harness-otel/config/normalize.yaml
   ```

2. **Create the Splunk indexes** (see the main README): `agentic` (events) and
   `agentic_metrics` (**datatype = metric**), plus a HEC token.

3. **Run a collector distribution that bundles `splunk_hec`, `transform`,
   `filter`, `cumulativetodelta`, `sum`, and `count`** (otelcol-contrib ≥ 0.156
   or the Splunk OTel Collector — check with `otelcol components`):

   ```bash
   export SPLUNK_HEC_TOKEN=...
   export SPLUNK_HEC_URL=https://<splunk-host>:8088/services/collector
   otelcol-contrib \
     --config ../ai-harness-otel/config/normalize.yaml \
     --config otel/splunk.yaml
   ```

4. **TLS**: `splunk.yaml` expects certs at `/etc/otel/certs/` for the OTLP
   receiver — adjust or delete the `tls:` blocks for a trusted network.

5. **Point the harnesses at the collector** — per-harness client config
   (Claude env vars / managed settings, Gemini `settings.json`, Codex
   `config.toml` incl. the **`x-user-email` identity header**) is documented in
   the ai-harness-otel README and summarized in this repo's main README.

## Verify

```bash
curl http://<collector-host>:13133          # health check
```

In Splunk:

```spl
| mcatalog values(metric_name) WHERE index=agentic_metrics
```
→ expect `gen_ai.client.token.usage`, `agentic.cost.usage`,
`agentic.lines_of_code.count`, `agentic.session.count` (+ `agentic.active_time.total`,
`agentic.commit.count`, … and `otelcol_*` self-metrics).

```spl
index=agentic | stats count by event.name, service.name
```
→ expect normalized short names (`api_request`, `user_prompt`, `tool_result`,
`tool_decision`, `session_start`, …) plus harness-prefixed pass-throughs
(`claude_code.*`, `gemini_cli.*`, `codex.*`) — and one row per active harness
in `service.name`.

Double-count sanity check (per harness, same time window): event-side
`stats sum('gen_ai.usage.input_tokens')` vs
`| mstats sum(_value) WHERE index=agentic_metrics metric_name="gen_ai.client.token.usage" gen_ai.token.type=input`
should agree within an export interval.

## Notes

- The **merge rule** that bites: collector config lists replace wholesale.
  `splunk.yaml` restates every pipeline's `exporters` (keeping the `sum` +
  `count` connectors on logs) and the metrics pipeline's `receivers`. When the
  base adds a pipeline stage (e.g. a 4th harness transform), nothing here
  needs to change — processor lists are NOT restated.
- Collector self-metrics (`otelcol_*`) land in `agentic_metrics` by design;
  every dashboard query filters on `metric_name`.
- `deployment.environment` is expected from the **clients** (e.g.
  `OTEL_RESOURCE_ATTRIBUTES=deployment.environment=prod` in managed settings)
  if you want per-environment splits.
