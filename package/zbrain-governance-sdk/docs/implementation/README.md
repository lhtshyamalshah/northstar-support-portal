# ZBrain Governance Implementation Path

Use this self-contained path when adding `@zbrain/governance-sdk` to a
TypeScript backend. It is ordered for a coding agent that must produce working
application code, not just learn concepts.

## Phases

| Phase | Read                                                                | Produce                                             | Done when                                                                                      |
| ----- | ------------------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 1     | [Write and register the solution manifest](01-solution-manifest.md) | `governance/solution-manifest.json`                 | Every runtime agent and tool has one stable DID and every agent has an exact tool allowlist    |
| 2     | [Write and register solution policies](02-solution-policies.md)     | `governance/solution-policy.json`                   | Every permit and required control is based on tested facts from the registered manifest        |
| 3     | [Integrate the backend](03-backend-integration.md)                  | Local package, startup, fetch, and enforcement code | The service starts fail-closed and checks every action immediately before dispatch             |
| 4     | [Map framework lifecycles](04-framework-integrations.md)            | One version-checked application adapter             | Boundary tests prove that model, tool, handoff, and output operations cannot bypass governance |
| 5     | [Use the SDK quick reference](05-sdk-quick-reference.md)            | Correct imports and types                           | The implementation uses only the package's exported API                                        |

The files under
[`examples/quick-integrations`](../../examples/quick-integrations/README.md)
are companion implementation sketches. Their framework APIs are intentionally
not copy-ready; adapt the boundary ordering to the backend's pinned dependency
versions.

## Non-negotiable runtime contract

Keep these invariants while adapting the examples:

1. Initialize governance before the backend accepts governed work.
2. Use a stable application session ID for the complete agent or LLM run.
3. Use DIDs, not names or keys, as runtime identities. Let the SDK resolve
   registration, risk, tool category, capabilities, resources, and metadata
   from the manifest.
4. Evaluate immediately before every model call, tool call, or handoff.
5. Stop the action when `allowed` is `false`.
6. Increment SDK usage only after permission and immediately before dispatch.
7. Validate untrusted tool/retrieval results before a model can consume them.
8. Read `getGovernance().policyEngine` at each boundary so bundle refreshes
   affect running services.
9. Keep prompts, tool results, secrets, and tool arguments out of ordinary
   logs. Persist the safe `PolicyDecision` fields instead.

## Recommended application layout

```text
governance/
  solution-manifest.json   # loaded at runtime via manifestPath
src/
  governance/
    runtime.ts             # initializeGovernanceSDK wrapper
    boundaries.ts          # evaluate -> record -> dispatch helper
  app.ts
```

If the backend already provides governance runtime and boundary modules, extend
those instead of adding parallel ones — two initialization paths mean one of
them holds a stale `policyEngine`.

Create and validate the manifest first. Then write policies against its exact
DIDs, keys, classifications, capabilities, resources, and metadata. Apply the
framework-specific adapter in phase 4.
