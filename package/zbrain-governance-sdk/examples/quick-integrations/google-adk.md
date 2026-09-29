# Google ADK Integration Sketch

> Illustrative pseudocode — it does not compile by design. Verify the installed
> ADK's agent, runner, callback, tool, session, event, and response contracts.

Use before/after model and tool callbacks only when the installed version
documents that they execute at the required points and propagate denial
correctly.

## Basic shape

```ts
async function runAdkAgent(input) {
  const governance = new GovernanceBoundaries(input.sessionId, SUPPORT_AGENT_DID);
  await governance.start(input.userMessage);

  const callbacks = {
    beforeModel: async (event) => {
      await governance.beforeModel({
        model: mapModelContext(event),
        governedTexts: mapInputTextsWithProvenance(event)
      });
      return continueAccordingToInstalledCallbackContract();
    },

    afterModel: async (event) => {
      // This must run before a model-generated tool request is routed.
      await governance.afterModel(
        serializeModelResponseForValidation(event.response),
        mapModelContext(event)
      );
      return continueAccordingToInstalledCallbackContract();
    },

    beforeTool: async (event) => {
      const toolDid = requireManifestToolDid(event.toolName);
      await governance.beforeTool({
        toolDid,
        arguments: selectPolicyArguments(event.arguments)
      });
      return continueAccordingToInstalledCallbackContract();
    },

    afterTool: async (event) => {
      const toolDid = requireManifestToolDid(event.toolName);
      await governance.afterTool(
        { toolDid, arguments: selectPolicyArguments(event.arguments) },
        event.result,
        classifyResultSource(event.result)
      );
      return continueAccordingToInstalledCallbackContract();
    }
  };

  const result = await runUsingInstalledAdk({
    applicationSessionId: input.sessionId,
    callbacks
  });

  await governance.finish();
  return result;
}
```

Callback names, callback return values, and error behavior in this sketch are
symbolic. Confirm whether an exception stops the operation and whether an
after-model callback runs before tool routing in the installed version.

Keep the application's governance session ID stable even if the ADK runtime
also uses separate application, user, invocation, or session identifiers.
Audit nested agents, built-in tools, retries, and parallel execution for
callback coverage.
