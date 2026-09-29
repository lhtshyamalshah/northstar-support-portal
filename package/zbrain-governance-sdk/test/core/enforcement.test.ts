import { describe, expect, it } from "vitest";

import {
  GovernanceDeniedError,
  GovernancePolicyEngine,
  PolicyContextBuilder,
  PolicyEvaluator,
  requireAllowed,
  type SolutionManifest
} from "../../src/index.js";

const manifest: SolutionManifest = {
  agents: [
    {
      agentKey: "primary",
      agentDid: "did:zbrain:agent:primary",
      name: "Primary",
      capabilities: ["lookup"],
      tools: ["did:zbrain:tool:lookup"],
      riskTier: "LOW",
      riskScore: 0
    }
  ],
  tools: [
    {
      key: "lookup",
      toolDid: "did:zbrain:tool:lookup",
      capability: "lookup",
      resources: ["internal"],
      category: "read",
      riskTier: "LOW"
    }
  ],
  capabilities: ["lookup"],
  resources: ["internal"]
};

const createEngine = (): GovernancePolicyEngine =>
  new GovernancePolicyEngine(new PolicyContextBuilder(manifest), new PolicyEvaluator());

describe("requireAllowed", () => {
  it("returns the decision when a boundary is permitted", async () => {
    const decision = await requireAllowed(createEngine(), "session-1", {
      checkpoint: "model_call",
      agent: { agentDid: "did:zbrain:agent:primary" }
    });

    expect(decision).toMatchObject({
      allowed: true,
      action: "allow",
      checkpoint: "model_call"
    });
  });

  it("throws a decision-carrying error when a boundary is denied", async () => {
    const denied = requireAllowed(createEngine(), "session-1", {
      checkpoint: "tool_call",
      agent: { agentDid: "did:zbrain:agent:primary" },
      tool: { toolDid: "did:zbrain:tool:lookup" }
    });

    await expect(denied).rejects.toBeInstanceOf(GovernanceDeniedError);
    await expect(denied).rejects.toMatchObject({
      message: "No policy matched; default 'deny' applied for checkpoint 'tool_call'",
      decision: {
        allowed: false,
        action: "deny",
        checkpoint: "tool_call"
      }
    });
  });
});
