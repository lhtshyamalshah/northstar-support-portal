import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  PROMPT_INJECTION_DETECTOR_VERSION,
  PromptInjectionDetector
} from "../../src/policy-engine/prompt-injection-detector.js";
import type { PromptInjectionType } from "../../src/policy-engine/types.js";

/**
 * Metadata-only benchmark runner for the synthetic Microsoft AGT corpus.
 * Copyright (c) Microsoft Corporation. Corpus and scenarios are MIT licensed.
 */

const DEFAULT_CORPUS_PATH = "test/benchmarks/fixtures/injection-smoke.jsonl";
const DEFAULT_MANIFEST_PATH = "test/benchmarks/fixtures/manifest-smoke.json";
const CHECKS: readonly PromptInjectionType[] = [
  "directOverride",
  "delimiterAttack",
  "encodingAttack",
  "rolePlay",
  "contextManipulation",
  "multiTurnEscalation"
];

interface CorpusRow {
  attack_class: string;
  benign_subclass?: string;
  bypass_class: string;
  expected_action: string;
  id: string;
  source_type: string;
  split: string;
  text: string;
}

interface OutcomeCount {
  flagged: number;
  total: number;
}

interface OutcomeSummary extends OutcomeCount {
  falsePositiveRate?: number;
  recall?: number;
}

const usesCommittedFixture = process.argv[2] === undefined;
const corpusPath = resolve(process.argv[2] ?? DEFAULT_CORPUS_PATH);
const rawCorpus = await readFile(corpusPath, "utf8");
const corpusSha256 = createHash("sha256").update(rawCorpus).digest("hex");
const rows = parseCorpus(rawCorpus);
if (usesCommittedFixture) {
  await validateCommittedFixture(rows.length, corpusSha256);
}
const detector = new PromptInjectionDetector({}, { checks: CHECKS });
const latencies: number[] = [];
let attacks = 0;
let attacksCaught = 0;
let benign = 0;
let benignFlagged = 0;
let rawTextInOutput = false;
const attackClasses = new Map<string, OutcomeCount>();
const bypassClasses = new Map<string, OutcomeCount>();
const benignSubclasses = new Map<string, OutcomeCount>();
const attackPatternKeys = new Map<string, number>();
const benignPatternKeys = new Map<string, number>();

for (const row of rows) {
  const isAttack = row.attack_class !== "benign" || row.expected_action !== "allow";
  const started = performance.now();
  const result = detector.detect(row.text);
  latencies.push(performance.now() - started);
  rawTextInOutput ||= row.text.length > 0 && JSON.stringify(result).includes(row.text);

  if (isAttack) {
    attacks += 1;
    attacksCaught += Number(result.isInjection);
    recordOutcome(attackClasses, row.attack_class, result.isInjection);
    recordOutcome(bypassClasses, row.bypass_class, result.isInjection);
    recordPatternKeys(attackPatternKeys, result.matchedPatternKeys);
  } else {
    benign += 1;
    benignFlagged += Number(result.isInjection);
    recordOutcome(benignSubclasses, row.benign_subclass ?? "unspecified", result.isInjection);
    recordPatternKeys(benignPatternKeys, result.matchedPatternKeys);
  }
}

latencies.sort((left, right) => left - right);
const summary = {
  detectorVersion: PROMPT_INJECTION_DETECTOR_VERSION,
  corpus: basename(corpusPath),
  corpusSha256,
  processed: rows.length,
  attacks,
  attacksCaught,
  attackRecall: ratio(attacksCaught, attacks),
  benign,
  benignFlagged,
  benignFalsePositiveRate: ratio(benignFlagged, benign),
  attackRecallByClass: summarizeOutcomes(attackClasses, "recall"),
  attackRecallByBypass: summarizeOutcomes(bypassClasses, "recall"),
  benignFalsePositiveRateBySubclass: summarizeOutcomes(benignSubclasses, "falsePositiveRate"),
  attackFlagsByPatternKey: sortedCounts(attackPatternKeys),
  benignFlagsByPatternKey: sortedCounts(benignPatternKeys),
  latencyMilliseconds: {
    p50: percentile(latencies, 0.5),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99)
  },
  rawTextInOutput
};

process.stdout.write(`${JSON.stringify(summary, undefined, 2)}\n`);

async function validateCommittedFixture(rowCount: number, sha256: string): Promise<void> {
  const manifest = JSON.parse(await readFile(resolve(DEFAULT_MANIFEST_PATH), "utf8")) as unknown;
  if (!isRecord(manifest) || manifest.row_count !== rowCount || manifest.output_sha256 !== sha256) {
    throw new Error("Committed prompt-injection benchmark fixture does not match its manifest");
  }
}

function parseCorpus(raw: string): CorpusRow[] {
  return raw
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const value = JSON.parse(line) as unknown;
      if (!isCorpusRow(value)) {
        throw new Error(`Prompt-injection corpus row ${index + 1} has an invalid shape`);
      }
      return value;
    });
}

function isCorpusRow(value: unknown): value is CorpusRow {
  return (
    isRecord(value) &&
    typeof value.attack_class === "string" &&
    (value.benign_subclass === undefined || typeof value.benign_subclass === "string") &&
    typeof value.bypass_class === "string" &&
    typeof value.expected_action === "string" &&
    typeof value.id === "string" &&
    typeof value.source_type === "string" &&
    typeof value.split === "string" &&
    typeof value.text === "string"
  );
}

function recordOutcome(outcomes: Map<string, OutcomeCount>, key: string, flagged: boolean): void {
  const current = outcomes.get(key) ?? { flagged: 0, total: 0 };
  current.total += 1;
  current.flagged += Number(flagged);
  outcomes.set(key, current);
}

function recordPatternKeys(counts: Map<string, number>, patternKeys: readonly string[]): void {
  for (const patternKey of patternKeys) {
    counts.set(patternKey, (counts.get(patternKey) ?? 0) + 1);
  }
}

function sortedCounts(counts: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right))
  );
}

function summarizeOutcomes(
  outcomes: ReadonlyMap<string, OutcomeCount>,
  rateName: "recall" | "falsePositiveRate"
): Record<string, OutcomeSummary> {
  return Object.fromEntries(
    [...outcomes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => {
        const summary: OutcomeSummary = {
          flagged: value.flagged,
          total: value.total
        };
        summary[rateName] = ratio(value.flagged, value.total);
        return [key, summary] as const;
      })
  );
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : round(numerator / denominator, 6);
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) {
    return 0;
  }
  const index = Math.min(values.length - 1, Math.ceil(values.length * quantile) - 1);
  return round(values[index] ?? 0, 3);
}

function round(value: number, precision: number): number {
  const multiplier = 10 ** precision;
  return Math.round(value * multiplier) / multiplier;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
