import type { ZBrainGovernanceClient } from "../core/client.js";
import type { PolicyRule } from "../policy-engine/types.js";

/**
 * The policy document returned by the governance service and enforced locally.
 *
 * The current SDK validates its structure but does not verify a signature or
 * recompute `hash`.
 */
export interface GovernanceBundle {
  version: string;
  hash: string;
  rules: readonly PolicyRule[];
}

/** Query parameters accepted by the governance microservice bundle endpoint. */
export interface FetchGovernanceBundleInput {
  solutionId: string;
  environment: string;
  currentHash?: string;
}

/**
 * Fetches the latest governance bundle through the governance microservice client.
 *
 * This operation does not validate or activate the returned bundle.
 *
 * @param client - Authenticated governance microservice client.
 * @param input - Solution, environment, and optional current bundle hash.
 */
export async function fetchGovernanceBundle(
  client: ZBrainGovernanceClient,
  input: FetchGovernanceBundleInput
): Promise<GovernanceBundle> {
  return await client.fetchGovernanceBundle(input);
}
