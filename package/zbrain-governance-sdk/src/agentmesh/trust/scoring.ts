import { assertDid } from "../identity/did.js";

export const TRUST_SCORE_DEFAULT = 500;
export const TRUST_SCORE_MAX = 1000;
export const TRUST_REVOCATION_THRESHOLD = 200;
export const TRUST_WARNING_THRESHOLD = 400;
export const TIER_VERIFIED_PARTNER_THRESHOLD = 900;
export const TIER_TRUSTED_THRESHOLD = 700;
export const TIER_STANDARD_THRESHOLD = 500;
export const TIER_PROBATIONARY_THRESHOLD = 300;

/**
 * Reward dimensions used to turn runtime signals into trust scores.
 */
export const DimensionType = {
  POLICY_COMPLIANCE: "policy_compliance",
  RESOURCE_EFFICIENCY: "resource_efficiency",
  OUTPUT_QUALITY: "output_quality",
  SECURITY_POSTURE: "security_posture",
  COLLABORATION_HEALTH: "collaboration_health"
} as const;

export type DimensionType = (typeof DimensionType)[keyof typeof DimensionType];
export type TrustTier = "verified_partner" | "trusted" | "standard" | "probationary" | "untrusted";
export type RewardTrend = "improving" | "degrading" | "stable";

export interface RewardSignalInput {
  dimension: DimensionType;
  value: number;
  source: string;
  details?: string;
  traceId?: string;
  timestamp?: Date | string | number;
  weight?: number;
}

export interface RewardSignalJSON {
  dimension: DimensionType;
  value: number;
  source: string;
  timestamp: number;
  weight: number;
  details?: string;
  traceId?: string;
}

export interface RewardDimensionInput {
  name: string;
  score?: number;
  signalCount?: number;
  positiveSignals?: number;
  negativeSignals?: number;
  previousScore?: number;
  trend?: RewardTrend;
  updatedAt?: Date | string | number;
}

export interface RewardDimensionJSON {
  name: string;
  score: number;
  signalCount: number;
  positiveSignals: number;
  negativeSignals: number;
  trend: RewardTrend;
  updatedAt: number;
  previousScore?: number;
}

export interface TrustScoreInput {
  agentDid: string;
  totalScore?: number;
  tier?: TrustTier;
  dimensions?: Record<string, RewardDimension>;
  calculatedAt?: Date | string | number;
  previousScore?: number;
  scoreChange?: number;
  trustCeiling?: number;
}

export interface TrustScoreJSON {
  agentDid: string;
  total_score: number;
  tier: TrustTier;
  dimensions: Record<
    string,
    {
      score: number;
      trend: RewardTrend;
      signal_count: number;
    }
  >;
  calculated_at: string;
  score_change: number;
  previous_score?: number;
  trust_ceiling?: number;
}

export interface ScoreThresholdsInput {
  verifiedPartner?: number;
  trusted?: number;
  standard?: number;
  probationary?: number;
  allowThreshold?: number;
  warnThreshold?: number;
  revocationThreshold?: number;
}

/**
 * A single reward signal.
 *
 * Signals feed dimension scores, and dimension scores aggregate into the
 * agent's overall trust score.
 */
export class RewardSignal {
  readonly dimension: DimensionType;
  readonly value: number;
  readonly source: string;
  readonly details: string | undefined;
  readonly traceId: string | undefined;
  readonly timestamp: number;
  readonly weight: number;

  constructor(input: RewardSignalInput) {
    this.dimension = normalizeDimension(input.dimension);
    this.value = normalizeUnitValue(input.value, "value");
    this.source = normalizeRequiredString(input.source, "source");
    this.details = normalizeOptionalString(input.details);
    this.traceId = normalizeOptionalString(input.traceId);
    this.timestamp = normalizeTimestamp(input.timestamp);
    this.weight = normalizeNonNegativeNumber(input.weight ?? 1, "weight");
  }

  toJSON(): RewardSignalJSON {
    return {
      dimension: this.dimension,
      value: this.value,
      source: this.source,
      timestamp: this.timestamp,
      weight: this.weight,
      ...(this.details ? { details: this.details } : {}),
      ...(this.traceId ? { traceId: this.traceId } : {})
    };
  }

  static fromJSON(json: RewardSignalJSON): RewardSignal {
    return new RewardSignal(json);
  }
}

/**
 * Score and signal statistics for one reward dimension.
 */
export class RewardDimension {
  readonly name: string;
  score: number;
  signalCount: number;
  positiveSignals: number;
  negativeSignals: number;
  previousScore: number | undefined;
  trend: RewardTrend;
  updatedAt: number;

