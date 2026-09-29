import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stableJsonStringify } from "../../utils/index.js";
import { assertDid } from "./did.js";

export type RiskSignalSeverity = "critical" | "high" | "medium" | "low" | "info";
export type RiskLevel = "critical" | "high" | "medium" | "low" | "minimal";
export type TrustRing = 0 | 1 | 2 | 3;

export interface RiskSignalInput {
  signalType: string;
  severity: RiskSignalSeverity;
  value: number;
  timestamp?: Date | string | number;
  source?: string;
  details?: string;
}

export interface RiskScoreUpdateInput {
  identity: number;
  behavior: number;
  network: number;
  compliance: number;
  activeSignals?: number;
  criticalSignals?: number;
}

export interface RiskScorerOptions {
  storageDir?: string;
}

type RiskAlert = Readonly<Record<string, unknown>>;
type RiskAlertCallback = (alert: RiskAlert) => void;

const TRUST_SCORE_DEFAULT = 500;
const RISK_CRITICAL_THRESHOLD = 200;
const RISK_HIGH_THRESHOLD = 400;
const RISK_ALERT_THRESHOLD = 600;
const RISK_MINIMAL_THRESHOLD = 800;
const RISK_UPDATE_INTERVAL_SECONDS = 30;
const RISK_SIGNAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STORAGE_DIR = ".zbrain-risk-signals";

const RISK_WEIGHTS: Readonly<Record<RiskSignalSeverity, number>> = {
  critical: 1,
  high: 0.75,
  medium: 0.5,
  low: 0.25,
  info: 0.1
};

export class RiskSignal {
  readonly signalType: string;
  readonly severity: RiskSignalSeverity;
  readonly value: number;
  readonly timestamp: number;
  readonly source: string | undefined;
  readonly details: string | undefined;

  constructor(input: RiskSignalInput) {
    this.signalType = normalizeSignalType(input.signalType);
    this.severity = input.severity;
    this.value = normalizeSignalValue(input.value);
    this.timestamp = normalizeTimestamp(input.timestamp);
    this.source = input.source?.trim() || undefined;
    this.details = input.details?.trim() || undefined;
  }

  get weight(): number {
    return RISK_WEIGHTS[this.severity] ?? RISK_WEIGHTS.info;
  }

  toJSON(): RiskSignalJSON {
    return {
      signalType: this.signalType,
      severity: this.severity,
      value: this.value,
      timestamp: this.timestamp,
      ...(this.source ? { source: this.source } : {}),
      ...(this.details ? { details: this.details } : {})
    };
  }

  static fromJSON(json: RiskSignalJSON): RiskSignal {
    return new RiskSignal(json);
  }
}

export class RiskScore {
  readonly agentDid: string;
  totalScore: number;
  riskLevel: RiskLevel;
  identityScore: number;
  behaviorScore: number;
  networkScore: number;
  complianceScore: number;
  activeSignals: number;
  criticalSignals: number;
  calculatedAt: number;
  nextUpdateAt: number;

  constructor(agentDid: string) {
    this.agentDid = assertDid(agentDid);
    this.totalScore = TRUST_SCORE_DEFAULT;
    this.riskLevel = "medium";
    this.identityScore = 50;
    this.behaviorScore = 50;
    this.networkScore = 50;
    this.complianceScore = 50;
    this.activeSignals = 0;
    this.criticalSignals = 0;
    this.calculatedAt = Date.now();
    this.nextUpdateAt = Date.now();
  }

  static getRiskLevel(score: number): RiskLevel {
    if (score >= RISK_MINIMAL_THRESHOLD) {
      return "minimal";
    }

    if (score >= RISK_ALERT_THRESHOLD) {
      return "low";
    }

    if (score >= RISK_HIGH_THRESHOLD) {
      return "medium";
    }

    if (score >= RISK_CRITICAL_THRESHOLD) {
      return "high";
    }

    return "critical";
  }

