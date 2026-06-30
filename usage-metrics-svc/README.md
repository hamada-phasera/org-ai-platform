# usage-metrics-svc

A small, read-only Go service that aggregates org-ai-platform's LLM-call logs
(`AILog`) into cost / latency KPIs and serves them over HTTP.

> **Read-only by contract.** This service reads the `AILog` table and never
> writes to it. It is deployed and operated independently of the main platform
> (AWS App Runner / ECS Fargate), so it can be iterated and load-tested without
> touching the production Render/Vercel stack.

## Why it exists

The platform already exposes basic stats at `GET /governance/stats`
([api-gateway](../apps/api-gateway/src/routes/governance.ts)), but that endpoint
loads **every** matching row into Node and reduces in JavaScript — O(rows)
memory, no index strategy, no rollup. This service is the same KPIs done
properly: aggregation pushed into SQL, a daily rollup table, and an async worker
that maintains it — so it stays flat as `AILog` grows.

## Data source: the real `AILog` schema

Verified against the live Neon DB, the Prisma model, and the writer
([audit_logger.py](../apps/ai-engine/app/governance/audit_logger.py)):

| column        | type                          | notes                                   |
|---------------|-------------------------------|-----------------------------------------|
| `id`          | text PK                       |                                         |
| `"orgId"`     | text NOT NULL                 | **tenant identifier** (external: `tenant_id`) |
| `department`  | text NOT NULL                 | 営業部 / SNSマーケ部 / 経理部 …          |
| `provider`    | text NOT NULL                 | e.g. `anthropic`                        |
| `model`       | text NOT NULL                 | e.g. `claude-haiku-4-5`                 |
| `tokens`      | int **NULL**                  | **combined input+output total** (no split) |
| `"latencyMs"` | int **NULL**                  |                                         |
| `"createdAt"` | `timestamp without time zone` | treated as **UTC** for day bucketing    |

Identifiers are quoted PascalCase/camelCase — the pgx reader (PHASE 3)
centralizes them as constants so a rename is a one-line change.

## Cost derivation

`AILog` has **no cost column**, and `tokens` is a single combined total, so cost
is derived from **one blended USD/1M-token rate per model** (config, overridable).
Defaults are the midpoint of Anthropic's published input/output list prices:

| model              | input $/MTok | output $/MTok | blended (default) |
|--------------------|-------------:|--------------:|------------------:|
| `claude-haiku-4-5` | 1.00         | 5.00          | **3.00**          |
| `claude-sonnet-4-6`| 3.00         | 15.00         | **9.00**          |
| `claude-opus-4-8`  | 5.00         | 25.00         | **15.00**         |
| `claude-fable-5`   | 10.00        | 50.00         | **30.00**         |

Matching is by family substring, so model-id drift keeps resolving. Unknown
models use a fallback rate and are surfaced in `unknownModels`.

## API

```
GET /metrics/usage?tenant_id=<org>&from=<ts>&to=<ts>
GET /healthz
```

- `tenant_id` **required** → 400 `MISSING_TENANT_ID` if absent.
- `from` / `to` optional (RFC3339 or `YYYY-MM-DD`); default window = last 30 days.
  Window is half-open `[from, to)`.
- Envelope matches the platform: `{ "success": true, "data": {...} }` /
  `{ "success": false, "error": { "code", "message" } }`.

Example:

```bash
curl 'http://localhost:8080/metrics/usage?tenant_id=demo-org'
```

```json
{
  "success": true,
  "data": {
    "tenantId": "demo-org",
    "from": "2026-05-31T...Z",
    "to": "2026-06-30T...Z",
    "totals": { "calls": 6, "tokens": 18500, "costUsd": 0.1935,
                "avgLatencyMs": 2150, "p95LatencyMs": 5200 },
    "byDayProvider": [ { "date": "2026-06-30", "provider": "anthropic",
                         "calls": 3, "tokens": 8800, "costUsd": 0.0588,
                         "avgLatencyMs": 1350, "p95LatencyMs": 2300 } ],
    "byDepartment": [ { "department": "経理部", "calls": 2, "tokens": 8800, "costUsd": 0.132 } ]
  }
}
```

`p95` uses the nearest-rank method. Nil `tokens` count as a call but add 0
tokens/cost; nil `latencyMs` is excluded from avg/p95 denominators.

## Architecture

```
cmd/server            → wiring, :8080, graceful shutdown
internal/domain       → UsageRow, UsageReport, Pricing (no deps)
internal/aggregate    → Aggregate() — pure, table-driven tested
internal/repository   → UsageRepository interface
                        ├─ memory.go  (in-memory fake; tests + local dev)
                        └─ postgres.go (pgx reader — PHASE 3)
internal/service      → fetch → aggregate → annotate window
internal/httpapi      → HTTP handlers + envelope
```

The `UsageRepository` seam means the aggregation logic is identical whether rows
come from the in-memory fake or Postgres — tests run green with zero DB.

## Run / test

```bash
export PATH="/opt/homebrew/bin:$PATH"   # if go isn't on PATH
go test ./...                            # all green, no DB needed
go run ./cmd/server                      # serves on :8080 (PORT to override)
```

## Benchmark (PHASE 3 — to be filled in)

Three stages on a Neon **dev branch** (production `AILog` untouched), ~50k
synthetic rows:

| stage | query                                   | p50 latency |
|-------|-----------------------------------------|-------------|
| 1     | raw scan of `AILog` per request         | _TBD_       |
| 2     | + index on `("orgId", "createdAt")`     | _TBD_       |
| 3     | read `usage_daily_rollup`               | _TBD_       |

## Status

- [x] PHASE 1 — skeleton, `:8080`, `GET /metrics/usage`, 3-layer split
- [x] PHASE 2 — `Aggregate()` + table-driven tests (in-memory fake)
- [ ] PHASE 3 — pgx + Neon dev branch + 3-stage benchmark
- [ ] PHASE 4 — async rollup worker (goroutine + channel, idempotent upsert)
- [ ] PHASE 5 — multi-stage Dockerfile + AWS deploy
- [ ] PHASE 6 — DESIGN.md (100× data scenario)
