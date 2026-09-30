import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  AgentIdentity,
  RiskScorer,
  RiskSignal,
  generateAgentDid,
  generateIdentity,
  generateIdentityKeyPair,
  issueCredential,
  revokeCredential,
  rotateCredential,
  sign,
  validateCredential,
  verifySignature
} from "../../src/index.js";
import { withJsonServer } from "../helpers/json-server.js";

describe("trust and identity", () => {
  it("generates mesh DIDs and serializes the revamped public identity schema", () => {
    const expiresAt = Date.parse("2026-07-16T12:00:00.000Z");
    const identity = AgentIdentity.generate("Support Root", ["tickets:*"], {
      description: "Handles customer support ticket workflows",
      organization: "Customer Support",
      expiresAt,
      metadata: { environment: "production" }
    });
    const persisted = identity.toJSON() as ReturnType<AgentIdentity["toJSON"]> & {
      did?: string;
      publicKey?: string;
      privateKey?: string;
      currentStatus?: string;
      sponsor?: string;
      trustScore?: unknown;
    };

    expect(identity.did).toMatch(/^did:mesh:support-root:[a-f0-9]{16}$/u);
    expect(identity.agentDid).toBe(identity.did);
    expect(identity.identity.publicKey).toContain("BEGIN PUBLIC KEY");
    expect(identity.identity.privateKey).toContain("BEGIN PRIVATE KEY");
    expect(identity.createdAt).toEqual(expect.any(Number));

    expect(persisted).toMatchObject({
      agentDid: identity.did,
      identity: { publicKey: identity.publicKey },
      capabilities: ["tickets:*"],
      name: "support-root",
      description: "Handles customer support ticket workflows",
      organization: "Customer Support",
      createdAt: identity.createdAt,
      expiresAt,
      metadata: { environment: "production" }
    });
    expect(persisted.identity.privateKey).toBeUndefined();
    expect(persisted.did).toBeUndefined();
    expect(persisted.publicKey).toBeUndefined();
    expect(persisted.privateKey).toBeUndefined();
    expect(persisted.currentStatus).toBeUndefined();
    expect(persisted.sponsor).toBeUndefined();
    expect(persisted.trustScore).toBeUndefined();
    expect(identity.exportJSON().identity.privateKey).toBe(identity.privateKey);
  });

  it("derives agent DIDs from key material and supports explicit DID overrides", () => {
    const keyPair = generateIdentityKeyPair();
    const generatedDid = generateAgentDid("Billing Worker", keyPair.publicKey);
    const fromKeyPair = AgentIdentity.fromKeyPair("Billing Worker", keyPair, ["invoices.read"], {
      metadata: { tenant: "tenant_123" }
    });
    const overrideDid = "did:mesh:billing-worker:manual-override";
    const overridden = AgentIdentity.fromKeyPair("Billing Worker", keyPair, [], {
      agentDid: overrideDid
    });

    expect(generatedDid).toMatch(/^did:mesh:billing-worker:[a-f0-9]{16}$/u);
    expect(fromKeyPair.did).toBe(generatedDid);
    expect(fromKeyPair.name).toBe("billing-worker");
    expect(fromKeyPair.metadata).toEqual({ tenant: "tenant_123" });
    expect(overridden.did).toBe(overrideDid);
  });

  it("round-trips public identity JSON without leaking private key material", () => {
    const original = AgentIdentity.generate("Audit Agent", ["audit.read"]);
    const payload = { action: "read", resource: "audit:events" };
    const signature = original.sign(payload);
    const publicCopy = AgentIdentity.fromJSON(original.toJSON());
    const fallbackCopy = AgentIdentity.fromJSON({
      agentDid: "did:mesh:fallback-agent:abc123",
      identity: { publicKey: original.publicKey }
    });

    expect(publicCopy.did).toBe(original.did);
    expect(publicCopy.publicKey).toBe(original.publicKey);
    expect(publicCopy.privateKey).toBeUndefined();
    expect(publicCopy.verify(payload, signature)).toBe(true);
    expect(() => publicCopy.sign(payload)).toThrow(
      `Private key is not available for ${original.did}`
    );
    expect(fallbackCopy.name).toBe("fallback-agent");
  });

  it("enforces active, suspended, revoked, and expired identity states", () => {
    const expiresAt = Date.parse("2026-07-16T12:00:00.000Z");
    const identity = AgentIdentity.generate("Lifecycle Agent", ["tasks.run"], { expiresAt });

    expect(identity.isActive(Date.parse("2026-07-16T11:59:59.999Z"))).toBe(true);
    expect(identity.isActive(expiresAt)).toBe(false);

    identity.suspend("operator review");
    expect(identity.status).toBe("suspended");
    expect(identity.isActive()).toBe(false);

    identity.reactivate();
    expect(identity.status).toBe("active");
    expect(identity.isActive(Date.parse("2026-07-16T11:00:00.000Z"))).toBe(true);

    identity.revoke("incident");
    expect(identity.status).toBe("revoked");
    expect(identity.isActive(Date.parse("2026-07-16T11:00:00.000Z"))).toBe(false);
    expect(() => identity.suspend()).toThrow("Cannot suspend a revoked identity");
    expect(() => identity.reactivate()).toThrow("Cannot reactivate a revoked identity");
  });

  it("delegates only inherited capabilities and records parent identity context", () => {
    const parent = AgentIdentity.generate("Support Root", ["tickets:*", "calendar.read"], {
      organization: "Customer Support"
    });
    const child = parent.delegate("Support Child", ["tickets:reply"], {
      metadata: { purpose: "triage" },
      expiresAt: Date.parse("2026-07-17T00:00:00.000Z")
    });
    const grandchild = child.delegate("Support Grandchild", ["tickets:reply"]);

    expect(parent.hasCapability("tickets:reply")).toBe(true);
    expect(parent.hasCapability("billing.read")).toBe(false);
    expect(child.did).toMatch(/^did:mesh:support-child:[a-f0-9]{16}$/u);
    expect(child.parentDid).toBe(parent.did);
    expect(child.delegationDepth).toBe(1);
    expect(child.organization).toBe("Customer Support");
    expect(child.metadata).toEqual({ purpose: "triage" });
    expect(grandchild.parentDid).toBe(child.did);
    expect(grandchild.delegationDepth).toBe(2);
    expect(() => parent.delegate("Bad Child", ["admin.root"])).toThrow(
      "Cannot delegate capability 'admin.root'"
    );
  });

  it("signs and verifies payloads with generated Ed25519 key pairs", () => {
    const identity = generateIdentity({ agentId: "Signing Agent" });
    const payload = {
      checkpoint: "tool_call",
      resource: "gmail:tenant:tenant_123:mailbox:support"
    };

    const signature = sign(payload, identity.keyPair.privateKey);

    expect(identity.did).toMatch(/^did:mesh:signing-agent:[a-f0-9]{16}$/u);
    expect(verifySignature(payload, signature, identity.keyPair.publicKey)).toBe(true);
    expect(
      verifySignature(
        { ...payload, resource: "gmail:tenant:tenant_123:mailbox:finance" },
        signature,
        identity.keyPair.publicKey
      )
    ).toBe(false);
  });

  it("validates credentials and returns precise denial reasons", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zbrain-credential-"));
    const vaultPath = join(tempDir, "credentials.json");
    const identity = generateIdentity({ agentId: "Credential Agent" });
    const otherIdentity = generateIdentity({ agentId: "Other Agent" });
    const issuedAt = Date.parse("2026-07-15T12:00:00.000Z");

    try {
      const credential = await issueCredential(vaultPath, {
        agentDid: identity.did,
        scopes: ["email.send"],
        resources: ["gmail:tenant:tenant_123:mailbox:*"],
        issuedAt,
        ttlMinutes: 15
      });

      await expect(
        validateCredential(vaultPath, {
          credentialId: credential.credentialId,
          agentDid: identity.did,
          scope: "email.send",
          resource: "gmail:tenant:tenant_123:mailbox:support",
          at: Date.parse("2026-07-15T12:10:00.000Z")
        })
      ).resolves.toMatchObject({ valid: true });

      await expect(
        validateCredential(vaultPath, {
          credentialId: "missing-credential"
        })
      ).resolves.toMatchObject({ valid: false, reason: "credential_not_found" });

      await expect(
        validateCredential(vaultPath, {
          credentialId: credential.credentialId,
          agentDid: otherIdentity.did
        })
      ).resolves.toMatchObject({ valid: false, reason: "agent_mismatch" });

      await expect(
        validateCredential(vaultPath, {
          credentialId: credential.credentialId,
          scope: "email.read",
          at: Date.parse("2026-07-15T12:10:00.000Z")
        })
      ).resolves.toMatchObject({ valid: false, reason: "scope_denied" });

      await expect(
        validateCredential(vaultPath, {
          credentialId: credential.credentialId,
          resource: "slack:tenant:tenant_123:channel:support",
          at: Date.parse("2026-07-15T12:10:00.000Z")
        })
      ).resolves.toMatchObject({ valid: false, reason: "resource_denied" });

      await expect(
        validateCredential(vaultPath, {
          credentialId: credential.credentialId,
          at: Date.parse("2026-07-15T12:20:00.000Z")
        })
      ).resolves.toMatchObject({
        valid: false,
        reason: "credential_expired",
        credential: { status: "expired" }
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rotates and revokes credentials while persisting lifecycle state", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zbrain-credential-"));
    const vaultPath = join(tempDir, "credentials.json");
    const identity = generateIdentity({ agentId: "Credential Lifecycle Agent" });
    const issuedAt = Date.parse("2026-07-15T12:00:00.000Z");

    try {
      const original = await issueCredential(vaultPath, {
        agentDid: identity.did,
        scopes: ["calendar.read"],
        resources: ["calendar:tenant:tenant_123:*"],
        issuedAt,
        ttlMinutes: 15
      });
      const replacement = await rotateCredential(vaultPath, {
        credentialId: original.credentialId,
        scopes: ["calendar.read", "calendar.write"],
        ttlMinutes: 30
      });
      const revocable = await issueCredential(vaultPath, {
        agentDid: identity.did,
        scopes: ["files.read"],
        resources: ["files:tenant:tenant_123:*"],
        issuedAt,
        ttlMinutes: 15
      });
      const revoked = await revokeCredential(vaultPath, revocable.credentialId, "policy violation");

      expect(replacement.credentialId).not.toBe(original.credentialId);
      expect(replacement.scopes).toEqual(["calendar.read", "calendar.write"]);
      await expect(
        rotateCredential(vaultPath, { credentialId: original.credentialId })
      ).rejects.toThrow(`Credential ${original.credentialId} is not active`);
      expect(revoked).toMatchObject({
        status: "revoked",
        revocationReason: "policy violation"
      });
      expect(revoked.revokedAt).toEqual(expect.any(Number));
      await expect(
        validateCredential(vaultPath, {
          credentialId: revocable.credentialId,
          at: Date.parse("2026-07-15T12:01:00.000Z")
        })
      ).resolves.toMatchObject({ valid: false, reason: "credential_inactive" });

      const persistedVault = JSON.parse(await readFile(vaultPath, "utf-8")) as {
        credentials: Array<{
          credentialId: string;
          status: string;
          rotatedToCredentialId?: string;
        }>;
      };

      expect(persistedVault.credentials).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            credentialId: original.credentialId,
            status: "rotated",
            rotatedToCredentialId: replacement.credentialId
          }),
          expect.objectContaining({ credentialId: replacement.credentialId, status: "active" }),
          expect.objectContaining({ credentialId: revocable.credentialId, status: "revoked" })
        ])
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("normalizes and validates risk signal input before scoring", () => {
    const signal = new RiskSignal({
      signalType: " behavior.retry_loop ",
      severity: "high",
      value: 0.8,
      timestamp: "2026-07-15T12:00:00.000Z",
      source: " runtime ",
      details: " retry loop detected "
    });

    expect(signal.toJSON()).toEqual({
      signalType: "behavior.retry_loop",
      severity: "high",
      value: 0.8,
      timestamp: Date.parse("2026-07-15T12:00:00.000Z"),
      source: "runtime",
      details: "retry loop detected"
    });
    expect(signal.weight).toBe(0.75);
    expect(() => new RiskSignal({ signalType: " ", severity: "low", value: 0.1 })).toThrow(
      "signalType is required"
    );
    expect(
      () => new RiskSignal({ signalType: "identity.bad", severity: "low", value: 1.1 })
    ).toThrow("value must be a number between 0 and 1");
  });

  it("persists per-agent risk signals, reloads them, and posts trust score on recalculation", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zbrain-risk-"));
    const agent = generateIdentity({ agentId: "Network Worker" });
    const now = Date.now();

    try {
      await withJsonServer(
        () => ({}),
        async () => {
          const scorer = new RiskScorer({ storageDir: tempDir });

          await scorer.addSignal(
            agent.did,
            new RiskSignal({
              signalType: "identity.expired_attestation",
              severity: "critical",
              value: 1,
              timestamp: now - 25 * 60 * 60 * 1000,
              source: "identity-monitor",
              details: "stale signal should not affect the 24h score"
            })
          );
          await scorer.addSignal(
            agent.did,
            new RiskSignal({
              signalType: "behavior.retry_loop",
              severity: "high",
              value: 0.8,
              timestamp: now - 30_000,
              source: "runtime",
              details: "unexpected retry loop"
            })
          );
          await scorer.addSignal(
            agent.did,
            new RiskSignal({
              signalType: "compliance.policy_warning",
              severity: "medium",
              value: 1,
              timestamp: now - 15_000,
              source: "policy-engine",
              details: "policy warning observed"
            })
          );

          const baseline = new RiskScorer().getScore(agent.did);
          const reloadedScorer = new RiskScorer({ storageDir: tempDir });
          const reloadedSignals = await reloadedScorer.getSignals(agent.did);
          const degradedScore = await reloadedScorer.recalculate(agent.did);

          expect(reloadedSignals).toHaveLength(3);
          expect(degradedScore.totalScore).toBeGreaterThan(baseline.totalScore);
          expect(degradedScore).toMatchObject({
            totalScore: 685,
            riskLevel: "low",
            identityScore: 80,
            behaviorScore: 55,
            complianceScore: 70,
            networkScore: 75,
            activeSignals: 2,
            criticalSignals: 0
          });
        }
      );

      const persistedSignals = JSON.parse(
        await readFile(join(tempDir, `${agent.did}.json`), "utf-8")
      ) as Array<{
        signalType: string;
        value: number;
        timestamp: number;
      }>;

      expect(persistedSignals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            signalType: "behavior.retry_loop",
            value: 0.8,
            timestamp: now - 30_000
          })
        ])
      );
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("emits risk alerts, lists high-risk agents, and clears persisted signals", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "zbrain-risk-"));
    const agent = generateIdentity({ agentId: "Critical Worker" });
    const scorer = new RiskScorer({ storageDir: tempDir });
    const alerts: Array<Record<string, unknown>> = [];

    scorer.onAlert((alert) => {
      alerts.push(alert);
    });

    try {
      for (const signalType of [
        "identity.invalid_proof",
        "identity.expired_attestation",
        "identity.key_mismatch",
        "identity.untrusted_issuer",
        "behavior.retry_loop",
        "behavior.excessive_tool_use",
        "behavior.unusual_access",
        "network.blocked_peer",
        "network.suspicious_route",
        "network.untrusted_domain",
        "network.isolation_event",
        "compliance.policy_violation",
        "compliance.audit_failure",
        "compliance.data_leak"
      ]) {
        await scorer.addSignal(
          agent.did,
          new RiskSignal({
            signalType,
            severity: "critical",
            value: 1
          })
        );
      }

      const criticalScore = await scorer.recalculate(agent.did);

      expect(criticalScore).toMatchObject({
        totalScore: 0,
        riskLevel: "critical",
        identityScore: 0,
        behaviorScore: 0,
        networkScore: 0,
        complianceScore: 0,
        activeSignals: 14,
        criticalSignals: 14
      });
      expect(scorer.getHighRiskAgents()).toContain(criticalScore);
      expect(alerts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "risk_level_change",
            agentDid: agent.did,
            newLevel: "critical"
          }),
          expect.objectContaining({
            type: "critical_risk",
            agentDid: agent.did,
            action: "immediate_review_required"
          })
        ])
      );

      await scorer.clearSignals(agent.did);

      expect(await scorer.getSignals(agent.did)).toEqual([]);
      expect(scorer.getScore(agent.did)).toMatchObject({
        totalScore: 775,
        riskLevel: "low",
        activeSignals: 0,
        criticalSignals: 0
      });
      expect(JSON.parse(await readFile(join(tempDir, `${agent.did}.json`), "utf-8"))).toEqual([]);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