  update(input: RiskScoreUpdateInput): void {
    this.identityScore = clampComponentScore(input.identity);
    this.behaviorScore = clampComponentScore(input.behavior);
    this.networkScore = clampComponentScore(input.network);
    this.complianceScore = clampComponentScore(input.compliance);
    this.totalScore = clampTrustScore(
      this.identityScore * 2 +
        this.behaviorScore * 3 +
        this.networkScore * 2 +
        this.complianceScore * 3
    );
    this.riskLevel = RiskScore.getRiskLevel(this.totalScore);
    this.activeSignals = input.activeSignals ?? 0;
    this.criticalSignals = input.criticalSignals ?? 0;
    this.calculatedAt = Date.now();
    this.nextUpdateAt = this.calculatedAt + RISK_UPDATE_INTERVAL_SECONDS * 1000;
  }
}

export class RiskScorer {
  static readonly UPDATE_INTERVAL = RISK_UPDATE_INTERVAL_SECONDS;
  static readonly CRITICAL_THRESHOLD = RISK_CRITICAL_THRESHOLD;
  static readonly HIGH_THRESHOLD = RISK_HIGH_THRESHOLD;
  static readonly ALERT_THRESHOLD = RISK_ALERT_THRESHOLD;

  private readonly scores = new Map<string, RiskScore>();
  private readonly signals = new Map<string, RiskSignal[]>();
  private readonly alertCallbacks: RiskAlertCallback[] = [];
  private readonly storageDir: string;

  constructor(options: RiskScorerOptions = {}) {
    this.storageDir = options.storageDir ?? DEFAULT_STORAGE_DIR;
  }

  getScore(agentDid: string): RiskScore {
    const normalizedAgentDid = assertDid(agentDid);
    const existingScore = this.scores.get(normalizedAgentDid);

    if (existingScore) {
      return existingScore;
    }

    const score = new RiskScore(normalizedAgentDid);

    this.scores.set(normalizedAgentDid, score);

    return score;
  }

  async addSignal(agentDid: string, signal: RiskSignal): Promise<void> {
    const normalizedAgentDid = assertDid(agentDid);
    const signals = await this.getSignals(normalizedAgentDid);

    signals.push(signal);
    this.signals.set(normalizedAgentDid, signals);
    await this.saveSignals(normalizedAgentDid, signals);

    if (signal.severity === "critical") {
      await this.recalculate(normalizedAgentDid);
    }
  }

  async recalculate(agentDid: string): Promise<RiskScore> {
    const normalizedAgentDid = assertDid(agentDid);
    const score = this.getScore(normalizedAgentDid);
    const signals = await this.getSignals(normalizedAgentDid);
    const cutoff = Date.now() - RISK_SIGNAL_WINDOW_MS;
    const recentSignals = signals.filter((signal) => signal.timestamp > cutoff);
    const identityScore = this.calculateIdentityScore(recentSignals);
    const behaviorScore = this.calculateBehaviorScore(recentSignals);
    const networkScore = this.calculateNetworkScore(recentSignals);
    const complianceScore = this.calculateComplianceScore(recentSignals);
    const oldLevel = score.riskLevel;

    score.update({
      identity: identityScore,
      behavior: behaviorScore,
      network: networkScore,
      compliance: complianceScore,
      activeSignals: recentSignals.length,
      criticalSignals: recentSignals.filter((signal) => signal.severity === "critical").length
    });

    this.checkAlerts(normalizedAgentDid, score, oldLevel);

    return score;
  }

  onAlert(callback: RiskAlertCallback): void {
    this.alertCallbacks.push(callback);
  }

  getHighRiskAgents(threshold?: number): RiskScore[] {
    const resolvedThreshold = threshold ?? RiskScorer.HIGH_THRESHOLD;

    return [...this.scores.values()].filter((score) => score.totalScore < resolvedThreshold);
  }

  async clearSignals(agentDid: string): Promise<void> {
    const normalizedAgentDid = assertDid(agentDid);

    this.signals.set(normalizedAgentDid, []);
    await this.saveSignals(normalizedAgentDid, []);
    await this.recalculate(normalizedAgentDid);
  }

