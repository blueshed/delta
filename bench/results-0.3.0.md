# Bench results — 0.3.0

10,000 single-field updates per adapter, 200 warm-up iterations discarded.
Loopback Postgres 18 (compose on `localhost:5433`), single Node pg Pool (max=4),
macOS / Apple Silicon.

```
                        p50         p95         p99        mean       total    RTT
                     --------    --------    --------    --------    --------   ---
raw-postgres           0.124 ms     0.154 ms     0.247 ms     0.128 ms      1.28 s     1
delta-new (1-RTT)      0.271 ms     0.329 ms     0.447 ms     0.280 ms      2.80 s     1
delta-old (4-RTT)      0.638 ms     0.755 ms     0.905 ms     0.653 ms      6.53 s     4

delta-old / delta-new p50 ratio: 2.36x
delta-new / raw-postgres p50 ratio: 2.18x
```

## Reading this

On a loopback socket each RTT is ~0.1 ms, so the 3 extra round-trips that
`withAppAuth` pays (`BEGIN` / `set_config` / `COMMIT` around the `delta_apply`
`SELECT`) only add ~0.3 ms — meaningful, but not the full 4× the wire-cost
model predicts.

Decompose the delta-new number:
  ~0.12 ms  per-RTT cost     (from raw-postgres minus server work ≈ RTT)
  ~0.15 ms  `delta_apply` server-side work (path parse, `UPDATE`, ops-log insert, NOTIFY)
  ─────
  ~0.27 ms  observed

And delta-old:
  ~0.48 ms  4× RTT
  ~0.15 ms  `delta_apply` server-side work
  ─────
  ~0.64 ms  observed  (ratio 2.36×)

At realistic network RTT the server-side constant shrinks to noise and the
ratio approaches the wire-cost prediction:

| RTT    | delta-new (1-RTT) | delta-old (4-RTT) | ratio |
|--------|-------------------|-------------------|-------|
| 0.1 ms | 0.27 ms           | 0.64 ms           | 2.4×  |
| 5 ms   | ~5.2 ms           | ~20.2 ms          | 3.9×  |
| 20 ms  | ~20.2 ms          | ~80.2 ms          | 4.0×  |
| 50 ms  | ~50.2 ms          | ~200.2 ms         | 4.0×  |

A single-user mobile app talking to a continent-away Postgres at 50 ms
RTT saves ~150 ms per authenticated op — the difference between a UI
that feels instant and one that needs spinners.

## Repro

```
bun run db:up
bun run bench
bun run db:down
```

`BENCH_ITERATIONS` / `BENCH_WARMUP` / `BENCH_PG_URL` overridable via env.
Source: [run.ts](./run.ts), [adapters/](./adapters/).
