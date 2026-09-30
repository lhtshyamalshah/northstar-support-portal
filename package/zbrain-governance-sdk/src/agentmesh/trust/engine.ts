import {
  DimensionType,
  RewardDimension,
  RewardSignal,
  TRUST_REVOCATION_THRESHOLD,
  TRUST_WARNING_THRESHOLD,
  TrustScore,
  type RewardTrend
} from "./scoring.js";
import type { TrustScoreUpdateRequest } from "../../core/types.js";

export const REWARD_UPDATE_INTERVAL_SECONDS = 30;
export const WEIGHT_POLICY_COMPLIANCE = 0.25;
export const WEIGHT_RESOURCE_EFFICIENCY = 0.15;
export const WEIGHT_OUTPUT_QUALITY = 0.2;
export const WEIGHT_SECURITY_POSTURE = 0.25;
export const WEIGHT_COLLABORATION_HEALTH = 0.15;

export interface RewardConfigInput {
  updateIntervalSeconds?: number;
  revocationThreshold?: number;
  warningThreshold?: number;
  policyComplianceWeight?: number;
  resourceEfficiencyWeight?: number;
  outputQualityWeight?: number;
  securityPostureWeight?: number;
  collaborationHealthWeight?: number;
  trustScore?: number;
}

export interface TrustScoreSyncClient {
  updateAgentTrustScore(request: TrustScoreUpdateRequest): Promise<unknown>;
}

export interface RewardEngineOptions {
  config?: RewardConfigInput | RewardConfig;
  client?: TrustScoreSyncClient;
}

export interface RewardSignalSummary {
  dimension: DimensionType;
  value: number;
  source: string;
  timestamp: string;
}

export interface RewardScoreExplanation {
  agentDid: string;
  totalScore: number;
  tier: string;
  dimensions: Record<
    string,
    {
      score: number;
      signalCount: number;
      weight: number;
      contribution: number;
      trend: RewardTrend;
    }
  >;
  recentSignals: RewardSignalSummary[];
  trend: RewardTrend;
  revoked: boolean;
  revocationReason: string | undefined;
}

export interface AgentHealthSummary {
  currentScore: number;
  minScore: number;
  maxScore: number;
  avgScore: number;
  trend: RewardTrend;
  revoked: boolean;
}

export interface RewardHealthReport {
  periodDays: number;
  totalAgents: number;
  revokedAgents: number;
  atRiskAgents: number;
  agents: Record<string, AgentHealthSummary>;
}

export type RevocationCallback = (agentDid: string, reason: string) => void;

interface ScoreHistoryEntry {
  timestamp: number;
  score: number;
}

/**
 * Configuration for the reward engine.
 *
 * Controls update cadence, revocation thresholds, dimension weights, and the
 * neutral starting trust score used for newly observed agents.
 */
export class RewardConfig {
  updateIntervalSeconds: number;
  revocationThreshold: number;
  warningThreshold: number;
  policyComplianceWeight: number;
  resourceEfficiencyWeight: number;
  outputQualityWeight: number;
  securityPostureWeight: number;
  collaborationHealthWeight: number;
  trustScore: number;

  constructor(input: RewardConfigInput = {}) {
    this.updateIntervalSeconds = normalizeRange(
      input.updateIntervalSeconds ?? REWARD_UPDATE_INTERVAL_SECONDS,
      "updateIntervalSeconds",
      1,
      300
    );
    this.revocationThreshold = normalizeRange(
      input.revocationThreshold ?? TRUST_REVOCATION_THRESHOLD,
      "revocationThreshold",
      0,
      1000
    );
    this.warningThreshold = normalizeRange(
      input.warningThreshold ?? TRUST_WARNING_THRESHOLD,
      "warningThreshold",
      0,
      1000
    );
    this.policyComplianceWeight = normalizeWeight(
      input.policyComplianceWeight ?? WEIGHT_POLICY_COMPLIANCE,
      "policyComplianceWeight"
    );
    this.resourceEfficiencyWeight = normalizeWeight(
      input.resourceEfficiencyWeight ?? WEIGHT_RESOURCE_EFFICIENCY,
      "resourceEfficiencyWeight"
    );
    this.outputQualityWeight = normalizeWeight(
      input.outputQualityWeight ?? WEIGHT_OUTPUT_QUALITY,
      "outputQualityWeight"
    );
    this.securityPostureWeight = normalizeWeight(
      input.securityPostureWeight ?? WEIGHT_SECURITY_POSTURE,
      "securityPostureWeight"
    );
    this.collaborationHealthWeight = normalizeWeight(
      input.collaborationHealthWeight ?? WEIGHT_COLLABORATION_HEALTH,
      "collaborationHealthWeight"
    );
    this.trustScore = normalizeRange(input.trustScore ?? 0.5, "trustScore", 0, 1);
  }

