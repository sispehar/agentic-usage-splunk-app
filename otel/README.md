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
   #   ../ai-harness-otel/config/collector.yaml
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
     --config ../ai-harness-otel/config/collector.yaml \
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
→ expect `agentic.token.usage`, `agentic.cost.estimated`,
`agentic.code.lines.changed`, `agentic.session.started`,
`agentic.active_time`, `agentic.vcs.commit.created`, and other cataloged
metrics. Native `gen_ai.client.token.usage` Histograms may also be present,
along with `otelcol_*` self-metrics.

```spl
index=agentic | stats count by event.name, service.name
```
→ expect normalized full names (`agentic.api_request`, `agentic.user_prompt`,
`agentic.tool_result`, `agentic.tool_decision`, `agentic.session_started`, …)
plus harness-prefixed pass-throughs
(`claude_code.*`, `gemini_cli.*`, `codex.*`) — and one row per active harness
in `service.name`.

Accounting sanity check: overall token totals must use the custom additive Sum
and exclude overlapping subsets:

```spl
| mstats sum(_value) AS tokens WHERE index=agentic_metrics metric_name="agentic.token.usage" BY agentic.token.relationship agentic.token.type service.name
| where 'agentic.token.relationship' IN ("total", "exclusive")
| stats sum(tokens) BY service.name
```

Never add `subset` series (cache-read or reasoning) to their corresponding
totals.

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
