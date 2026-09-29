# AgentMesh

AgentMesh provides identity and trust primitives for governed agent runtimes:

- Mesh DID creation for agents
- Ed25519 identity keys and signatures
- Capability credentials
- Risk scoring for identity signals
- Reward-based trust scoring for runtime behavior
- Optional trust-score sync to the ZBrain governance microservice

Consumers should import from the SDK package entrypoint:

```ts
import {
  AgentIdentity,
  RewardEngine,
  createZBrainGovernanceClient,
  generateAgentDid,
  generateIdentity,
  generateIdentityKeyPair
} from "@zbrain/governance-sdk";
```

## Create An Agent DID

An `agentDid` is the stable decentralized identifier used to associate keys,
credentials, risk signals, reward signals, and trust scores with one agent.

### Generate Identity And DID Together

Use `generateIdentity` when you want the SDK to create both the key pair and
the DID.

```ts
import { generateIdentity } from "@zbrain/governance-sdk";

const agent = generateIdentity({ agentId: "support-agent" });

console.log(agent.did);
console.log(agent.keyPair.publicKey);
```

The generated DID has this shape:

```text
did:mesh:support-agent:<public-key-fingerprint>
```

### Generate DID From Existing Key Material

Use `generateAgentDid` when you already have public key material.

```ts
import { generateAgentDid, generateIdentityKeyPair } from "@zbrain/governance-sdk";

const keyPair = generateIdentityKeyPair();
const agentDid = generateAgentDid("support-agent", keyPair.publicKey);
```

### Create A Full Agent Identity

Use `AgentIdentity` when you want DID, key material, metadata, lifecycle state,
and capability helpers in one object.

```ts
import { AgentIdentity } from "@zbrain/governance-sdk";

const identity = AgentIdentity.generate("Support Agent", ["tickets:read", "tickets:reply"], {
  organization: "Customer Support",
  description: "Handles customer support ticket workflows"
});

const agentDid = identity.did;
```

## Use Trust Score With Client

`RewardEngine` scores behavior across five dimensions:

- `policy_compliance`
- `resource_efficiency`
- `output_quality`
- `security_posture`
- `collaboration_health`

When a governance client is configured, `recalculateScore` posts the updated
trust score through `updateAgentTrustScore`.

```ts
import {
  RewardEngine,
  createZBrainGovernanceClient,
  generateIdentity
} from "@zbrain/governance-sdk";

const agent = generateIdentity({ agentId: "support-agent" });

const client = createZBrainGovernanceClient({
  baseUrl: "https://governance-ms.com",
  apiKey: process.env.ZBRAIN_API_KEY ?? ""
});

const rewardEngine = new RewardEngine({ client });

rewardEngine.recordPolicyCompliance(agent.did, true, "safe-tools-policy");
rewardEngine.recordResourceUsage(agent.did, 850, 1000, 1200, 1500);
rewardEngine.recordOutputQuality(agent.did, true, "ticket-reviewer");
rewardEngine.recordSecurityEvent(agent.did, true, "trust_boundary_ok");
rewardEngine.recordCollaboration(agent.did, true, "did:mesh:triage-agent:abc123");

const trustScore = await rewardEngine.recalculateScore(agent.did);

console.log(trustScore.totalScore);
console.log(trustScore.tier);
```

`recalculateScore` is async because it may call the governance microservice.
Always `await` it when you need the latest local score and remote sync to finish.

## Trust Score Payload

The governance trust-score API receives the reward dimensions directly:

```text
policy_compliance     -> policyCompliance
resource_efficiency   -> resourceEfficiency
output_quality        -> outputQuality
security_posture      -> securityPosture
collaboration_health  -> collaborationHealth
```

The configured client receives a payload shaped like:

```ts
await client.updateAgentTrustScore({
  agentDid,
  trustScore: {
    score: trustScore.totalScore,
    ring: 0, // Derived from score: 0, 1, 2, or 3.
    dimensions: {
      policyCompliance: 100,
      resourceEfficiency: 100,
      outputQuality: 100,
      securityPosture: 100,
      collaborationHealth: 100
    },
    calculatedAt: trustScore.calculatedAt
  }
});
```

## Explain A Trust Score

Use `getScoreExplanation` to inspect why an agent received a score.

```ts
const explanation = rewardEngine.getScoreExplanation(agent.did);

console.log(explanation.dimensions);
console.log(explanation.recentSignals);
console.log(explanation.trend);
```

## Handle Revocation

The reward engine can mark an agent revoked when the score falls below the
configured revocation threshold.

```ts
const rewardEngine = new RewardEngine({
  client,
  config: {
    revocationThreshold: 250,
    warningThreshold: 450
  }
});

rewardEngine.onRevocation((agentDid, reason) => {
  console.warn(`Agent revoked: ${agentDid}`, reason);
});
```