  /**
   * Validate the configured dimension weights.
   *
   * The reference engine keeps this permissive for API compatibility; this
   * implementation accepts any finite, non-negative weight.
   */
  validateWeights(): boolean {
    return this.weightEntries().every(([, weight]) => Number.isFinite(weight) && weight >= 0);
  }

  getWeight(dimension: DimensionType): number {
    return this.weightEntries().find(([name]) => name === dimension)?.[1] ?? 0;
  }

  weightEntries(): Array<[DimensionType, number]> {
    return [
      [DimensionType.POLICY_COMPLIANCE, this.policyComplianceWeight],
      [DimensionType.RESOURCE_EFFICIENCY, this.resourceEfficiencyWeight],
      [DimensionType.OUTPUT_QUALITY, this.outputQualityWeight],
      [DimensionType.SECURITY_POSTURE, this.securityPostureWeight],
      [DimensionType.COLLABORATION_HEALTH, this.collaborationHealthWeight]
    ];
  }
}

/**
 * Current reward state for one agent.
 *
 * Tracks the latest trust score, per-dimension scores, recent reward signals,
 * score history, and revocation status.
 */
export class AgentRewardState {
  readonly agentDid: string;
  trustScore: TrustScore;
  dimensions: Record<string, RewardDimension>;
  recentSignals: RewardSignal[];
  maxSignals: number;
  scoreHistory: ScoreHistoryEntry[];
  maxHistory: number;
  lastUpdated: number;
  revoked: boolean;
  revokedAt: number | undefined;
  revocationReason: string | undefined;

  constructor(agentDid: string, initialTrustScore = 500) {
    this.agentDid = agentDid;
    this.trustScore = new TrustScore({ agentDid, totalScore: initialTrustScore });
    this.dimensions = {};
    this.recentSignals = [];
    this.maxSignals = 1000;
    this.scoreHistory = [];
    this.maxHistory = 100;
    this.lastUpdated = Date.now();
    this.revoked = false;
  }

  /**
   * Add a reward signal and trim the recent-signal buffer if needed.
   */
  addSignal(signal: RewardSignal): void {
    this.recentSignals.push(signal);

    if (this.recentSignals.length > this.maxSignals) {
      this.recentSignals = this.recentSignals.slice(-this.maxSignals);
    }
  }

  /**
   * Record a trust score in the agent's bounded score history.
   */
  recordScore(score: number): void {
    this.scoreHistory.push({
      timestamp: Date.now(),
      score
    });

    if (this.scoreHistory.length > this.maxHistory) {
      this.scoreHistory = this.scoreHistory.slice(-this.maxHistory);
    }
  }
}

/**
 * Runtime reward engine for learning trust from agent behavior.
 *
 * Scores agent actions across five dimensions: policy compliance, resource
 * efficiency, output quality, security posture, and collaboration health.
 * Scores are explainable, periodically refreshable, and can trigger automatic
 * credential revocation when they fall below the configured threshold.
 */
export class RewardEngine {
  readonly config: RewardConfig;