  constructor(input: RewardDimensionInput) {
    this.name = normalizeRequiredString(input.name, "name");
    this.score = normalizeScore(input.score ?? 50, "score", 100);
    this.signalCount = normalizeCount(input.signalCount ?? 0, "signalCount");
    this.positiveSignals = normalizeCount(input.positiveSignals ?? 0, "positiveSignals");
    this.negativeSignals = normalizeCount(input.negativeSignals ?? 0, "negativeSignals");
    this.previousScore =
      input.previousScore === undefined
        ? undefined
        : normalizeScore(input.previousScore, "previousScore", 100);
    this.trend = input.trend ?? "stable";
    this.updatedAt = normalizeTimestamp(input.updatedAt);
  }

  /**
   * Add a signal and update this dimension with an exponential moving average.
   */
  addSignal(signal: RewardSignal): void {
    this.signalCount += 1;

    if (signal.value >= 0.5) {
      this.positiveSignals += 1;
    } else {
      this.negativeSignals += 1;
    }

    const alpha = 0.1;
    this.previousScore = this.score;
    this.score = this.score * (1 - alpha) + signal.value * 100 * alpha;
    this.updateTrend();
    this.updatedAt = Date.now();
  }

  /**
   * Export this dimension score as JSON-safe data.
   */
  toJSON(): RewardDimensionJSON {
    return {
      name: this.name,
      score: this.score,
      signalCount: this.signalCount,
      positiveSignals: this.positiveSignals,
      negativeSignals: this.negativeSignals,
      trend: this.trend,
      updatedAt: this.updatedAt,
      ...(this.previousScore === undefined ? {} : { previousScore: this.previousScore })
    };
  }

  static fromJSON(json: RewardDimensionJSON): RewardDimension {
    return new RewardDimension(json);
  }

  private updateTrend(): void {
    if (this.previousScore === undefined) {
      this.trend = "stable";
      return;
    }

    const diff = this.score - this.previousScore;

    if (diff > 5) {
      this.trend = "improving";
    } else if (diff < -5) {
      this.trend = "degrading";
    } else {
      this.trend = "stable";
    }
  }
}

/**
 * Complete trust score for an agent.
 *
 * Aggregates all reward dimensions into a single 0-1000 score and assigns a
 * trust tier. Delegated agents can optionally have a trust ceiling.
 */
export class TrustScore {
  readonly agentDid: string;
  totalScore: number;
  tier: TrustTier;
  dimensions: Record<string, RewardDimension>;
  calculatedAt: number;
  previousScore: number | undefined;
  scoreChange: number;
  trustCeiling: number | undefined;

  constructor(input: TrustScoreInput) {
    this.agentDid = assertMeshDid(input.agentDid);
    this.dimensions = input.dimensions ?? {};
    this.calculatedAt = normalizeTimestamp(input.calculatedAt);
    this.previousScore =
      input.previousScore === undefined
        ? undefined
        : normalizeScore(input.previousScore, "previousScore", TRUST_SCORE_MAX);
    this.scoreChange = normalizeInteger(input.scoreChange ?? 0, "scoreChange");
    this.trustCeiling = resolveTrustCeiling(input.trustCeiling);
    this.totalScore = this.applyTrustCeiling(
      normalizeScore(input.totalScore ?? TRUST_SCORE_DEFAULT, "totalScore", TRUST_SCORE_MAX)
    );
    this.tier = input.tier ?? getTrustTier(this.totalScore);
    this.updateTier();
  }

  /**
   * Update the trust score and dimension breakdown, respecting any trust ceiling.
   */
  update(newScore: number, dimensions: Record<string, RewardDimension>): void {
    this.previousScore = this.totalScore;
    this.totalScore = this.applyTrustCeiling(
      normalizeScore(Math.trunc(newScore), "newScore", TRUST_SCORE_MAX)
    );
    this.scoreChange = this.totalScore - this.previousScore;
    this.dimensions = dimensions;
    this.calculatedAt = Date.now();
    this.updateTier();
  }

  /**
   * Check whether the current score meets a caller-provided threshold.
   */
  meetsThreshold(threshold: number): boolean {
    return this.totalScore >= normalizeScore(threshold, "threshold", TRUST_SCORE_MAX);
  }

  /**
   * Export the trust score as JSON-safe data.
   */
  toJSON(): TrustScoreJSON {
    return {
      agentDid: this.agentDid,
      total_score: this.totalScore,
      tier: this.tier,
      dimensions: Object.fromEntries(
        Object.entries(this.dimensions).map(([name, dimension]) => [
          name,
          {
            score: dimension.score,
            trend: dimension.trend,
            signal_count: dimension.signalCount
          }
        ])
      ),
      calculated_at: new Date(this.calculatedAt).toISOString(),
      score_change: this.scoreChange,
      ...(this.previousScore === undefined ? {} : { previous_score: this.previousScore }),
      ...(this.trustCeiling === undefined ? {} : { trust_ceiling: this.trustCeiling })
    };
  }

  private applyTrustCeiling(score: number): number {
    return this.trustCeiling === undefined ? score : Math.min(score, this.trustCeiling);
  }

  private updateTier(): void {
    this.tier = getTrustTier(this.totalScore);
  }
}

/**
 * Configurable tier and action thresholds for trust scores.
 */
