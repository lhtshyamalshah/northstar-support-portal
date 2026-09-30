import type { RISK_TIER } from "./types.js";

/** A stable tool declaration and the risk/data classifications it carries. */
export interface ToolDefinition {
  key: string;
  capability: string;
  resources: readonly string[];
  category: TOOL_CATEGORY;
  riskTier: RISK_TIER;
  toolDid: string;
  metadata?: Readonly<Record<string, unknown>>;
}

export type TOOL_CATEGORY = "read" | "write" | "execute" | "communicate" | "delete" | "other";