  private readonly agents = new Map<string, AgentRewardState>();
  private readonly revocationCallbacks: RevocationCallback[] = [];
  private readonly client: TrustScoreSyncClient | undefined;
  private updateTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: RewardConfigInput | RewardConfig | RewardEngineOptions = {}) {
    const { config, client } = resolveRewardEngineOptions(options);

    this.config = config instanceof RewardConfig ? config : new RewardConfig(config);
    this.client = client;
  }

  /**
   * Get the current trust score for an agent, creating neutral state on first use.
   */
  getAgentScore(agentDid: string): TrustScore {
    return this.getOrCreateState(agentDid).trustScore;
  }

  /**
   * Record a reward signal for an agent.
   *
   * @param agentDid - Agent DID that receives the signal.
   * @param dimension - Reward dimension affected by this signal.
   * @param value - Normalized signal value where 0 is poor and 1 is good.
   * @param source - Component that emitted the signal.
   * @param details - Optional signal details for score explanations.
   */
  recordSignal(
    agentDid: string,
    dimension: DimensionType,
    value: number,
    source: string,
    details?: string
  ): void {
    const state = this.getOrCreateState(agentDid);
    const signal = new RewardSignal({
      dimension,
      value,
      source,
      ...(details === undefined ? {} : { details })
    });

    state.addSignal(signal);

    if (value < 0.3) {
      void this.recalculateScore(agentDid).catch(() => undefined);
    }
  }

  /**
   * Record whether an agent action complied with policy.
   */
  recordPolicyCompliance(agentDid: string, compliant: boolean, policyName?: string): void {
    this.recordSignal(
      agentDid,
      DimensionType.POLICY_COMPLIANCE,
      compliant ? 1 : 0,
      "policy_engine",
      policyName ? `Policy: ${policyName}` : undefined
    );
  }

  /**
   * Record resource efficiency from token and compute usage against budgets.
   */
  recordResourceUsage(
    agentDid: string,
    tokensUsed: number,
    tokensBudget: number,
    computeMs: number,
    computeBudgetMs: number
  ): void {
    const tokenEfficiency = Math.min(1, tokensBudget / Math.max(1, tokensUsed));
    const computeEfficiency = Math.min(1, computeBudgetMs / Math.max(1, computeMs));
    const efficiency = (tokenEfficiency + computeEfficiency) / 2;

    this.recordSignal(
      agentDid,
      DimensionType.RESOURCE_EFFICIENCY,
      efficiency,
      "resource_monitor",
      `tokens=${tokensUsed}/${tokensBudget}, compute=${computeMs}/${computeBudgetMs}ms`
    );
  }

  /**
   * Record downstream output quality based on whether a consumer accepted it.
   */
  recordOutputQuality(
    agentDid: string,
    accepted: boolean,
    consumer: string,
    rejectionReason?: string
  ): void {
    this.recordSignal(
      agentDid,
      DimensionType.OUTPUT_QUALITY,
      accepted ? 1 : 0,
      `consumer:${consumer}`,
      rejectionReason
    );
  }

  /**
   * Record whether a security event stayed within the agent's trust boundary.
   */
  recordSecurityEvent(agentDid: string, withinBoundary: boolean, eventType: string): void {
    this.recordSignal(
      agentDid,
      DimensionType.SECURITY_POSTURE,
      withinBoundary ? 1 : 0,
      "security_monitor",
      eventType
    );
  }

  /**
   * Record inter-agent collaboration health from handoff success or failure.
   */
  recordCollaboration(agentDid: string, handoffSuccessful: boolean, peerDid: string): void {
    this.recordSignal(
      agentDid,
      DimensionType.COLLABORATION_HEALTH,
      handoffSuccessful ? 1 : 0,
      `collaboration:${peerDid}`
    );
  }

  /**
   * Recalculate an agent trust score from recent signals.
   *
   * Each dimension is scored from recent signals with a recency bias, then the
   * dimension scores are weighted and scaled into the 0-1000 trust range. When
   * a governance client is configured, the updated score is synced through
   * `updateAgentTrustScore`.
   */
  async recalculateScore(agentDid: string): Promise<TrustScore> {
    const state = this.getOrCreateState(agentDid);
    const dimensionScores = new Map<DimensionType, number>();

    for (const dimension of Object.values(DimensionType)) {
      const signals = state.recentSignals.filter((signal) => signal.dimension === dimension);
      const score = calculateDimensionScore(signals);

      dimensionScores.set(dimension, score);
      state.dimensions[dimension] = new RewardDimension({
        name: dimension,
        score,
        signalCount: signals.length,
        positiveSignals: signals.filter((signal) => signal.value >= 0.5).length,
        negativeSignals: signals.filter((signal) => signal.value < 0.5).length
      });
    }

    const totalScore = Math.max(
      0,
      Math.min(
        1000,
        Math.trunc(
          this.config
            .weightEntries()
            .reduce(
              (total, [dimension, weight]) =>
                total + (dimensionScores.get(dimension) ?? 50) * weight,
              0
            ) * 10
        )
      )
    );

    state.trustScore.update(totalScore, state.dimensions);
    state.recordScore(state.trustScore.totalScore);
    state.lastUpdated = Date.now();

    if (state.trustScore.totalScore < this.config.revocationThreshold && !state.revoked) {
      this.triggerRevocation(
        agentDid,
        `Trust score ${state.trustScore.totalScore} below threshold`
      );
    }

    if (this.client) {
      await this.client.updateAgentTrustScore({
        agentDid,
        trustScore: toTrustScorePayload(state.trustScore)
      });
    }

    return state.trustScore;
  }

  /**
   * Register a callback for automatic trust revocation events.
   */
  onRevocation(callback: RevocationCallback): void {
    this.revocationCallbacks.push(callback);
  }

  /**
   * Return an explainable breakdown of an agent's trust score.
   *
   * Includes per-dimension contributions, recent signals, trend, and revocation
   * status.
   */
  getScoreExplanation(agentDid: string): RewardScoreExplanation {
    const state = this.getOrCreateState(agentDid);

    return {
      agentDid,
      totalScore: state.trustScore.totalScore,
      tier: state.trustScore.tier,
      dimensions: Object.fromEntries(
        Object.entries(state.dimensions).map(([name, dimension]) => {
          const weight = this.config.getWeight(name as DimensionType);

          return [
            name,
            {
              score: dimension.score,
              signalCount: dimension.signalCount,
              weight,
              contribution: dimension.score * weight,
              trend: dimension.trend
            }
          ];
        })
      ),
      recentSignals: state.recentSignals.slice(-10).map((signal) => ({
        dimension: signal.dimension,
        value: signal.value,
        source: signal.source,
        timestamp: new Date(signal.timestamp).toISOString()
      })),
      trend: this.calculateTrend(state),
      revoked: state.revoked,
      revocationReason: state.revocationReason
    };
  }

  /**
   * Start periodic background recalculation for all tracked agents.
   */
  startBackgroundUpdates(): void {
    if (this.updateTimer) {
      return;
    }

    this.updateTimer = setInterval(() => {
      for (const agentDid of this.agents.keys()) {
        void this.recalculateScore(agentDid).catch(() => undefined);
      }
    }, this.config.updateIntervalSeconds * 1000);
  }

  /**
   * Stop periodic background score updates.
   */
  stopBackgroundUpdates(): void {
    if (!this.updateTimer) {
      return;
    }

    clearInterval(this.updateTimer);
    this.updateTimer = undefined;
  }

  /**
   * Update dimension weights used by future score recalculations.
   *
   * Weight changes take effect the next time an agent score is recalculated.
   */
  updateWeights(input: {
    policyCompliance?: number;
    resourceEfficiency?: number;
    outputQuality?: number;
    securityPosture?: number;
    collaborationHealth?: number;
  }): boolean {
    if (input.policyCompliance !== undefined) {
      this.config.policyComplianceWeight = normalizeWeight(
        input.policyCompliance,
        "policyCompliance"
      );
    }

    if (input.resourceEfficiency !== undefined) {
      this.config.resourceEfficiencyWeight = normalizeWeight(
        input.resourceEfficiency,
        "resourceEfficiency"
      );
    }

    if (input.outputQuality !== undefined) {
      this.config.outputQualityWeight = normalizeWeight(input.outputQuality, "outputQuality");
    }

    if (input.securityPosture !== undefined) {
      this.config.securityPostureWeight = normalizeWeight(input.securityPosture, "securityPosture");
    }

    if (input.collaborationHealth !== undefined) {
      this.config.collaborationHealthWeight = normalizeWeight(
        input.collaborationHealth,
        "collaborationHealth"
      );
    }

    return this.config.validateWeights();
  }

  /**
   * List agents with scores below the warning threshold and not already revoked.
   */
  getAgentsAtRisk(): string[] {
    return [...this.agents.entries()]
      .filter(([, state]) => !state.revoked)
      .filter(([, state]) => state.trustScore.totalScore < this.config.warningThreshold)
      .map(([agentDid]) => agentDid);
  }

  /**
   * Build a longitudinal health report for recently scored agents.
   *
   * @param days - Number of days of score history to include.
   */
  getHealthReport(days = 7): RewardHealthReport {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const agents: Record<string, AgentHealthSummary> = {};

    for (const [agentDid, state] of this.agents.entries()) {
      const history = state.scoreHistory.filter((entry) => entry.timestamp >= cutoff);

      if (history.length > 0) {
        const scores = history.map((entry) => entry.score);

        agents[agentDid] = {
          currentScore: state.trustScore.totalScore,
          minScore: Math.min(...scores),
          maxScore: Math.max(...scores),
          avgScore: scores.reduce((total, score) => total + score, 0) / scores.length,
          trend: this.calculateTrend(state),
          revoked: state.revoked
        };
      }
    }

    return {
      periodDays: days,
      totalAgents: this.agents.size,
      revokedAgents: [...this.agents.values()].filter((state) => state.revoked).length,
      atRiskAgents: this.getAgentsAtRisk().length,
      agents
    };
  }

  /**
   * Trigger automatic credential revocation and notify registered callbacks.
   */
  private triggerRevocation(agentDid: string, reason: string): void {
    const state = this.agents.get(agentDid);

    if (!state) {
      return;
    }

    state.revoked = true;
    state.revokedAt = Date.now();
    state.revocationReason = reason;

    for (const callback of this.revocationCallbacks) {
      try {
        callback(agentDid, reason);
      } catch {
        // Revocation hooks must not break scoring.
      }
    }
  }

  /**
   * Calculate whether recent score history is improving, degrading, or stable.
   */
  private calculateTrend(state: AgentRewardState): RewardTrend {
    if (state.scoreHistory.length < 2) {
      return "stable";
    }

    const recent = state.scoreHistory.slice(-10).map((entry) => entry.score);

    if (recent.length < 2) {
      return "stable";
    }

    const recentWindow = recent.slice(-5);
    const olderWindow = recent.length > 5 ? recent.slice(0, -5) : recentWindow;
    const avgRecent = average(recentWindow);
    const avgOlder = average(olderWindow);

    if (avgRecent > avgOlder + 50) {
      return "improving";
    }

    if (avgRecent < avgOlder - 50) {
      return "degrading";
    }

    return "stable";
  }

  /**
   * Get existing agent reward state or initialize it with the neutral trust score.
   */
  private getOrCreateState(agentDid: string): AgentRewardState {
    const existingState = this.agents.get(agentDid);

    if (existingState) {
      return existingState;
    }

    const state = new AgentRewardState(agentDid, Math.trunc(this.config.trustScore * 1000));

    this.agents.set(agentDid, state);

    return state;
  }
}

