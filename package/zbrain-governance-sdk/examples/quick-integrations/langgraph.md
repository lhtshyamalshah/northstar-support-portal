# LangGraph Integration Sketch

> Illustrative pseudocode — it does not compile by design. Verify the installed
> LangGraph and model-provider types, graph state API, node signatures, routing
> API, retry behavior, and subgraph behavior.

Explicit model and tool nodes make governance placement visible. Prebuilt or
opaque nodes must be audited for hidden dispatches before use.

## Model node

```ts
// Pseudocode: graph and message APIs are symbolic.
async function governedModelNode(state, runConfig) {
  const governance = boundariesForStableSession(runConfig.sessionId);

  await governance.beforeModel({
    model: configuredModelContext,
    governedTexts: selectPromptSegmentsWithProvenance(state.messages)
  });

  const response = await installedModel.invoke(state.messages);

  // This must run before a conditional edge interprets response tool calls.
  await governance.afterModel(
    serializeModelResponseForValidation(response),
    mapModelContext(response)
  );

  return appendMessage(state, response);
}
```

## Tool node

```ts
async function governedToolNode(state, runConfig) {
  const governance = boundariesForStableSession(runConfig.sessionId);

  for (const call of readToolCalls(state)) {
    const tool = requireKnownApplicationTool(call.name);
    const toolDid = requireManifestToolDid(call.name);
    const boundary = {
      toolDid,
      arguments: selectPolicyArguments(call.arguments)
    };

    await governance.beforeTool(boundary);
    const result = await tool.invoke(call.arguments);
    await governance.afterTool(boundary, result, classifyResultSource(result));
    appendToolResult(state, result);
  }

  return state;
}
```

## Graph ordering

```text
START
  -> governed model node
  -> route only after model_result passes
     -> governed tool node
     -> governed model node
  -> agent_end
  -> END
```

Put `beforeHandoff(targetAgentDid)` on an edge before state reaches a different
agent. Carry the backend's stable session ID in graph state or run
configuration; do not create a new governance session per node.

Confirm whether framework retries invoke the node or bypass it at a lower
layer. Govern every parallel branch independently, and ensure overlapping
graph middleware and node wrappers do not count one dispatch twice.
