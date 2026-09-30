import type { ZBrainGovernanceClient } from "./client.js";
import type { RuntimeRegistrationRequest, RuntimeRegistrationResponse } from "./types.js";

/**
 * Registers the current deployed runtime with the governance microservice.
 *
 * @param client - governance microservice client configured with base URL and API key.
 * @param input - Runtime registration payload.
 * @returns The registration response including the initial governance bundle.
 */
export async function registerDeployment(
  client: ZBrainGovernanceClient,
  input: RuntimeRegistrationRequest
): Promise<RuntimeRegistrationResponse> {
  return await client.registerRuntime(input);
}
