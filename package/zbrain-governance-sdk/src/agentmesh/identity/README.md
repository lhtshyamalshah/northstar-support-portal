# Trust and Identity

This module provides the local building blocks for the Trust & Identity engine:

- Ed25519 key generation and detached signatures
- Mesh DID generation for agent identities
- File-backed capability credential lifecycle management
- File-backed AGT-style risk signal recording in `risk.ts`
- Continuous risk scoring, trust-ring assignment, and trust-score sync on recalculation

## Example

```ts
import {
  RiskSignal,
  RiskScorer,
  generateIdentity,
  issueCredential,
  createZBrainGovernanceClient
} from "zbrain-governance";

const agent = generateIdentity({ agentId: "support-agent" });

const credential = await issueCredential("./data/credentials.json", {
  agentDid: agent.did,
  scopes: ["email.send"],
  resources: ["gmail:tenant:tenant_123:mailbox:*"]
});

const client = createZBrainGovernanceClient({
  baseUrl: "https://control-plane.example.com",
  apiKey: process.env.ZBRAIN_API_KEY ?? ""
});

const scorer = new RiskScorer({
  storageDir: "./data/risk-signals",
  client
});

await scorer.addSignal(
  agent.did,
  new RiskSignal({
    signalType: "behavior.tool_usage_baseline",
    severity: "low",
    value: 0.2,
    timestamp: Date.now(),
    source: "runtime",
    details: "tool usage stayed within expected baseline"
  })
);

const riskScore = await scorer.recalculate(agent.did);

console.log(riskScore.totalScore, riskScore.riskLevel);
```

Risk signals are persisted per agent as `<storageDir>/<agentDid>.json`, so in-memory signal loss does not erase the scoring history. `recalculate()` posts the current trust-score projection to `POST /v1/api/solutions/agents/trust-score`.
