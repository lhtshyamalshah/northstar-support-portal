import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearGovernance,
  initializeGovernanceSDK,
  maybeGetGovernance,
  type AuditLogRequest,
  type PolicyRule,
  type RuntimeRegistrationResponse
} from "../../src/index.js";
import { governanceResponse, requireFirstRequest, withJsonServer } from "../helpers/json-server.js";
import { createGovernanceBundle } from "../helpers/governance-bundle.js";

const callbacks = {
  bundleUpdateUrl: "https://runtime.example.com/.zbrain/bundle",
  killSwitchUrl: "https://runtime.example.com/.zbrain/kill"
};

describe("governance lifecycle", () => {
  afterEach(() => {
    clearGovernance();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("exits startup when required governance microservice env vars are missing", async () => {
    const exitSpy = mockProcessExit();
    const errorSpy = silenceConsoleError();

    await expect(initializeGovernanceSDK({ callbacks, manifestPath: "" })).rejects.toThrow(
      "process.exit:1"
    );

    expect(errorSpy).toHaveBeenCalledWith("ZBRAIN_GOVERNANCE_BASE_URL is required");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(maybeGetGovernance()).toBeUndefined();
  });

  it("loads the manifest, registers the deployment, and stores the active handle", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zbrain-governance-"));
    const manifestPath = join(tempDir, "solution-manifest.json");
    const solutionManifest = { agents: [], tools: [], capabilities: [], resources: [] };
    const registrationResponse: RuntimeRegistrationResponse = {
      deploymentId: "dep_001",
      bundle: createGovernanceBundle()
    };

    await writeFile(manifestPath, JSON.stringify(solutionManifest), "utf-8");

    try {
      await withJsonServer(
        () => governanceResponse(registrationResponse),
        async (baseUrl, requests) => {
          vi.stubEnv("ZBRAIN_GOVERNANCE", "true");
          vi.stubEnv("ZBRAIN_GOVERNANCE_BASE_URL", baseUrl);
          vi.stubEnv("ZBRAIN_GOVERNANCE_API_KEY", "secret");
          vi.stubEnv("ZBRAIN_GOVERNANCE_SOLUTION_ID", "support-automation");
          vi.stubEnv("ZBRAIN_GOVERNANCE_DEPLOYMENT_ID", "dep_001");

          const handle = await initializeGovernanceSDK({ callbacks, manifestPath });

          expect(handle.enabled).toBe(true);
          expect(handle.bundle).toEqual(registrationResponse.bundle);
          expect(handle.manifest).toEqual(solutionManifest);
          expect(maybeGetGovernance()).toBe(handle);
          expect(JSON.parse(requireFirstRequest(requests).body) as unknown).toMatchObject({
            solutionManifest
          });
        }
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("logs the policy violation and audit event, and falls back to the rule name for an empty _id", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zbrain-governance-"));
    const manifestPath = join(tempDir, "solution-manifest.json");
    const agentDid = "did:zbrain:agent:billing";
    const toolDid = "did:zbrain:tool:refund";
    const ruleId = "687dd3cc7e2df9f76c1a0001";
    const ruleName = "refund-approval-limit";
    const timestamp = "2026-07-21T10:00:00.000Z";
    const violationRule: PolicyRule = {
      _id: ruleId,
      name: ruleName,
      level: "solution",
      checkpoint: "tool_call",
      priority: 100,
      enabled: true,
      condition: { "tool.arguments.amount": { gt: 500 } },
      action: "deny",
      reason: "Refund exceeds the approval-free limit"
    };
    const registrationResponse: RuntimeRegistrationResponse = {
      deploymentId: "dep_001",
      bundle: {
        ...createGovernanceBundle(),
        rules: [violationRule]
      }
    };
    const fallbackRegistrationResponse: RuntimeRegistrationResponse = {
      ...registrationResponse,
      bundle: {
        ...registrationResponse.bundle,
        rules: [{ ...violationRule, _id: "" }]
      }
    };

    await writeFile(
      manifestPath,
      JSON.stringify({
        agents: [
          {
            agentKey: "billing",
            agentDid,
            name: "Billing agent",
            capabilities: ["billing.refund"],
            tools: [toolDid],
            riskTier: "HIGH",
            riskScore: 80
          }
        ],
        tools: [
          {
            key: "refund",
            toolDid,
            capability: "billing.refund",
            resources: ["billing"],
            category: "write",
            riskTier: "HIGH"
          }
        ],
        capabilities: ["billing.refund"],
        resources: ["billing"]
      }),
      "utf-8"
    );

    try {
      await withJsonServer(
        (requests) =>
          governanceResponse(
            requests.length === 4 ? fallbackRegistrationResponse : registrationResponse
          ),
        async (baseUrl, requests) => {
          vi.stubEnv("ZBRAIN_GOVERNANCE_BASE_URL", baseUrl);
          vi.stubEnv("ZBRAIN_GOVERNANCE_API_KEY", "secret");
          vi.stubEnv("ZBRAIN_GOVERNANCE_SOLUTION_ID", "support-automation");
          vi.stubEnv("ZBRAIN_GOVERNANCE_DEPLOYMENT_ID", "dep_001");

          const handle = await initializeGovernanceSDK({ callbacks, manifestPath });
          const decision = await handle.policyEngine.evaluate({
            sessionId: "run_001",
            timestamp,
            checkpoint: "tool_call",
            agent: { agentDid },
            tool: { toolDid, arguments: { amount: 850 } }
          });

          expect(decision).toMatchObject({
            allowed: false,
            action: "deny",
            matchedRule: ruleName,
            matchedRuleId: ruleId,
            matchedRuleLevel: "solution"
          });
          expect(requests).toHaveLength(3);

          const violationRequest = requests[1];
          if (violationRequest === undefined) {
            throw new Error("Expected a policy-violation request");
          }

          expect(violationRequest.method).toBe("POST");
          expect(violationRequest.url).toBe("/v1/api/violation-logs");

          // The trace is a deterministic diagnostic string list whose exact
          // wording is not part of the wire contract, so assert it separately.
          const { resolutionTrace, ...violation } = JSON.parse(violationRequest.body) as {
            resolutionTrace: readonly string[];
          };

          expect(resolutionTrace.length).toBeGreaterThan(0);
          expect(violation).toEqual({
            action: "deny",
            solutionAppId: "support-automation",
            deploymentId: "dep_001",
            timestamp,
            sessionId: "run_001",
            checkpoint: "tool_call",
            agentDid,
            policyLevel: "solution",
            ruleId,
            // Safe decision data: explains the outcome without governed content.
            matchedRules: [ruleName]
          });

          const auditRequest = requests[2];
          if (auditRequest === undefined) {
            throw new Error("Expected an audit-log request");
          }

          expect(auditRequest.method).toBe("POST");
          expect(auditRequest.url).toBe("/v1/api/audit-logs");
          expect(JSON.parse(auditRequest.body) as unknown).toEqual({
            solutionAppId: "support-automation",
            deploymentId: "dep_001",
            sessionId: "run_001",
            data: {
              checkpoint: "tool_call",
              timestamp,
              // Every audit event is attributable to the acting agent.
              agentDid,
              agentName: "Billing agent",
              policyViolation: true,
              violationDetails: {
                action: "deny",
                reason: "Refund exceeds the approval-free limit",
                matchedRule: ruleName,
                matchedRuleId: ruleId,
                matchedRuleLevel: "solution",
                matchedRules: [ruleName],
                conflictDetected: false,
                resolutionTrace
              },
              toolName: "refund"
            }
          });

          await handle.refreshBundle();
          const fallbackDecision = await handle.policyEngine.evaluate({
            sessionId: "run_002",
            timestamp,
            checkpoint: "tool_call",
            agent: {
              agentDid,
              systemPrompt: "You are billing support. CANARY-DO-NOT-LEAK-8f21",
              userMessage: "refund my order for 850"
            },
            tool: { toolDid, arguments: { amount: 850 } },
            governedTexts: [{ source: "user_message", content: "refund my order for 850" }]
          });

          expect(fallbackDecision).toMatchObject({
            matchedRule: ruleName,
            matchedRuleId: "",
            matchedRuleLevel: "solution"
          });
          expect(requests).toHaveLength(6);

          const fallbackViolationRequest = requests[4];
          if (fallbackViolationRequest === undefined) {
            throw new Error("Expected a fallback policy-violation request");
          }

          expect(JSON.parse(fallbackViolationRequest.body) as unknown).toMatchObject({
            ruleId: ruleName,
            matchedRules: [ruleName]
          });

          // Untrusted content must never reach the governance microservice: a
          // system prompt can embed canary tokens, and user messages, tool
          // arguments, and governed text are the governed content itself.
          expect(fallbackViolationRequest.body).not.toContain("CANARY-DO-NOT-LEAK-8f21");
          expect(fallbackViolationRequest.body).not.toContain("refund my order for 850");
          const fallbackAudit = JSON.parse(requests[5]!.body) as AuditLogRequest;
          expect(fallbackAudit.data.violationDetails).toEqual({
            action: "deny",
            reason: fallbackDecision.reason,
            matchedRule: ruleName,
            matchedRuleId: "",
            matchedRuleLevel: "solution",
            matchedRules: [ruleName],
            conflictDetected: false,
            resolutionTrace: fallbackDecision.resolutionTrace
          });
          expect(requests[5]!.body).not.toContain("CANARY-DO-NOT-LEAK-8f21");
          expect(requests[5]!.body).not.toContain("refund my order for 850");
          expect(requests[5]!.body).not.toContain('"amount"');

          const reportedViolation = JSON.parse(fallbackViolationRequest.body) as unknown;
          expect(reportedViolation).not.toHaveProperty("arguments");
          expect(reportedViolation).not.toHaveProperty("auditData");
        }
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("maps supported lifecycle checkpoints and never invents an execution duration", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zbrain-governance-"));
    const manifestPath = join(tempDir, "solution-manifest.json");
    const agentDid = "did:zbrain:agent:billing";
    const toolDid = "did:zbrain:tool:refund";
    const escalationAgentDid = "did:zbrain:agent:escalation";

    await writeFile(
      manifestPath,
      JSON.stringify({
        agents: [
          {
            agentKey: "billing",
            agentDid,
            name: "Billing agent",
            capabilities: ["billing.refund"],
            tools: [toolDid],
            riskTier: "HIGH",
            riskScore: 80
          },
          {
            agentKey: "escalation",
            agentDid: escalationAgentDid,
            name: "Escalation agent",
            capabilities: [],
            tools: [],
            riskTier: "HIGH",
            riskScore: 80
          }
        ],
        tools: [
          {
            key: "refund",
            toolDid,
            capability: "billing.refund",
            resources: ["billing"],
            category: "write",
            riskTier: "HIGH"
          }
        ],
        capabilities: ["billing.refund"],
        resources: ["billing"]
      }),
      "utf-8"
    );

    try {
      await withJsonServer(
        () =>
          governanceResponse({
            deploymentId: "dep_001",
            bundle: createGovernanceBundle()
          }),
        async (baseUrl, requests) => {
          vi.stubEnv("ZBRAIN_GOVERNANCE_BASE_URL", baseUrl);
          vi.stubEnv("ZBRAIN_GOVERNANCE_API_KEY", "secret");
          vi.stubEnv("ZBRAIN_GOVERNANCE_SOLUTION_ID", "support-automation");
          vi.stubEnv("ZBRAIN_GOVERNANCE_DEPLOYMENT_ID", "dep_001");

          const handle = await initializeGovernanceSDK({ callbacks, manifestPath });
          const timestamp = "2026-07-27T08:00:00.000Z";
          const baseInput = { sessionId: "run_001", timestamp, agent: { agentDid } };

          const errorSpy = silenceConsoleError();
          // An unreported outcome is still recorded, with no invented duration.
          await handle.policyEngine.evaluate({
            ...baseInput,
            checkpoint: "model_result",
            model: { name: "gpt-5" }
          });
          const unreported = (JSON.parse(requireFirstRequest(requests.slice(1)).body) as AuditLogRequest)
            .data;
          expect(unreported).toMatchObject({
            checkpoint: "model_result",
            status: "unknown",
            statusReason: "Host reported no status for this boundary"
          });
          expect(unreported).not.toHaveProperty("duration");
          expect(errorSpy).toHaveBeenCalledWith(
            "Governance audit event recorded as 'unknown': Host reported no status for this boundary"
          );
          requests.length = 0;

          await handle.policyEngine.evaluate({ ...baseInput, checkpoint: "agent_start" });
          await handle.policyEngine.evaluate({
            ...baseInput,
            checkpoint: "model_call",
            model: { name: "gpt-5", provider: "openai", inputTokens: 12 }
          });
          handle.policyEngine.recordModelCall("run_001", agentDid);
          await handle.policyEngine.evaluate({
            ...baseInput,
            checkpoint: "tool_call",
            tool: { toolDid }
          });
          await handle.policyEngine.evaluate({
            ...baseInput,
            checkpoint: "tool_result",
            tool: { toolDid },
            status: "completed",
            duration: 18.75
          });
          handle.policyEngine.recordToolCall("run_001", toolDid, agentDid);
          await handle.policyEngine.evaluate({
            ...baseInput,
            checkpoint: "model_result",
            model: {
              name: "gpt-5",
              inputTokens: 12,
              outputTokens: 8,
              totalTokens: 20,
              costUsd: 0.04
            },
            status: "completed",
            duration: 42.5
          });
          await handle.policyEngine.evaluate({
            ...baseInput,
            checkpoint: "handoff",
            handoff: { targetAgentDid: escalationAgentDid }
          });
          await handle.policyEngine.evaluate({
            ...baseInput,
            checkpoint: "agent_end",
            status: "completed",
            duration: 125
          });

          expect(requests).toHaveLength(7);
          const auditEvents = requests.map((request) => JSON.parse(request.body) as unknown);

          expect(auditEvents).toEqual([
            {
              solutionAppId: "support-automation",
              deploymentId: "dep_001",
              sessionId: "run_001",
              data: {
                checkpoint: "agent_start",
                timestamp,
                policyViolation: false,
                agentDid,
                agentName: "Billing agent",
                tools: [toolDid]
              }
            },
            {
              solutionAppId: "support-automation",
              deploymentId: "dep_001",
              sessionId: "run_001",
              data: {
                checkpoint: "model_call",
                timestamp,
                agentDid,
                agentName: "Billing agent",
                policyViolation: false,
                modelName: "gpt-5",
                modelProvider: "openai",
                estimatedInputTokens: 12
              }
            },
            {
              solutionAppId: "support-automation",
              deploymentId: "dep_001",
              sessionId: "run_001",
              data: {
                checkpoint: "tool_call",
                timestamp,
                agentDid,
                agentName: "Billing agent",
                policyViolation: true,
                violationDetails: {
                  action: "deny",
                  reason: "No policy matched; default 'deny' applied for checkpoint 'tool_call'",
                  matchedRules: [],
                  conflictDetected: false,
                  resolutionTrace: [
                    "No rules matched; default 'deny' applied for checkpoint 'tool_call'"
                  ]
                },
                toolName: "refund"
              }
            },
            {
              solutionAppId: "support-automation",
              deploymentId: "dep_001",
              sessionId: "run_001",
              data: {
                checkpoint: "tool_result",
                timestamp,
                agentDid,
                agentName: "Billing agent",
                policyViolation: false,
                toolName: "refund",
                status: "completed",
                duration: 18.75
              }
            },
            {
              solutionAppId: "support-automation",
              deploymentId: "dep_001",
              sessionId: "run_001",
              data: {
                checkpoint: "model_result",
                timestamp,
                agentDid,
                agentName: "Billing agent",
                policyViolation: false,
                modelName: "gpt-5",
                status: "completed",
                duration: 42.5,
                outputTokens: 8,
                totalTokens: 20,
                inputTokens: 12,
                cost: 0.04
              }
            },
            {
              solutionAppId: "support-automation",
              deploymentId: "dep_001",
              sessionId: "run_001",
              data: {
                checkpoint: "handoff",
                timestamp,
                agentDid,
                agentName: "Billing agent",
                policyViolation: true,
                violationDetails: {
                  action: "deny",
                  reason: "No policy matched; default 'deny' applied for checkpoint 'handoff'",
                  matchedRules: [],
                  conflictDetected: false,
                  resolutionTrace: [
                    "No rules matched; default 'deny' applied for checkpoint 'handoff'"
                  ]
                },
                targetAgentName: "Escalation agent",
                targetAgentDid: escalationAgentDid
              }
            },
            {
              solutionAppId: "support-automation",
              deploymentId: "dep_001",
              sessionId: "run_001",
              data: {
                checkpoint: "agent_end",
                timestamp,
                agentDid,
                agentName: "Billing agent",
                policyViolation: false,
                status: "completed",
                duration: 125,
                summary: {
                  toolCallsCount: 1,
                  llmCallCount: 1,
                  totalOutputTokens: 8,
                  totalInputTokens: 12,
                  totalTokens: 20,
                  totalCost: 0.04
                }
              }
            }
          ]);
        }
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each(["warn", "audit", "authorization", "error"] as const)(
    "includes violation diagnostics for %s outcomes",
    async (outcome) => {
      const tempDir = await mkdtemp(join(tmpdir(), "zbrain-governance-"));
      const manifestPath = join(tempDir, "solution-manifest.json");
      const agentDid = "did:zbrain:agent:billing";
      const auditData = { category: "approval", limit: 500 };
      const rule: PolicyRule = {
        name: "approval-check",
        kind: "custom",
        level: "solution",
        checkpoint: "agent_start",
        priority: 100,
        enabled: true,
        config: {},
        action: outcome === "warn" ? "warn" : "audit",
        reason: "Approval check matched"
      };
      await writeFile(
        manifestPath,
        JSON.stringify({
          agents: [
            {
              agentKey: "billing",
              agentDid,
              name: "Billing agent",
              capabilities: [],
              tools: [],
              riskTier: "LOW",
              riskScore: 0
            }
          ],
          tools: [],
          capabilities: [],
          resources: []
        }),
        "utf-8"
      );

      try {
        await withJsonServer(
          () =>
            governanceResponse({
              deploymentId: "dep_001",
              bundle: { ...createGovernanceBundle(), rules: [rule] }
            }),
          async (baseUrl, requests) => {
            vi.stubEnv("ZBRAIN_GOVERNANCE_BASE_URL", baseUrl);
            vi.stubEnv("ZBRAIN_GOVERNANCE_API_KEY", "secret");
            vi.stubEnv("ZBRAIN_GOVERNANCE_SOLUTION_ID", "support-automation");
            vi.stubEnv("ZBRAIN_GOVERNANCE_DEPLOYMENT_ID", "dep_001");
            const handle = await initializeGovernanceSDK({
              callbacks,
              manifestPath,
              customPolicyHandlers: {
                "approval-check": {
                  validateConfig(config) {
                    expect(config).toEqual({});
                  },
                  evaluate() {
                    if (outcome === "error") {
                      throw new Error("PRIVATE-GOVERNED-CONTENT");
                    }
                    return { matched: true, auditData };
                  }
                }
              }
            });
            const decision = await handle.policyEngine.evaluate({
              sessionId: "run_001",
              checkpoint: "agent_start",
              agent: { agentDid: outcome === "authorization" ? "unknown" : agentDid }
            });
            const auditRequests = requests.filter(
              (request) => request.url === "/v1/api/audit-logs"
            );
            expect(auditRequests).toHaveLength(1);
            const request = auditRequests[0]!;
            const { data } = JSON.parse(request.body) as AuditLogRequest;
            expect(data.policyViolation).toBe(true);
            if (outcome === "warn" || outcome === "audit") {
              const violationRequests = requests.filter(
                (entry) => entry.url === "/v1/api/violation-logs"
              );
              expect(violationRequests).toHaveLength(1);
              const violation = JSON.parse(violationRequests[0]!.body) as unknown;
              expect(violation).not.toHaveProperty("auditData");
              expect(violation).not.toHaveProperty("arguments");
              expect(decision.allowed).toBe(true);
              expect(data.metadata).toEqual(auditData);
              expect(data.violationDetails).toEqual({
                action: outcome,
                reason: "Approval check matched",
                matchedRule: "approval-check",
                matchedRuleLevel: "solution",
                matchedRules: ["approval-check"],
                conflictDetected: false,
                resolutionTrace: decision.resolutionTrace,
                auditData
              });
            } else {
              expect(decision.allowed).toBe(false);
              const reason =
                outcome === "authorization"
                  ? "The calling agent is not registered in the solution manifest"
                  : "Policy evaluation failed closed";
              expect(data.violationDetails).toEqual({
                action: "deny",
                reason,
                matchedRules: [],
                conflictDetected: false,
                resolutionTrace: [
                  outcome === "authorization"
                    ? `Manifest authorization denied: ${reason}`
                    : `Fail closed: ${reason}`
                ]
              });
              expect(requests.some((entry) => entry.url === "/v1/api/violation-logs")).toBe(false);
              expect(request.body).not.toContain("PRIVATE-GOVERNED-CONTENT");
            }
          }
        );
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }
  );

  it("keeps the enforcement decision when audit logging fails", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zbrain-governance-"));
    const manifestPath = join(tempDir, "solution-manifest.json");
    const agentDid = "did:zbrain:agent:billing";
    const errorSpy = silenceConsoleError();

    await writeFile(
      manifestPath,
      JSON.stringify({
        agents: [
          {
            agentKey: "billing",
            agentDid,
            name: "Billing agent",
            capabilities: [],
            tools: [],
            riskTier: "LOW",
            riskScore: 0
          }
        ],
        tools: [],
        capabilities: [],
        resources: []
      }),
      "utf-8"
    );

    try {
      await withJsonServer(
        (requests) =>
          requests.length === 1
            ? governanceResponse({
                deploymentId: "dep_001",
                bundle: createGovernanceBundle()
              })
            : {
                responseData: null,
                message: "Audit service unavailable",
                success: false,
                responseCode: 503
              },
        async (baseUrl, requests) => {
          vi.stubEnv("ZBRAIN_GOVERNANCE_BASE_URL", baseUrl);
          vi.stubEnv("ZBRAIN_GOVERNANCE_API_KEY", "secret");
          vi.stubEnv("ZBRAIN_GOVERNANCE_SOLUTION_ID", "support-automation");
          vi.stubEnv("ZBRAIN_GOVERNANCE_DEPLOYMENT_ID", "dep_001");

          const handle = await initializeGovernanceSDK({ callbacks, manifestPath });
          const decision = await handle.policyEngine.evaluate({
            sessionId: "run_001",
            checkpoint: "agent_start",
            agent: { agentDid }
          });

          expect(decision).toMatchObject({ allowed: true, action: "allow" });
          expect(requests).toHaveLength(2);
          expect(errorSpy).toHaveBeenCalledWith(
            "Unable to log governance audit event",
            expect.any(Error)
          );
        }
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("exits startup when the governance microservice returns a malformed policy bundle", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zbrain-governance-"));
    const manifestPath = join(tempDir, "solution-manifest.json");
    const exitSpy = mockProcessExit();
    const errorSpy = silenceConsoleError();

    await writeFile(
      manifestPath,
      JSON.stringify({ agents: [], tools: [], capabilities: [], resources: [] }),
      "utf-8"
    );

    try {
      await withJsonServer(
        () =>
          governanceResponse({
            deploymentId: "dep_001",
            bundle: {
              ...createGovernanceBundle(),
              rules: [{ ruleId: "missing-required-policy-fields" }]
            }
          }),
        async (baseUrl) => {
          vi.stubEnv("ZBRAIN_GOVERNANCE_BASE_URL", baseUrl);
          vi.stubEnv("ZBRAIN_GOVERNANCE_API_KEY", "secret");
          vi.stubEnv("ZBRAIN_GOVERNANCE_SOLUTION_ID", "support-automation");
          vi.stubEnv("ZBRAIN_GOVERNANCE_DEPLOYMENT_ID", "dep_001");

          await expect(initializeGovernanceSDK({ callbacks, manifestPath })).rejects.toThrow(
            "process.exit:1"
          );
        }
      );

      expect(errorSpy).toHaveBeenCalledWith("Unable to load governance policy bundle");
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("runs the scheduled task to re-register and refresh the bundle", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zbrain-governance-"));
    const manifestPath = join(tempDir, "solution-manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ agents: [], tools: [], capabilities: [], resources: [] }),
      "utf-8"
    );

    try {
      await withJsonServer(
        (requests) =>
          governanceResponse({
            deploymentId: "dep_001",
            bundle: createGovernanceBundle(`2026-07-13.${requests.length}`)
          }),
        async (baseUrl, requests) => {
          vi.stubEnv("ZBRAIN_GOVERNANCE_BASE_URL", baseUrl);
          vi.stubEnv("ZBRAIN_GOVERNANCE_API_KEY", "secret");
          vi.stubEnv("ZBRAIN_GOVERNANCE_SOLUTION_ID", "support-automation");
          vi.stubEnv("ZBRAIN_GOVERNANCE_DEPLOYMENT_ID", "dep_001");
          vi.stubEnv("CRON_TIME", "* * * * *");

          const handle = await initializeGovernanceSDK({ callbacks, manifestPath });
          await handle.scheduledTask.execute();

          expect(requests).toHaveLength(2);
          expect(handle.bundle.version).toBe("2026-07-13.2");
        }
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("preserves session usage when refreshing the policy engine", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zbrain-governance-"));
    const manifestPath = join(tempDir, "solution-manifest.json");
    const agentDid = "did:zbrain:agent:primary";
    await writeFile(
      manifestPath,
      JSON.stringify({
        agents: [
          {
            agentKey: "primary",
            agentDid,
            name: "Primary",
            capabilities: [],
            tools: [],
            riskTier: "LOW",
            riskScore: 0
          }
        ],
        tools: [],
        capabilities: [],
        resources: []
      }),
      "utf-8"
    );

    try {
      await withJsonServer(
        (requests) =>
          governanceResponse({
            deploymentId: "dep_001",
            bundle:
              requests.length === 1
                ? createGovernanceBundle("2026-07-13.1")
                : {
                    ...createGovernanceBundle("2026-07-13.2"),
                    rules: [
                      {
                        name: "deny-second-model-call",
                        level: "enterprise",
                        checkpoint: "model_call",
                        priority: 100,
                        enabled: true,
                        condition: { "usage.modelCallPerAgentCount": { gte: 1 } },
                        action: "deny",
                        reason: "The model-call limit was reached"
                      }
                    ]
                  }
          }),
        async (baseUrl) => {
          vi.stubEnv("ZBRAIN_GOVERNANCE_BASE_URL", baseUrl);
          vi.stubEnv("ZBRAIN_GOVERNANCE_API_KEY", "secret");
          vi.stubEnv("ZBRAIN_GOVERNANCE_SOLUTION_ID", "support-automation");
          vi.stubEnv("ZBRAIN_GOVERNANCE_DEPLOYMENT_ID", "dep_001");

          const handle = await initializeGovernanceSDK({ callbacks, manifestPath });
          handle.policyEngine.recordModelCall("session-1", agentDid);

          await handle.refreshBundle();

          await expect(
            handle.policyEngine.evaluate({
              sessionId: "session-1",
              checkpoint: "model_call",
              agent: { agentDid }
            })
          ).resolves.toMatchObject({
            allowed: false,
            action: "deny",
            matchedRule: "deny-second-model-call"
          });
        }
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps the previous bundle and engine when a refreshed detector cannot compile", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zbrain-governance-"));
    const manifestPath = join(tempDir, "solution-manifest.json");
    await writeFile(
      manifestPath,
      JSON.stringify({ agents: [], tools: [], capabilities: [], resources: [] }),
      "utf-8"
    );

    try {
      await withJsonServer(
        (requests) =>
          governanceResponse({
            deploymentId: "dep_001",
            bundle:
              requests.length === 1
                ? createGovernanceBundle("2026-07-13.1")
                : {
                    ...createGovernanceBundle("2026-07-13.2"),
                    rules: [
                      {
                        name: "detect-canary-leak",
                        level: "enterprise",
                        kind: "validation",
                        checkpoint: "validation_lifecycle",
                        priority: 100,
                        enabled: true,
                        condition: { checks: { in: ["canaryLeak"] } },
                        action: "deny",
                        reason: "A prompt canary was exposed"
                      }
                    ]
                  }
          }),
        async (baseUrl) => {
          vi.stubEnv("ZBRAIN_GOVERNANCE_BASE_URL", baseUrl);
          vi.stubEnv("ZBRAIN_GOVERNANCE_API_KEY", "secret");
          vi.stubEnv("ZBRAIN_GOVERNANCE_SOLUTION_ID", "support-automation");
          vi.stubEnv("ZBRAIN_GOVERNANCE_DEPLOYMENT_ID", "dep_001");

          const handle = await initializeGovernanceSDK({ callbacks, manifestPath });
          const previousBundle = handle.bundle;
          const previousEngine = handle.policyEngine;

          await expect(handle.refreshBundle()).rejects.toThrow(
            "canaryLeak validation requires trusted local canary tokens"
          );
          expect(handle.bundle).toBe(previousBundle);
          expect(handle.policyEngine).toBe(previousEngine);
          expect(handle.bundle.version).toBe("2026-07-13.1");

          const errorSpy = silenceConsoleError();
          await handle.scheduledTask.execute();
          expect(errorSpy).toHaveBeenCalledWith(
            "Unable to refresh governance bundle; keeping the active bundle",
            expect.any(Error)
          );
          expect(handle.bundle).toBe(previousBundle);
          expect(handle.policyEngine).toBe(previousEngine);
        }
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records a redacted statusReason on after-boundaries and omits it elsewhere", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zbrain-governance-"));
    const manifestPath = join(tempDir, "solution-manifest.json");
    const agentDid = "did:zbrain:agent:billing";
    const canary = "zbrain-canary-abc123";

    await writeFile(
      manifestPath,
      JSON.stringify({
        agents: [
          {
            agentKey: "billing",
            agentDid,
            name: "Billing agent",
            capabilities: [],
            tools: [],
            riskTier: "HIGH",
            riskScore: 80
          }
        ],
        tools: [],
        capabilities: [],
        resources: []
      }),
      "utf-8"
    );

    try {
      await withJsonServer(
        () =>
          governanceResponse({
            deploymentId: "dep_001",
            bundle: createGovernanceBundle()
          }),
        async (baseUrl, requests) => {
          vi.stubEnv("ZBRAIN_GOVERNANCE_BASE_URL", baseUrl);
          vi.stubEnv("ZBRAIN_GOVERNANCE_API_KEY", "secret");
          vi.stubEnv("ZBRAIN_GOVERNANCE_SOLUTION_ID", "support-automation");
          vi.stubEnv("ZBRAIN_GOVERNANCE_DEPLOYMENT_ID", "dep_001");

          const handle = await initializeGovernanceSDK({
            callbacks,
            manifestPath,
            promptInjection: { canaryTokens: [canary] }
          });
          const baseInput = {
            sessionId: "run_001",
            timestamp: "2026-07-27T08:00:00.000Z",
            agent: { agentDid }
          };

          // A provider error that quoted the protected prompt back at us.
          await handle.policyEngine.evaluate({
            ...baseInput,
            checkpoint: "model_result",
            model: { name: "gpt-5" },
            status: "failed",
            duration: 12,
            statusReason: `APIConnectionError (503): upstream rejected ${canary}`
          });
          // Bounded: one exception cannot dominate the audit event.
          await handle.policyEngine.evaluate({
            ...baseInput,
            checkpoint: "agent_end",
            status: "failed",
            duration: 30,
            statusReason: `  ${"x".repeat(600)}  `
          });
          // Whitespace-only is the same as not supplying one.
          await handle.policyEngine.evaluate({
            ...baseInput,
            checkpoint: "agent_end",
            status: "completed",
            duration: 5,
            statusReason: "   "
          });
          // Before-boundaries have no status, so they carry no reason either.
          await handle.policyEngine.evaluate({
            ...baseInput,
            checkpoint: "agent_start",
            statusReason: "ignored"
          });

          const events = requests
            .slice(1)
            .map((request) => (JSON.parse(request.body) as AuditLogRequest).data);

          expect(events).toHaveLength(4);
          expect(events[0]).toMatchObject({
            checkpoint: "model_result",
            status: "failed",
            statusReason: "APIConnectionError (503): upstream rejected [redacted]"
          });
          expect(events[1]).toMatchObject({ checkpoint: "agent_end", status: "failed" });
          expect((events[1] as { statusReason: string }).statusReason).toHaveLength(500);
          expect(events[2]).not.toHaveProperty("statusReason");
          expect(events[3]).toMatchObject({ checkpoint: "agent_start" });
          expect(events[3]).not.toHaveProperty("statusReason");
        }
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records an after-boundary as unknown when a JS host invents a status", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zbrain-governance-"));
    const manifestPath = join(tempDir, "solution-manifest.json");
    const agentDid = "did:zbrain:agent:billing";

    await writeFile(
      manifestPath,
      JSON.stringify({
        agents: [
          {
            agentKey: "billing",
            agentDid,
            name: "Billing agent",
            capabilities: [],
            tools: [],
            riskTier: "HIGH",
            riskScore: 80
          }
        ],
        tools: [],
        capabilities: [],
        resources: []
      }),
      "utf-8"
    );

    try {
      await withJsonServer(
        () =>
          governanceResponse({
            deploymentId: "dep_001",
            bundle: createGovernanceBundle()
          }),
        async (baseUrl, requests) => {
          vi.stubEnv("ZBRAIN_GOVERNANCE_BASE_URL", baseUrl);
          vi.stubEnv("ZBRAIN_GOVERNANCE_API_KEY", "secret");
          vi.stubEnv("ZBRAIN_GOVERNANCE_SOLUTION_ID", "support-automation");
          vi.stubEnv("ZBRAIN_GOVERNANCE_DEPLOYMENT_ID", "dep_001");

          const handle = await initializeGovernanceSDK({ callbacks, manifestPath });
          const errorSpy = silenceConsoleError();
          const baseInput = {
            sessionId: "run_001",
            timestamp: "2026-07-27T08:00:00.000Z",
            agent: { agentDid },
            duration: 12
          };

          // A TypeScript host cannot reach this; a JavaScript one can.
          await handle.policyEngine.evaluate({
            ...baseInput,
            checkpoint: "agent_end",
            status: "succeeded" as never,
            statusReason: "finished early"
          });
          await handle.policyEngine.evaluate({ ...baseInput, checkpoint: "agent_end" });
          await handle.policyEngine.evaluate({
            ...baseInput,
            checkpoint: "agent_end",
            status: "completed"
          });

          // Three boundaries in, three audit events out: nothing is dropped.
          const events = requests
            .slice(1)
            .map((request) => (JSON.parse(request.body) as AuditLogRequest).data);
          expect(events).toHaveLength(3);
          expect(events[0]).toMatchObject({
            status: "unknown",
            duration: 12,
            statusReason: "Host reported an unsupported status: succeeded; finished early"
          });
          expect(events[1]).toMatchObject({
            status: "unknown",
            statusReason: "Host reported no status for this boundary"
          });
          expect(events[2]).toMatchObject({ status: "completed", duration: 12 });
          expect(events[2]).not.toHaveProperty("statusReason");
          expect(errorSpy).toHaveBeenCalledTimes(2);
        }
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("exits startup when the manifest path is missing", async () => {
    vi.stubEnv("ZBRAIN_GOVERNANCE_BASE_URL", "https://cp.example.com");
    vi.stubEnv("ZBRAIN_GOVERNANCE_API_KEY", "secret");
    vi.stubEnv("ZBRAIN_GOVERNANCE_SOLUTION_ID", "support-automation");
    vi.stubEnv("ZBRAIN_GOVERNANCE_DEPLOYMENT_ID", "dep_001");
    const exitSpy = mockProcessExit();
    const errorSpy = silenceConsoleError();

    await expect(initializeGovernanceSDK({ callbacks, manifestPath: "" })).rejects.toThrow(
      "process.exit:1"
    );

    expect(errorSpy).toHaveBeenCalledWith("manifestPath is required");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits startup when CRON_TIME is invalid", async () => {
    vi.stubEnv("ZBRAIN_GOVERNANCE_BASE_URL", "https://cp.example.com");
    vi.stubEnv("ZBRAIN_GOVERNANCE_API_KEY", "secret");
    vi.stubEnv("ZBRAIN_GOVERNANCE_SOLUTION_ID", "support-automation");
    vi.stubEnv("ZBRAIN_GOVERNANCE_DEPLOYMENT_ID", "dep_001");
    vi.stubEnv("CRON_TIME", "not-a-cron");
    const exitSpy = mockProcessExit();
    const errorSpy = silenceConsoleError();

    await expect(
      initializeGovernanceSDK({ callbacks, manifestPath: "unused.json" })
    ).rejects.toThrow("process.exit:1");

    expect(errorSpy).toHaveBeenCalledWith(
      "CRON_TIME must be a valid cron expression. Received: not-a-cron"
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

function mockProcessExit() {
  return vi.spyOn(process, "exit").mockImplementation((code?: string | number | null): never => {
    throw new Error(`process.exit:${String(code)}`);
  });
}

function silenceConsoleError() {
  return vi.spyOn(console, "error").mockImplementation(() => undefined);
}
