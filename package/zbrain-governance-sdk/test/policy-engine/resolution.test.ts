import { describe, expect, it } from "vitest";

import { PolicyEvaluator, type PolicyContext, type PolicyRule } from "../../src/index.js";

const context: PolicyContext = {
  sessionId: "session-1",
  timestamp: "2026-07-15T10:00:00.000Z",
  checkpoint: "tool_call",
  usage: {
    perToolCallCount: 1,
    totalToolCallCount: 1,
    modelCallPerAgentCount: 0,
    turnCount: 1
  }
};

const solutionAllow: PolicyRule = {
  name: "solution-allow",
  level: "solution",
  checkpoint: "tool_call",
  priority: 200,
  enabled: true,
  condition: { "usage.totalToolCallCount": { lte: 10 } },
  action: "allow",
  reason: "Tool usage is within the solution limit"
};

const enterpriseDeny: PolicyRule = {
  name: "enterprise-deny",
  level: "enterprise",
  checkpoint: "tool_call",
  priority: 1,
  enabled: true,
  condition: { "usage.totalToolCallCount": { gte: 1 } },
  action: "deny",
  reason: "Enterprise maintenance window"
};

describe("policy conflict resolution", () => {
  it("reports a conflict and traces enterprise-deny precedence", async () => {
    const evaluator = new PolicyEvaluator({ rules: [solutionAllow, enterpriseDeny] });

    const decision = await evaluator.evaluate(context);

    expect(decision).toMatchObject({
      allowed: false,
      action: "deny",
      matchedRule: "enterprise-deny",
      matchedRules: ["solution-allow", "enterprise-deny"],
      conflictDetected: true
    });
    expect(decision.resolutionTrace).toEqual(
      expect.arrayContaining([
        "Conflict detected: permitting and deny actions matched",
        "Winner 'enterprise-deny': matching enterprise deny overrides priority"
      ])
    );
  });

  it("defaults to allow for a no-match model checkpoint", async () => {
    const evaluator = new PolicyEvaluator({ rules: [solutionAllow] });

    const decision = await evaluator.evaluate({ ...context, checkpoint: "model_call" });

    expect(decision).toMatchObject({
      allowed: true,
      action: "allow",
      conflictDetected: false,
      matchedRules: []
    });
    expect(decision.resolutionTrace).toEqual(
      expect.arrayContaining([
        "No rules matched; default 'allow' applied for checkpoint 'model_call'"
      ])
    );
  });

  it("defaults to deny for no-match tool and handoff checkpoints", async () => {
    const evaluator = new PolicyEvaluator();

    const toolDecision = await evaluator.evaluate(context);
    const handoffDecision = await evaluator.evaluate({ ...context, checkpoint: "handoff" });

    expect(toolDecision).toMatchObject({
      allowed: false,
      action: "deny",
      conflictDetected: false,
      matchedRules: []
    });
    expect(toolDecision.resolutionTrace).toContain(
      "No rules matched; default 'deny' applied for checkpoint 'tool_call'"
    );

    expect(handoffDecision).toMatchObject({
      allowed: false,
      action: "deny",
      conflictDetected: false,
      matchedRules: []
    });
    expect(handoffDecision.resolutionTrace).toContain(
      "No rules matched; default 'deny' applied for checkpoint 'handoff'"
    );
  });

  it("allows a missing trusted field to match a fail-closed ne rule", async () => {
    const missingRegistrationDeny: PolicyRule = {
      name: "deny-missing-tool-registration",
      level: "enterprise",
      checkpoint: "model_call",
      priority: 100,
      enabled: true,
      condition: { "tool.registered": { ne: true } },
      action: "deny",
      reason: "Tool registration must be present"
    };
    const evaluator = new PolicyEvaluator({ rules: [missingRegistrationDeny] });

    await expect(
      evaluator.evaluate({ ...context, checkpoint: "model_call" })
    ).resolves.toMatchObject({
      allowed: false,
      action: "deny",
      matchedRule: "deny-missing-tool-registration"
    });
  });
});