function calculateDimensionScore(signals: readonly RewardSignal[]): number {
  if (signals.length === 0) {
    return 50;
  }

  let total = 0;
  let weightSum = 0;

  signals.slice(-100).forEach((signal, index) => {
    const weight = (1 + index / 100) * signal.weight;

    total += signal.value * weight;
    weightSum += weight;
  });

  return weightSum > 0 ? (total / weightSum) * 100 : 50;
}

function resolveRewardEngineOptions(
  options: RewardConfigInput | RewardConfig | RewardEngineOptions
): RewardEngineOptions {
  if (options instanceof RewardConfig) {
    return { config: options };
  }

  if ("config" in options || "client" in options) {
    return options;
  }

  return { config: options as RewardConfigInput };
}

function toTrustScorePayload(score: TrustScore): TrustScoreUpdateRequest["trustScore"] {
  const complianceScore = getDimensionScore(score, DimensionType.POLICY_COMPLIANCE);
  const resourceScore = getDimensionScore(score, DimensionType.RESOURCE_EFFICIENCY);
  const outputScore = getDimensionScore(score, DimensionType.OUTPUT_QUALITY);
  const securityScore = getDimensionScore(score, DimensionType.SECURITY_POSTURE);
  const collaborationScore = getDimensionScore(score, DimensionType.COLLABORATION_HEALTH);

  return {
    score: score.totalScore,
    ring: mapScoreToRing(score.totalScore),
    dimensions: {
      policyCompliance: Math.trunc(complianceScore),
      resourceEfficiency: Math.trunc(resourceScore),
      outputQuality: Math.trunc(outputScore),
      securityPosture: Math.trunc(securityScore),
      collaborationHealth: Math.trunc(collaborationScore)
    },
    calculatedAt: score.calculatedAt
  };
}

function getDimensionScore(score: TrustScore, dimension: DimensionType): number {
  return score.dimensions[dimension]?.score ?? 50;
}

function mapScoreToRing(score: number): number {
  if (score >= 900) {
    return 0;
  }

  if (score >= 700) {
    return 1;
  }

  if (score >= 500) {
    return 2;
  }

  return 3;
}

function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function normalizeRange(value: number, field: string, min: number, max: number): number {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be a number between ${min} and ${max}`);
  }

  return value;
}

function normalizeWeight(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative number`);
  }

  return value;
}
