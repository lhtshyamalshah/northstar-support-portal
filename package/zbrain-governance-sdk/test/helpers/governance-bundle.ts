import type { GovernanceBundle } from "../../src/index.js";

/** Creates a valid minimal bundle fixture for governance microservice tests. */
export function createGovernanceBundle(version = "2026-07-13.1"): GovernanceBundle {
  return {
    version,
    hash: "sha256:test",
    rules: []
  };
}