  async getSignals(agentDid: string): Promise<RiskSignal[]> {
    const normalizedAgentDid = assertDid(agentDid);
    const cachedSignals = this.signals.get(normalizedAgentDid);

    if (cachedSignals) {
      return cachedSignals;
    }

    const storedSignals = await this.loadSignals(normalizedAgentDid);

    this.signals.set(normalizedAgentDid, storedSignals);

    return storedSignals;
  }

  private calculateIdentityScore(signals: readonly RiskSignal[]): number {
    let base = 80;

    for (const signal of signals) {
      if (signal.signalType.startsWith("identity.")) {
        base -= Math.trunc(signal.value * signal.weight * 20);
      }
    }

    return clampComponentScore(base);
  }

  private calculateBehaviorScore(signals: readonly RiskSignal[]): number {
    let base = 70;

    for (const signal of signals) {
      if (signal.signalType.startsWith("behavior.")) {
        base -= Math.trunc(signal.value * signal.weight * 25);
      }
    }

    return clampComponentScore(base);
  }

  private calculateNetworkScore(signals: readonly RiskSignal[]): number {
    let base = 75;

    for (const signal of signals) {
      if (signal.signalType.startsWith("network.")) {
        base -= Math.trunc(signal.value * signal.weight * 20);
      }
    }

    return clampComponentScore(base);
  }

  private calculateComplianceScore(signals: readonly RiskSignal[]): number {
    let base = 85;

    for (const signal of signals) {
      if (signal.signalType.startsWith("compliance.")) {
        base -= Math.trunc(signal.value * signal.weight * 30);
      }
    }

    return clampComponentScore(base);
  }

  private checkAlerts(agentDid: string, score: RiskScore, oldLevel: RiskLevel): void {
    if (score.riskLevel !== oldLevel) {
      for (const callback of this.alertCallbacks) {
        try {
          callback({
            type: "risk_level_change",
            agentDid,
            oldLevel,
            newLevel: score.riskLevel,
            score: score.totalScore
          });
        } catch {
          // Match risk.py: alert callbacks should not break risk scoring.
        }
      }
    }

    if (score.totalScore < RiskScorer.CRITICAL_THRESHOLD) {
      for (const callback of this.alertCallbacks) {
        try {
          callback({
            type: "critical_risk",
            agentDid,
            score: score.totalScore,
            action: "immediate_review_required"
          });
        } catch {
          // Match risk.py: alert callbacks should not break risk scoring.
        }
      }
    }
  }

  private async loadSignals(agentDid: string): Promise<RiskSignal[]> {
    try {
      const content = await readFile(this.getSignalFilePath(agentDid), "utf-8");
      const storedSignals = JSON.parse(content) as RiskSignalJSON[];

      return storedSignals.map((signal) => RiskSignal.fromJSON(signal));
    } catch (error) {
      if (isMissingFile(error)) {
        return [];
      }

      throw error;
    }
  }

  private async saveSignals(agentDid: string, signals: readonly RiskSignal[]): Promise<void> {
    await mkdir(this.storageDir, { recursive: true });
    await writeFile(
      this.getSignalFilePath(agentDid),
      `${stableJsonStringify(signals.map((signal) => signal.toJSON()))}\n`,
      "utf-8"
    );
  }

  private getSignalFilePath(agentDid: string): string {
    return join(this.storageDir, `${assertDid(agentDid)}.json`);
  }
}

interface RiskSignalJSON {
  signalType: string;
  severity: RiskSignalSeverity;
  value: number;
  timestamp: number;
  source?: string;
  details?: string;
}

function normalizeSignalType(value: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error("signalType is required");
  }

  return trimmed;
}

function normalizeSignalValue(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error("value must be a number between 0 and 1");
  }

  return value;
}

function normalizeTimestamp(value: Date | string | number | undefined): number {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());

  if (Number.isNaN(date.getTime())) {
    throw new Error("timestamp must be a valid timestamp");
  }

  return date.getTime();
}

function clampComponentScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function clampTrustScore(value: number): number {
  return Math.max(0, Math.min(1000, value));
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
