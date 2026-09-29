import type { PolicyContextInput } from "../policy-engine/context.js";
import type { PolicyDecision } from "../policy-engine/types.js";
import type { GovernancePolicyEngine } from "./index.js";

/**
 * The runtime facts for a governed boundary, excluding the session identifier.
 *
 * Reusing this type prevents a host adapter from accidentally overriding the
 * stable session ID it received from its workflow or request boundary.
 */
export type PolicyBoundaryInput = Omit<PolicyContextInput, "sessionId">;

/**
 * Raised when a governed action is not permitted by the active policy bundle.
 *
 * The complete policy decision is retained so an application can safely map it
 * to its own HTTP, agent-framework, or workflow error response and audit it.
 */
export class GovernanceDeniedError extends Error {
  constructor(readonly decision: PolicyDecision) {
    super(decision.reason);
    this.name = "GovernanceDeniedError";
  }
}

/**
 * Evaluates a runtime boundary and raises GovernanceDeniedError when it is not
 * allowed.
 *
 * This is a framework-neutral convenience for the common host pattern:
 * evaluate, stop on denial, and otherwise continue to the side effect.
 */
export async function requireAllowed(
  engine: GovernancePolicyEngine,
  sessionId: string,
  input: PolicyBoundaryInput
): Promise<PolicyDecision> {
  const decision = await engine.evaluate({ sessionId, ...input });

  if (!decision.allowed) {
    throw new GovernanceDeniedError(decision);
  }

  return decision;
}
