import { describe, expect, it, vi } from "vitest";

import {
  registerDeployment,
  type RuntimeRegistrationRequest,
  type RuntimeRegistrationResponse,
  type ZBrainGovernanceClient
} from "../../src/index.js";
import { createGovernanceBundle } from "../helpers/governance-bundle.js";

describe("registerDeployment", () => {
  it("delegates to the configured client", async () => {
    const request: RuntimeRegistrationRequest = {
      solutionId: "support-automation",
      deploymentId: "dep_001",
      callbacks: {
        bundleUpdateUrl: "https://runtime.example.com/bundle",
        killSwitchUrl: "https://runtime.example.com/kill"
      },
      solutionManifest: { agents: [], tools: [], capabilities: [], resources: [] }
    };
    const response: RuntimeRegistrationResponse = {
      deploymentId: "dep_001",
      bundle: createGovernanceBundle()
    };
    const registerRuntime = vi.fn().mockResolvedValue(response);
    const client = { registerRuntime } as unknown as ZBrainGovernanceClient;

    await expect(registerDeployment(client, request)).resolves.toBe(response);
    expect(registerRuntime).toHaveBeenCalledWith(request);
  });
});
