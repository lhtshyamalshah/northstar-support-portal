# Direct LLM Call Integration Sketch

> Illustrative pseudocode — it does not compile by design. Provider request,
> response, usage, and streaming APIs vary by package and version.

Use this shape when application code directly owns the provider dispatch.

## Boundary map

| Operation                    | Governance placement                                       |
| ---------------------------- | ---------------------------------------------------------- |
| Receive the governed request | `start(userMessage)`                                       |
| Send a provider request      | `beforeModel(...)` immediately before the provider call    |
| Receive a provider response  | `afterModel(...)` before routing, storing, or returning it |
| Complete the run             | `finish()` before reporting successful completion          |

## Basic shape

```ts
// Pseudocode: adapt every provider.* and response.* expression.
async function answer(sessionId, userMessage) {
  const governance = new GovernanceBoundaries(sessionId, SUPPORT_AGENT_DID);
  await governance.start(userMessage);

  const modelContext = {
    provider: configuredProvider,
    name: configuredModel
  };

  await governance.beforeModel({
    model: modelContext,
    governedTexts: [{ source: "user_message", content: userMessage }]
  });

  const response = await provider.generate({
    model: configuredModel,
    input: userMessage
  });

  const output = extractTextUsingInstalledSdk(response);
  await governance.afterModel(output, {
    ...modelContext,
    ...extractAvailableUsageFacts(response)
  });

  await governance.finish();
  return output;
}
```

`beforeModel` must be the last authorization step before the real network
dispatch. `afterModel` must complete before the output is sent to another
model, persisted, returned, or streamed.

If the provider exposes streaming only, buffer output until the result check
passes or design an explicit incremental control. A final check cannot retract
tokens already released.

The Phase 3 ordering counts allowed model calls. Token and cost values in
`ModelContext` are evaluation facts; they are not accumulated into SDK usage
counters automatically.
