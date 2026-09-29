import { describe, expect, it } from "vitest";

import {
  GovernancePolicyEngine,
  PolicyContextBuilder,
  PolicyEvaluator,
  type PolicyRule,
  type SolutionManifest
} from "../../src/index.js";

const manifest: SolutionManifest = {
  agents: [
    {
      agentKey: "researcher",
      capabilities: ["research.web"],
      tools: ["did:zbrain:tool:search"],
      name: "Research agent",
      agentDid: "did:zbrain:agent:researcher",
      riskTier: "MEDIUM",
      riskScore: 40
    }
  ],
  tools: [
    {
      key: "search",
      capability: "research.web",
      resources: ["internet"],
      category: "read",
      riskTier: "LOW",
      toolDid: "did:zbrain:tool:search"
    },
    {
      key: "publish",
      capability: "content.publish",
      resources: ["public"],
      category: "communicate",
      riskTier: "HIGH",
      toolDid: "did:zbrain:tool:publish"
    }
  ],
  capabilities: ["research.web", "content.publish"],
  resources: ["internet", "public"]
};

const permissiveToolRule: PolicyRule = {
  name: "solution-allow-all-declared-tools",
  level: "solution",
  checkpoint: "tool_call",
  priority: 100,
  enabled: true,
  condition: {},
  action: "allow",
  reason: "The solution permits declared tool calls"
};

describe("manifest authorization", () => {
  it("denies a declared tool that is outside the calling agent's manifest allowlist", async () => {
    const engine = new GovernancePolicyEngine(
      new PolicyContextBuilder(manifest),
      new PolicyEvaluator({ rules: [permissiveToolRule] })
    );

    await expect(
      engine.evaluate({
        sessionId: "session-1",
        checkpoint: "tool_call",
        agent: { agentDid: "did:zbrain:agent:researcher" },
        tool: { toolDid: "did:zbrain:tool:publish" }
      })
    ).resolves.toMatchObject({
      allowed: false,
      action: "deny",
      matchedRules: [],
      reason: "The calling agent is not authorized for the requested tool"
    });
  });
});
