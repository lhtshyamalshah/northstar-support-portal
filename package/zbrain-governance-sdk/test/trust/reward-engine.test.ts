import { describe, expect, it, vi } from "vitest";

import {
  DimensionType,
  RewardDimension,
  RewardEngine,
  RewardSignal,
  ScoreThresholds,
  TrustScore
} from "../../src/index.js";
import type { TrustScoreSyncClient as RewardEngineClient } from "../../src/agentmesh/trust/engine.js";

describe("agentmesh trust reward engine", () => {
  it("tracks reward dimensions and calculates weighted trust scores", async () => {
    const engine = new RewardEngine();
    const agentDid = "did:mesh:reward-agent:abc123";

    engine.recordPolicyCompliance(agentDid, true, "safe-tools");
    engine.recordResourceUsage(agentDid, 80, 100, 40, 100);
    engine.recordOutputQuality(agentDid, true, "reviewer");
    engine.recordSecurityEvent(agentDid, true, "boundary_ok");
    engine.recordCollaboration(agentDid, true, "did:mesh:peer:def456");

    const score = await engine.recalculateScore(agentDid);
    const explanation = engine.getScoreExplanation(agentDid);

    expect(score.totalScore).toBeGreaterThan(900);
    expect(score.tier).toBe("verified_partner");
    expect(explanation.dimensions.policy_compliance).toMatchObject({
      signalCount: 1,
      weight: 0.25
    });
    expect(explanation.recentSignals).toHaveLength(5);
  });

  it("revokes agents when critical signals push score below threshold", async () => {
    const engine = new RewardEngine({ revocationThreshold: 450, warningThreshold: 600 });
    const callback = vi.fn();
    const agentDid = "did:mesh:risky-agent:abc123";

    engine.onRevocation(callback);
    engine.recordPolicyCompliance(agentDid, false, "blocked-delete");
    engine.recordSecurityEvent(agentDid, false, "trust_boundary_breach");
    engine.recordOutputQuality(agentDid, false, "reviewer", "unsafe output");
    engine.recordCollaboration(agentDid, false, "did:mesh:peer:def456");
    engine.recordResourceUsage(agentDid, 500, 100, 500, 100);
    const score = await engine.recalculateScore(agentDid);

    expect(score.totalScore).toBeLessThan(450);
    expect(score.tier).toBe("untrusted");
    expect(callback).toHaveBeenCalledWith(agentDid, expect.stringContaining("below threshold"));
    const explanation = engine.getScoreExplanation(agentDid);

    expect(explanation.revoked).toBe(true);
    expect(explanation.revocationReason).toContain("below threshold");
    expect(engine.getAgentsAtRisk()).toEqual([]);
  });

  it("applies trust ceilings and threshold helpers", () => {
    const score = new TrustScore({
      agentDid: "did:mesh:delegated-agent:abc123",
      totalScore: 900,
      trustCeiling: 650
    });
    const dimension = new RewardDimension({ name: DimensionType.POLICY_COMPLIANCE });
    const signal = new RewardSignal({
      dimension: DimensionType.POLICY_COMPLIANCE,
      value: 1,
      source: "test"
    });
    const thresholds = new ScoreThresholds();

    dimension.addSignal(signal);
    score.update(800, { [dimension.name]: dimension });

    expect(score.totalScore).toBe(650);
    expect(score.tier).toBe("standard");
    expect(score.toJSON()).toMatchObject({
      agentDid: "did:mesh:delegated-agent:abc123",
      total_score: 650,
      trust_ceiling: 650
    });
    expect(thresholds.shouldAllow(score.totalScore)).toBe(true);
    expect(thresholds.shouldRevoke(score.totalScore)).toBe(false);
  });

  it("syncs recalculated trust scores to the governance client", async () => {
    const client = {
      updateAgentTrustScore: vi
        .fn<RewardEngineClient["updateAgentTrustScore"]>()
        .mockResolvedValue(undefined)
    };
    const engine = new RewardEngine({ client });
    const agentDid = "did:mesh:sync-agent:abc123";

    engine.recordPolicyCompliance(agentDid, true, "safe-tools");
    engine.recordResourceUsage(agentDid, 80, 100, 40, 100);
    engine.recordOutputQuality(agentDid, true, "reviewer");
    engine.recordSecurityEvent(agentDid, true, "boundary_ok");
    engine.recordCollaboration(agentDid, true, "did:mesh:peer:def456");

    const score = await engine.recalculateScore(agentDid);

    expect(client.updateAgentTrustScore).toHaveBeenCalledWith({
      agentDid,
      trustScore: {
        score: score.totalScore,
        ring: 0,
        dimensions: {
          policyCompliance: 100,
          resourceEfficiency: 100,
          outputQuality: 100,
          securityPosture: 100,
          collaborationHealth: 100
        },
        calculatedAt: score.calculatedAt
      }
    });
  });
});