export class ScoreThresholds {
  readonly verifiedPartner: number;
  readonly trusted: number;
  readonly standard: number;
  readonly probationary: number;
  readonly allowThreshold: number;
  readonly warnThreshold: number;
  readonly revocationThreshold: number;

  constructor(input: ScoreThresholdsInput = {}) {
    this.verifiedPartner = normalizeScore(
      input.verifiedPartner ?? TIER_VERIFIED_PARTNER_THRESHOLD,
      "verifiedPartner",
      TRUST_SCORE_MAX
    );
    this.trusted = normalizeScore(
      input.trusted ?? TIER_TRUSTED_THRESHOLD,
      "trusted",
      TRUST_SCORE_MAX
    );
    this.standard = normalizeScore(
      input.standard ?? TIER_STANDARD_THRESHOLD,
      "standard",
      TRUST_SCORE_MAX
    );
    this.probationary = normalizeScore(
      input.probationary ?? TIER_PROBATIONARY_THRESHOLD,
      "probationary",
      TRUST_SCORE_MAX
    );
    this.allowThreshold = normalizeScore(
      input.allowThreshold ?? TIER_STANDARD_THRESHOLD,
      "allowThreshold",
      TRUST_SCORE_MAX
    );
    this.warnThreshold = normalizeScore(
      input.warnThreshold ?? TRUST_WARNING_THRESHOLD,
      "warnThreshold",
      TRUST_SCORE_MAX
    );
    this.revocationThreshold = normalizeScore(
      input.revocationThreshold ?? TRUST_REVOCATION_THRESHOLD,
      "revocationThreshold",
      TRUST_SCORE_MAX
    );
  }

  /**
   * Resolve the trust tier for a score.
   */
  getTier(score: number): TrustTier {
    return getTrustTierWithThresholds(score, this);
  }

  /**
   * Check whether a score should allow guarded actions.
   */
  shouldAllow(score: number): boolean {
    return score >= this.allowThreshold;
  }

  /**
   * Check whether a score should trigger a warning.
   */
  shouldWarn(score: number): boolean {
    return score < this.warnThreshold;
  }

  /**
   * Check whether a score should trigger revocation.
   */
  shouldRevoke(score: number): boolean {
    return score < this.revocationThreshold;
  }
}

export function getTrustTier(score: number): TrustTier {
  return getTrustTierWithThresholds(score, {
    verifiedPartner: TIER_VERIFIED_PARTNER_THRESHOLD,
    trusted: TIER_TRUSTED_THRESHOLD,
    standard: TIER_STANDARD_THRESHOLD,
    probationary: TIER_PROBATIONARY_THRESHOLD
  });
}

function getTrustTierWithThresholds(
  score: number,
  thresholds: Pick<ScoreThresholds, "probationary" | "standard" | "trusted" | "verifiedPartner">
): TrustTier {
  if (score >= thresholds.verifiedPartner) {
    return "verified_partner";
  }

  if (score >= thresholds.trusted) {
    return "trusted";
  }

  if (score >= thresholds.standard) {
    return "standard";
  }

  if (score >= thresholds.probationary) {
    return "probationary";
  }

  return "untrusted";
}

function assertMeshDid(value: string): string {
  const did = assertDid(value);

  if (!did.startsWith("did:mesh:")) {
    throw new Error(`agentDid must match 'did:mesh:' pattern, got: ${did}`);
  }

  return did;
}

function normalizeDimension(value: DimensionType): DimensionType {
  if (!Object.values(DimensionType).includes(value)) {
    throw new Error(`Unsupported reward dimension: ${String(value)}`);
  }

  return value;
}

function normalizeRequiredString(value: string, field: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error(`${field} is required`);
  }

  return trimmed;
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();

  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeTimestamp(value: Date | string | number | undefined): number {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());

  if (Number.isNaN(date.getTime())) {
    throw new Error("timestamp must be a valid timestamp");
  }

  return date.getTime();
}

function normalizeUnitValue(value: number, field: string): number {
  return normalizeScore(value, field, 1);
}

function normalizeNonNegativeNumber(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }

  return value;
}

function normalizeInteger(value: number, field: string): number {
  if (!Number.isInteger(value)) {
    throw new Error(`${field} must be an integer`);
  }

  return value;
}

function normalizeCount(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }

  return value;
}

function normalizeScore(value: number, field: string, max: number): number {
  if (!Number.isFinite(value) || value < 0 || value > max) {
    throw new Error(`${field} must be a number between 0 and ${max}`);
  }

  return value;
}

function resolveTrustCeiling(input: number | undefined): number | undefined {
  if (input !== undefined) {
    return normalizeScore(Math.trunc(input), "trustCeiling", TRUST_SCORE_MAX);
  }

  const rawCeiling = process.env.AGT_TRUST_CEILING;

  if (rawCeiling === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(rawCeiling, 10);

  if (Number.isNaN(parsed)) {
    return undefined;
  }

  return Math.max(0, Math.min(TRUST_SCORE_MAX, parsed));
}
