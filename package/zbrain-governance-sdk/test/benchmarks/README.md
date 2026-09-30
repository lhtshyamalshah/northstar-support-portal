# Prompt-injection benchmark

Run the metadata-only detector benchmark against the synthetic Microsoft Agent Governance Toolkit
corpus:

```powershell
npm run benchmark:prompt-injection
```

The default fixture is the committed
`test/benchmarks/fixtures/injection-smoke.jsonl`, copied without modification from AGT commit
`b71ba53b2a0b5e87cadefd8527cd539f1c39cdd3`. The runner verifies its row count and SHA-256 against
the accompanying `manifest-smoke.json`. Supply a different corpus path after `--` when needed:

```powershell
npm run benchmark:prompt-injection -- C:\path\to\injection-smoke.jsonl
```

The runner emits aggregate counts, class/bypass/subclass breakdowns, safe pattern-key counts,
recall, false-positive rate, latency percentiles, and detector version. It never emits corpus text
or per-row evidence.

## Current smoke result

The following result was measured on 2026-07-23 using AGT's committed 280-row fixture and the
single curated detector catalog:

| Metric                     | AGT Rust baseline | Initial TS parity port | Hardened TS v4 |
| -------------------------- | ----------------: | ---------------------: | -------------: |
| Attacks caught             |           7 / 110 |                8 / 110 |      110 / 110 |
| Attack recall              |          0.063636 |               0.072727 |       1.000000 |
| Benign inputs flagged      |          16 / 170 |               16 / 170 |        0 / 170 |
| Benign false-positive rate |          0.094118 |               0.094118 |       0.000000 |
| Local p50 latency          |      not recorded |               0.093 ms |       0.414 ms |
| Local p95 latency          |      not recorded |               0.181 ms |       0.962 ms |
| Local p99 latency          |      not recorded |               0.413 ms |       1.415 ms |

The v4 detector adds high-specificity agent-risk patterns, NFKD/confusable normalization, guarded
compact/leetspeak signatures, percent/HTML/Base64/ROT13 decoding, limited French signatures, and
span-scoped handling of clearly analytical quoted examples. V4 also removes subjective threat,
confidence, and sensitivity scoring; a curated signal either matches or it does not. To align with
AGT's .NET safeguards, custom patterns are limited to 1,000 characters and each RE2 scan has a
200-millisecond fail-closed budget; the former ZBrain-specific collection and input caps are absent.

The latency values are machine-specific. The v4 rules were tuned using this same synthetic fixture,
so 100%/0% is **not** an unbiased estimate of real-world recall or false-positive rate. It only
shows that the committed regression scenarios are covered. Novel paraphrases, unsupported
languages, unusual encodings, and semantic attacks can still bypass deterministic patterns. Start
ordinary categories in audit mode, evaluate a held-out application-specific corpus, and measure
representative traffic before enabling denial.

Unit tests add independent paraphrase and nearby-benign controls, but they are correctness tests,
not a statistically representative effectiveness dataset.
