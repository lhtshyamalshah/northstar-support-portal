import { describe, expect, it, vi } from "vitest";

import {
  PolicyEvaluator,
  validateGovernanceBundle,
  type CustomPolicyHandler,
  type CustomPolicyHandlerInput,
  type GovernanceBundle,
  type PolicyContext,
  type PolicyRule
} from "../../src/index.js";

const context: PolicyContext = {
  sessionId: "session-1",
  timestamp: "2026-07-15T10:00:00.000Z",
  checkpoint: "tool_call",
  tool: {
    toolDid: "did:zbrain:tool:refund",
    registered: true,
    arguments: { amount: 850 }
  },
  usage: {
    perToolCallCount: 1,
    totalToolCallCount: 1,
    modelCallPerAgentCount: 0,
    turnCount: 1
  }
};

const customRule: PolicyRule = {
  name: "refund-approval-limit",
  level: "solution",
  kind: "custom",
  checkpoint: "tool_call",
  priority: 100,
  enabled: true,
  config: { maxRefundWithoutApprovalUsd: 500 },
  action: "deny",
  reason: "Refund exceeds the approval-free limit"
};

const handler: CustomPolicyHandler = {
  validateConfig(config) {
    if (typeof config.maxRefundWithoutApprovalUsd !== "number") {
      throw new Error("maxRefundWithoutApprovalUsd must be a number");
    }
  },
  evaluate({ context: evaluationContext, config }) {
    const amount = evaluationContext.tool?.arguments?.amount;
    const limit = config.maxRefundWithoutApprovalUsd;
    const numericLimit = typeof limit === "number" ? limit : null;

    return {
      matched: typeof amount === "number" && numericLimit !== null && amount > numericLimit,
      auditData: { amount: typeof amount === "number" ? amount : null, limit: numericLimit }
    };
  }
};

describe("custom solution policies", () => {
  it("requires the governance microservice rules field", async () => {
    await expect(
      validateGovernanceBundle({
        version: "2026-07-15.1",
        hash: "sha256:test",
        policies: []
      })
    ).rejects.toThrow("Governance bundle rules must be an array");
  });

  it("normalizes uppercase governance-microservice levels before evaluation", async () => {
    const uppercaseRule = { ...customRule, level: "SOLUTION" };
    const evaluate = vi.fn((input: CustomPolicyHandlerInput) => {
      expect(input.rule.level).toBe("solution");
      return { matched: true };
    });

    await expect(
      validateGovernanceBundle(
        {
          version: "2026-07-15.1",
          hash: "sha256:test",
          rules: [uppercaseRule]
        },
        { "refund-approval-limit": { ...handler, evaluate } }
      )
    ).resolves.toBeUndefined();

    await new PolicyEvaluator({
      rules: [uppercaseRule as unknown as PolicyRule],
      customPolicyHandlers: { "refund-approval-limit": { ...handler, evaluate } }
    }).evaluate(context);

    expect(evaluate).toHaveBeenCalledOnce();
  });

  it("treats an omitted kind as a context policy without requiring a handler", async () => {
    const implicitContextRule: PolicyRule = {
      name: "allow-registered-refund-tool",
      level: "solution",
      checkpoint: "tool_call",
      priority: 50,
      enabled: true,
      condition: { "tool.registered": { eq: true } },
      action: "allow",
      reason: "The registered refund tool is permitted"
    };
    const bundle = bundleWithRule(implicitContextRule);

    await expect(validateGovernanceBundle(bundle)).resolves.toBeUndefined();
    await expect(
      new PolicyEvaluator({ rules: [implicitContextRule] }).evaluate(context)
    ).resolves.toMatchObject({
      allowed: true,
      action: "allow",
      matchedRule: "allow-registered-refund-tool"
    });
  });

  it("passes static config and runtime tool arguments to the locally registered handler", async () => {
    const evaluate = vi.fn((input: CustomPolicyHandlerInput) => handler.evaluate(input));
    const evaluator = new PolicyEvaluator({
      rules: [customRule],
      customPolicyHandlers: {
        "refund-approval-limit": { ...handler, evaluate }
      }
    });

    const decision = await evaluator.evaluate(context);

    expect(evaluate).toHaveBeenCalledWith({
      context,
      rule: customRule,
      config: { maxRefundWithoutApprovalUsd: 500 }
    });
    expect(decision).toMatchObject({
      allowed: false,
      action: "deny",
      matchedRule: "refund-approval-limit",
      auditData: { amount: 850, limit: 500 }
    });
  });

  it("rejects a bundle whose custom rule has no locally registered handler", async () => {
    const bundle = bundleWithRule(customRule);

    await expect(validateGovernanceBundle(bundle)).rejects.toThrow(
      "Custom policy handler is not registered for rule 'refund-approval-limit'"
    );
  });

  it("rejects duplicate rule names across the combined governance bundle", async () => {
    const duplicateRule: PolicyRule = { ...customRule, kind: "context", condition: {} };
    const bundle = bundleWithRule(customRule);
    bundle.rules = [customRule, duplicateRule];

    await expect(
      validateGovernanceBundle(bundle, { "refund-approval-limit": handler })
    ).rejects.toThrow(
      "Governance bundle contains duplicate policy rule name 'refund-approval-limit'"
    );
  });

  it("fails closed when a handler throws during evaluation", async () => {
    const evaluator = new PolicyEvaluator({
      rules: [customRule],
      customPolicyHandlers: {
        "refund-approval-limit": {
          ...handler,
          evaluate() {
            throw new Error("billing service unavailable");
          }
        }
      }
    });

    await expect(evaluator.evaluate(context)).resolves.toMatchObject({
      allowed: false,
      action: "deny",
      reason: "Policy evaluation error: billing service unavailable"
    });
  });
});

function bundleWithRule(rule: PolicyRule): GovernanceBundle {
  return {
    version: "2026-07-15.1",
    hash: "sha256:test",
    rules: [rule]
  };
}
