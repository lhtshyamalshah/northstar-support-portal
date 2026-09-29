import type { RISK_TIER } from "./types.js";

/** A stable, deployable agent declaration in a solution manifest. */
export interface AgentDefinition {
  agentKey: string;
  capabilities: readonly string[];
  tools: readonly string[];
  name: string;
  agentDid: string;
  riskTier: RISK_TIER;
  riskScore: number;
  metadata?: Readonly<Record<string, unknown>>;
}
