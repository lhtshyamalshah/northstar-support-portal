import { describe, expect, it } from "vitest";

import { PolicyContextBuilder, type SolutionManifest } from "../../src/index.js";

const manifest: SolutionManifest = {
  agents: [
    {
      agentKey: "researcher",
      capabilities: ["research.web"],
      tools: ["did:zbrain:tool:search"],
      name: "Research agent",
      agentDid: "did:zbrain:agent:researcher",
      riskTier: "MEDIUM",
      riskScore: 37,
      metadata: { owner: "research" }
    },
    {
      agentKey: "billing",
      capabilities: ["billing.refund"],
      tools: ["did:zbrain:tool:refund"],
      name: "Billing agent",
      agentDid: "did:zbrain:agent:billing",
      riskTier: "HIGH",
      riskScore: 80,
      metadata: { owner: "finance" }
    }
  ],
  tools: [
    {
      key: "web-search",
      capability: "network.egress",
      resources: ["internet"],
      category: "communicate",
      riskTier: "HIGH",
      toolDid: "did:zbrain:tool:search",
      metadata: { provider: "example-search" }
    }
  ],
  capabilities: ["research.web", "network.egress"],
  resources: ["internet"]
};

describe("PolicyContextBuilder", () => {
  it("enriches agent and tool DIDs from the active manifest", () => {
    const builder = new PolicyContextBuilder(manifest);

    const context = builder.create({
      sessionId: "session-1",
      timestamp: "2026-07-15T10:00:00.000Z",
      checkpoint: "tool_call",
      agent: {
        agentDid: "did:zbrain:agent:researcher",
        systemPrompt: "Research only",
        userMessage: "Find governance examples"
      },
      tool: {
        toolDid: "did:zbrain:tool:search",
        arguments: { query: "governance" }
      }
    });

    expect(context.agent).toEqual({
      agentDid: "did:zbrain:agent:researcher",
      registered: true,
      agentKey: "researcher",
      capabilities: ["research.web"],
      tools: ["did:zbrain:tool:search"],
      name: "Research agent",
      riskTier: "MEDIUM",
      riskScore: 37,
      metadata: { owner: "research" },
      systemPrompt: "Research only",
      userMessage: "Find governance examples"
    });
    expect(context.tool).toEqual({
      toolDid: "did:zbrain:tool:search",
      registered: true,
      key: "web-search",
      capability: "network.egress",
      resources: ["internet"],
      category: "communicate",
      riskTier: "HIGH",
      metadata: { provider: "example-search" },
      arguments: { query: "governance" }
    });
    expect(context.usage).toEqual({
      perToolCallCount: 0,
      totalToolCallCount: 0,
      modelCallPerAgentCount: 0,
      turnCount: 0
    });
  });

  it("marks unknown DIDs as unregistered without accepting caller-provided metadata", () => {
    const builder = new PolicyContextBuilder(manifest);

    const context = builder.create({
      sessionId: "session-1",
      checkpoint: "tool_call",
      agent: { agentDid: "did:zbrain:agent:unknown" },
      tool: {
        toolDid: "did:zbrain:tool:unknown",
        arguments: { action: "delete" }
      }
    });

    expect(context.agent).toEqual({ agentDid: "did:zbrain:agent:unknown", registered: false });
    expect(context.tool).toEqual({
      toolDid: "did:zbrain:tool:unknown",
      registered: false,
      arguments: { action: "delete" }
    });
  });

  it("enriches a handoff target from the active manifest", () => {
    const builder = new PolicyContextBuilder(manifest);

    const context = builder.create({
      sessionId: "session-1",
      checkpoint: "handoff",
      agent: { agentDid: "did:zbrain:agent:researcher" },
      handoff: { targetAgentDid: "did:zbrain:agent:billing" }
    });

    expect(context.handoff).toEqual({
      targetAgentDid: "did:zbrain:agent:billing",
      registered: true,
      agentKey: "billing",
      capabilities: ["billing.refund"],
      tools: ["did:zbrain:tool:refund"],
      name: "Billing agent",
      riskTier: "HIGH",
      riskScore: 80,
      metadata: { owner: "finance" }
    });

    expect(
      builder.create({
        sessionId: "session-1",
        checkpoint: "handoff",
        agent: { agentDid: "did:zbrain:agent:researcher" },
        handoff: { targetAgentDid: "did:zbrain:agent:unknown" }
      }).handoff
    ).toEqual({ targetAgentDid: "did:zbrain:agent:unknown", registered: false });
  });

  it("routes governed texts by concrete runtime checkpoint", () => {
    const builder = new PolicyContextBuilder(manifest);

    const agentStart = builder.create({
      sessionId: "session-1",
      checkpoint: "agent_start",
      agent: {
        agentDid: "did:zbrain:agent:researcher",
        userMessage: "Summarize the paper"
      },
      governedTexts: [
        {
          source: "retrieved_content",
          content: "This must not override the user message"
        }
      ]
    });
    expect(agentStart.governedTexts).toEqual([
      {
        source: "user_message",
        content: "Summarize the paper"
      }
    ]);

    const toolResult = builder.create({
      sessionId: "session-1",
      checkpoint: "tool_result",
      agent: { agentDid: "did:zbrain:agent:researcher" },
      tool: { toolDid: "did:zbrain:tool:search" },
      governedTexts: [
        {
          source: "retrieved_content",
          content: "Retrieved paper text"
        }
      ]
    });
    expect(toolResult.governedTexts).toEqual([
      {
        source: "retrieved_content",
        content: "Retrieved paper text"
      }
    ]);

    const modelCall = builder.create({
      sessionId: "session-1",
      checkpoint: "model_call",
      agent: { agentDid: "did:zbrain:agent:researcher" },
      governedTexts: [
        { source: "user_message", content: "Summarize the paper" },
        { source: "retrieved_content", content: "Retrieved paper text" }
      ]
    });
    expect(modelCall.governedTexts).toEqual([
      { source: "user_message", content: "Summarize the paper" },
      { source: "retrieved_content", content: "Retrieved paper text" }
    ]);

    const modelResult = builder.create({
      sessionId: "session-1",
      checkpoint: "model_result",
      agent: { agentDid: "did:zbrain:agent:researcher" },
      governedTexts: [{ source: "model_output", content: "Final answer" }]
    });
    expect(modelResult.governedTexts).toEqual([
      {
        source: "model_output",
        content: "Final answer"
      }
    ]);
  });

  it("derives usage from session-scoped SDK counters", () => {
    const builder = new PolicyContextBuilder(manifest);
    const sessionId = "session-1";
    const agentDid = "did:zbrain:agent:researcher";
    const toolDid = "did:zbrain:tool:search";

    builder.recordTurn(sessionId);
    builder.recordToolCall(sessionId, toolDid);
    builder.recordToolCall(sessionId, toolDid);
    builder.recordModelCall(sessionId, agentDid);
    builder.recordModelCall(sessionId, agentDid);

    expect(
      builder.create({
        sessionId,
        checkpoint: "model_result",
        agent: { agentDid },
        tool: { toolDid }
      }).usage
    ).toEqual({
      perToolCallCount: 2,
      totalToolCallCount: 2,
      modelCallPerAgentCount: 2,
      turnCount: 1
    });

    expect(
      builder.create({
        sessionId: "other-session",
        checkpoint: "agent_start",
        agent: { agentDid },
        tool: { toolDid }
      }).usage
    ).toEqual({
      perToolCallCount: 0,
      totalToolCallCount: 0,
      modelCallPerAgentCount: 0,
      turnCount: 0
    });
  });

  it("aggregates agent-end audit totals per agent", () => {
    const builder = new PolicyContextBuilder(manifest);
    const sessionId = "session-1";
    const researcherDid = "did:zbrain:agent:researcher";
    const billingDid = "did:zbrain:agent:billing";
    const toolDid = "did:zbrain:tool:search";

    builder.recordToolCall(sessionId, toolDid, researcherDid);
    builder.recordToolCall(sessionId, toolDid, researcherDid);
    builder.recordToolCall(sessionId, toolDid, billingDid);
    builder.recordModelCall(sessionId, researcherDid);
    builder.recordModelCall(sessionId, researcherDid);
    builder.recordModelCall(sessionId, billingDid);
    builder.recordModelUsage(sessionId, researcherDid, {
      inputTokens: 12,
      outputTokens: 8,
      totalTokens: 20,
      costUsd: 0.04
    });
    builder.recordModelUsage(sessionId, researcherDid, {
      inputTokens: 5,
      outputTokens: 3,
      costUsd: 0.01
    });

    expect(builder.getAgentAuditSummary(sessionId, researcherDid)).toEqual({
      toolCallsCount: 2,
      llmCallCount: 2,
      totalOutputTokens: 11,
      totalInputTokens: 17,
      totalTokens: 28,
      totalCost: 0.05
    });
    expect(builder.getAgentAuditSummary(sessionId, billingDid)).toEqual({
      toolCallsCount: 1,
      llmCallCount: 1,
      totalOutputTokens: 0,
      totalInputTokens: 0,
      totalTokens: 0
    });
  });
});
