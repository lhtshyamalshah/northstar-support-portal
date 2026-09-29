import { describe, expect, it } from "vitest";

import {
  createZBrainGovernanceClient,
  type AuditLogRequest,
  type PolicyViolationLogRequest,
  type RuntimeRegistrationRequest,
  type RuntimeRegistrationResponse
} from "../../src/index.js";
import { governanceResponse, requireFirstRequest, withJsonServer } from "../helpers/json-server.js";
import { createGovernanceBundle } from "../helpers/governance-bundle.js";

const callbacks = {
  bundleUpdateUrl: "https://runtime.example.com/.zbrain/bundle",
  killSwitchUrl: "https://runtime.example.com/.zbrain/kill"
};

describe("ZBrainGovernanceClient", () => {
  it("registers a runtime through the governance microservice endpoint", async () => {
    const registrationResponse: RuntimeRegistrationResponse = {
      deploymentId: "dep_001",
      bundle: createGovernanceBundle()
    };
    const registrationRequest: RuntimeRegistrationRequest = {
      solutionId: "support-automation",
      deploymentId: "dep_001",
      callbacks,
      manifestHash: "sha256:test",
      solutionManifest: { agents: [], tools: [], capabilities: [], resources: [] }
    };
    const expectedRegistrationPayload = {
      ...registrationRequest,
      deploymentId: "dep_001-support-automation",
      solutionAppId: "support-automation"
    };

    await withJsonServer(
      () => governanceResponse(registrationResponse),
      async (baseUrl, requests) => {
        const client = createZBrainGovernanceClient({ baseUrl, apiKey: "secret" });

        await expect(client.registerRuntime(registrationRequest)).resolves.toEqual(
          registrationResponse
        );

        const request = requireFirstRequest(requests);
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/v1/api/runtime/register");
        expect(request.authorization).toBe("Bearer secret");
        expect(request.contentType).toContain("application/json");
        expect(JSON.parse(request.body) as unknown).toEqual(expectedRegistrationPayload);
      }
    );
  });

  it("rejects a failed governance microservice response", async () => {
    await withJsonServer(
      () => ({
        responseData: null,
        message: "Runtime registration was denied",
        success: false,
        responseCode: 403
      }),
      async (baseUrl) => {
        const client = createZBrainGovernanceClient({ baseUrl, apiKey: "secret" });

        await expect(
          client.registerRuntime({
            solutionId: "support-automation",
            deploymentId: "dep_001",
            callbacks,
            solutionManifest: { agents: [], tools: [], capabilities: [], resources: [] }
          })
        ).rejects.toThrow(
          "governance microservice request failed (403): Runtime registration was denied"
        );
      }
    );
  });

  it("rejects a response without the governance microservice envelope", async () => {
    await withJsonServer(
      () => ({ deploymentId: "dep_001" }),
      async (baseUrl) => {
        const client = createZBrainGovernanceClient({ baseUrl, apiKey: "secret" });

        await expect(
          client.registerRuntime({
            solutionId: "support-automation",
            deploymentId: "dep_001",
            callbacks,
            solutionManifest: { agents: [], tools: [], capabilities: [], resources: [] }
          })
        ).rejects.toThrow("Governance microservice response has an invalid envelope");
      }
    );
  });

  it("posts a matched policy violation to the governance microservice", async () => {
    const violation: PolicyViolationLogRequest = {
      action: "deny",
      solutionAppId: "support-automation",
      deploymentId: "dep_001",
      timestamp: "2026-07-21T10:00:00.000Z",
      sessionId: "run_001",
      checkpoint: "tool_call",
      agentDid: "did:zbrain:agent:billing",
      policyLevel: "solution",
      ruleId: "687dd3cc7e2df9f76c1a0001",
      matchedRules: ["solution-deny-high-value-refund"],
      resolutionTrace: ["Evaluated 1 applicable rule", "Selected solution deny"]
    };

    await withJsonServer(
      () => governanceResponse(null),
      async (baseUrl, requests) => {
        const client = createZBrainGovernanceClient({ baseUrl, apiKey: "secret" });

        await expect(client.postViolationLog(violation)).resolves.toBeUndefined();

        const request = requireFirstRequest(requests);
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/v1/api/violation-logs");
        expect(request.authorization).toBe("Bearer secret");
        expect(JSON.parse(request.body) as unknown).toEqual(violation);
      }
    );
  });

  it("posts a lifecycle audit event to the governance microservice", async () => {
    const auditEvent: AuditLogRequest = {
      solutionAppId: "support-automation",
      deploymentId: "dep_001",
      sessionId: "run_001",
      data: {
        checkpoint: "tool_call",
        timestamp: "2026-07-21T10:00:00.000Z",
        agentDid: "did:zbrain:agent:billing",
        agentName: "Billing agent",
        policyViolation: true,
        toolName: "refund"
      }
    };

    await withJsonServer(
      () => governanceResponse(null),
      async (baseUrl, requests) => {
        const client = createZBrainGovernanceClient({ baseUrl, apiKey: "secret" });

        await expect(client.postAuditLog(auditEvent)).resolves.toBeUndefined();

        const request = requireFirstRequest(requests);
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/v1/api/audit-logs");
        expect(request.authorization).toBe("Bearer secret");
        expect(JSON.parse(request.body) as unknown).toEqual(auditEvent);
      }
    );
  });
});
