# Bench — delta 0.3.0 hot path

Measures the 1-RTT `delta_apply_as` path vs the old 4-RTT `withAppAuth` path,
with `raw-postgres` as the baseline.

## Run

```
bun run db:up          # reuses the test compose on localhost:5433
bun run bench          # 10_000 single-field updates per adapter
bun run db:down
```

Options via env:

| Var | Default | Meaning |
|---|---|---|
| `BENCH_ITERATIONS` | `10000` | measured iterations per adapter |
| `BENCH_WARMUP` | `200` | discarded iterations before measurement |
| `BENCH_PG_URL` | `postgres://delta:delta@localhost:5433/delta_test` | target DB |

## What it measures

All three adapters update a single `value` column on a row owned by
`user_id=1`, inside an RLS policy that reads `current_setting('app.user_id')`.

| Adapter | Wire cost per op |
|---|---|
| `raw-postgres` | 1 RTT — single `WITH _ AS (set_config…) UPDATE …` |
| `delta-new (1-RTT)` | 1 RTT — `SELECT delta_apply_as(user, doc, ops)` |
| `delta-old (4-RTT)` | 4 RTTs — `withAppAuth`: BEGIN / set_config / delta_apply / COMMIT |

The expected story is `delta-old` p50 ≈ 4× `delta-new`. On a loopback pool the
absolute numbers are tiny (sub-millisecond); the ratio is the interesting
signal. At real-world RTT (say 20 ms), 4× compounds into a multi-hundred-ms
tax per op.

Results from the release run are captured in [results-0.3.0.md](./results-0.3.0.md).
