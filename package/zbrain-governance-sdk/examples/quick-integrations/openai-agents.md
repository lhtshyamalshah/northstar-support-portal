# OpenAI Agents Integration Sketch

> Illustrative pseudocode — it does not compile by design. Verify the installed
> Agents SDK's imports, model interface, hooks, tool contract, result type,
> handoff behavior, and streaming behavior.

The adapter needs more than a run-level wrapper. It must cover each provider
dispatch, tool, result, and handoff that the installed runtime can perform.

## Boundary map

| Agent runtime event                 | Governance placement                                    |
| ----------------------------------- | ------------------------------------------------------- |
| Run entry                           | `start(userMessage)`                                    |
| Each internal provider dispatch     | `beforeModel(...)`                                      |
| Each intermediate provider response | `afterModel(...)` before the loop routes it             |
| Application tool execution          | `beforeTool(...)` immediately before the implementation |
| Application tool result             | `afterTool(...)` before returning it to the agent loop  |
| Agent handoff                       | `beforeHandoff(...)` before transferring state          |
| Final result                        | Output check before returning to the backend caller     |

## Basic shape

```ts
// Pseudocode: hook and tool names are symbolic.
async function runSupportAgent(input) {
  const governance = new GovernanceBoundaries(input.sessionId, SUPPORT_AGENT_DID);
  await governance.start(input.userMessage);

  const governedModel = wrapInstalledAgentsModel({
    beforeDispatch: (request) =>
      governance.beforeModel({
        model: mapModelContext(request),
        governedTexts: mapInputTextsWithProvenance(request)
      }),
    afterResponse: (response) =>
      governance.afterModel(extractGovernedText(response), mapModelContext(response))
  });

  const lookupCustomer = defineToolUsingInstalledSdk({
    name: "lookup_customer",
    execute: async (args) => {
      const boundary = {
        toolDid: TOOL_DIDS.lookupCustomer,
        arguments: { customerId: args.customerId }
      };

      await governance.beforeTool(boundary);
      const result = await input.lookupCustomer(args.customerId);
      await governance.afterTool(boundary, result, "retrieved_content");
      return result;
    }
  });

  const result = await runUsingInstalledSdk({
    model: governedModel,
    tools: [lookupCustomer],
    beforeHandoff: (target) => governance.beforeHandoff(requireManifestAgentDid(target))
  });

  // Use this only if the model wrapper did not already validate the same
  // final response. Do not evaluate one model result twice.
  if (!wasCoveredByModelWrapper(result)) {
    await governance.afterModel(extractFinalText(result), mapModelContext(result));
  }
  await governance.finish();
  return result;
}
```

An input filter may expose only the request, and a final-run hook may expose
only the final output. Neither proves that intermediate model responses were
checked before tool routing. If the installed SDK has no complete model
boundary, use its custom model/provider interface or enforce at the provider
client or gateway.

Test built-in tools, hosted tools, nested agents, retries, and handoffs
separately. Application tool wrappers do not automatically cover operations
owned internally by the framework.
