import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearGovernance,
  initializeGovernanceSDK,
  type CustomPolicyHandler,
  type RuntimeRegistrationResponse
} from "../../src/index.js";
import { createGovernanceBundle } from "../helpers/governance-bundle.js";
import { governanceResponse, withJsonServer } from "../helpers/json-server.js";

const callbacks = {
  bundleUpdateUrl: "https://runtime.example.com/.zbrain/bundle",
  killSwitchUrl: "https://runtime.example.com/.zbrain/kill"
};

describe("custom policy handler registration", () => {
  afterEach(() => {
    clearGovernance();
    vi.unstubAllEnvs();
  });

  it("registers handlers by custom rule name during SDK initialization", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zbrain-governance-"));
    const manifestPath = join(tempDir, "solution-manifest.json");
    const validateConfig = vi.fn();
    const handler: CustomPolicyHandler = {
      validateConfig,
      evaluate({ context }) {
        return { matched: context.tool?.arguments?.amount === 850 };
      }
    };
    const response: RuntimeRegistrationResponse = {
      deploymentId: "dep_001",
      bundle: {
        ...createGovernanceBundle(),
        rules: [
          {
            name: "refund-approval-limit",
            level: "solution",
            kind: "custom",
            checkpoint: "tool_call",
            priority: 100,
            enabled: true,
            config: { maxRefundWithoutApprovalUsd: 500 },
            action: "deny",
            reason: "Refund exceeds the approval-free limit"
          }
        ]
      }
    };

    await writeFile(
      manifestPath,
      JSON.stringify({
        agents: [
          {
            agentKey: "billing",
            capabilities: ["billing.refund"],
            tools: ["did:zbrain:tool:refund"],
            name: "Billing agent",
            agentDid: "did:zbrain:agent:billing",
            riskTier: "HIGH",
            riskScore: 80
          }
        ],
        tools: [
          {
            key: "refund",
            capability: "billing.refund",
            resources: ["billing"],
            category: "write",
            riskTier: "HIGH",
            toolDid: "did:zbrain:tool:refund"
          }
        ],
        capabilities: ["billing.refund"],
        resources: ["billing"]
      }),
      "utf-8"
    );

    try {
      await withJsonServer(
        () => governanceResponse(response),
        async (baseUrl) => {
          vi.stubEnv("ZBRAIN_GOVERNANCE_BASE_URL", baseUrl);
          vi.stubEnv("ZBRAIN_GOVERNANCE_API_KEY", "secret");
          vi.stubEnv("ZBRAIN_GOVERNANCE_SOLUTION_ID", "support-automation");
          vi.stubEnv("ZBRAIN_GOVERNANCE_DEPLOYMENT_ID", "dep_001");

          const handle = await initializeGovernanceSDK({
            callbacks,
            manifestPath,
            customPolicyHandlers: { "refund-approval-limit": handler }
          });

          expect(validateConfig).toHaveBeenCalledWith({ maxRefundWithoutApprovalUsd: 500 });
          expect(handle.customPolicyHandlers["refund-approval-limit"]).toBe(handler);

          await expect(
            handle.policyEngine.evaluate({
              sessionId: "session-1",
              checkpoint: "tool_call",
              agent: { agentDid: "did:zbrain:agent:billing" },
              tool: {
                toolDid: "did:zbrain:tool:refund",
                arguments: { amount: 850 }
              }
            })
          ).resolves.toMatchObject({
            allowed: false,
            matchedRule: "refund-approval-limit"
          });
        }
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
