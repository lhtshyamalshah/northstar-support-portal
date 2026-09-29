import { describe, expect, it } from "vitest";

import type { EnterprisePolicyCondition, PolicyCondition, PolicyRule } from "../../src/index.js";

const solutionCondition: PolicyCondition = {
  "agent.name": { in: ["researcher", "support-agent"] },
  "tool.resources": { contains: "customer-data" },
  "tool.arguments.ticket.priority": { eq: "high" },
  "agent.metadata.owner.team": { eq: "operations" },
  "handoff.targetAgentDid": { eq: "did:zbrain:agent:billing" }
};

const enterpriseCondition: EnterprisePolicyCondition = {
  "tool.category": { in: ["read", "communicate"] },
  "usage.totalToolCallCount": { lte: 10 },
  "handoff.registered": { eq: true }
};

const solutionRule: PolicyRule = {
  name: "priority-ticket-rule",
  level: "solution",
  checkpoint: "tool_call",
  priority: 100,
  enabled: true,
  condition: solutionCondition,
  action: "deny",
  reason: "High-priority tickets require approval"
};

const enterpriseRule: PolicyRule = {
  name: "tool-volume-limit",
  level: "enterprise",
  checkpoint: "tool_call",
  priority: 100,
  enabled: true,
  condition: enterpriseCondition,
  action: "deny",
  reason: "Tool-call limit exceeded"
};

const invalidSolutionCondition: PolicyCondition = {
  // @ts-expect-error Unknown fixed context paths are rejected.
  "tool.unknownField": { eq: "not-allowed" }
};

const invalidEnterpriseCondition: EnterprisePolicyCondition = {
  // @ts-expect-error Enterprise rules cannot inspect solution-specific agent names.
  "agent.name": { eq: "researcher" }
};

describe("policy condition paths", () => {
  it("accepts context-derived solution paths and enterprise paths", () => {
    expect(solutionRule.condition).toBe(solutionCondition);
    expect(enterpriseRule.condition).toBe(enterpriseCondition);
    expect(invalidSolutionCondition).toBeDefined();
    expect(invalidEnterpriseCondition).toBeDefined();
  });
});
