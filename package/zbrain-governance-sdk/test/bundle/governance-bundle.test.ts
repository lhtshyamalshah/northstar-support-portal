import { describe, expect, it } from "vitest";

import { createZBrainGovernanceClient, fetchGovernanceBundle } from "../../src/index.js";
import { createGovernanceBundle } from "../helpers/governance-bundle.js";
import { governanceResponse, requireFirstRequest, withJsonServer } from "../helpers/json-server.js";

describe("governance bundle", () => {
  it("fetches a bundle with camelCase query and response contracts", async () => {
    const bundle = {
      ...createGovernanceBundle(),
      rules: [
        {
          _id: "687dd3cc7e2df9f76c1a0001",
          name: "deny-large-refund",
          level: "solution",
          checkpoint: "tool_call",
          priority: 100,
          enabled: true,
          condition: { "tool.arguments.amount": { gt: 500 } },
          action: "deny",
          reason: "Refund exceeds the approval-free limit"
        }
      ]
    };

    await withJsonServer(
      () => governanceResponse(bundle),
      async (baseUrl, requests) => {
        const client = createZBrainGovernanceClient({ baseUrl, apiKey: "secret" });

        await expect(
          fetchGovernanceBundle(client, {
            solutionId: "support automation",
            environment: "production",
            currentHash: "sha256:old"
          })
        ).resolves.toEqual(bundle);

        const request = requireFirstRequest(requests);
        expect(request.method).toBe("GET");
        expect(request.url).toBe(
          "/v1/api/solutions/support%20automation/bundle?environment=production&currentHash=sha256%3Aold"
        );
        expect(request.authorization).toBe("Bearer secret");
      }
    );
  });
});
