# Claude Agent SDK Integration Sketch

> Illustrative pseudocode — it does not compile by design. Verify the installed
> Agent SDK's hook events, permission response contract, MCP helpers, result
> events, model visibility, configuration sources, and streaming behavior.

A pre-tool hook can block a tool only if every relevant tool passes through
that hook. It does not by itself govern internal model calls or outputs.

## Basic shape

```ts
async function runClaudeAgent(input) {
  const governance = new GovernanceBoundaries(input.sessionId, SUPPORT_AGENT_DID);
  await governance.start(input.userMessage);

  const preToolHook = async (event) => {
    const toolDid = requireManifestToolDid(event.toolName);

    try {
      await governance.beforeTool({
        toolDid,
        arguments: selectPolicyArguments(event.arguments)
      });
      return allowAccordingToInstalledHookContract();
    } catch (error) {
      if (error instanceof GovernanceDeniedError) {
        return denyAccordingToInstalledHookContract(error.decision.reason);
      }
      throw error;
    }
  };

  const governedTool = defineToolOrMcpHandler({
    name: "lookup_customer",
    execute: async (args) => {
      // beforeTool is already performed by preToolHook in this design.
      // Do not record the same call again in this wrapper.
      const result = await input.lookupCustomer(args.customerId);

      await governance.afterTool(
        {
          toolDid: TOOL_DIDS.lookupCustomer,
          arguments: { customerId: args.customerId }
        },
        result,
        "retrieved_content"
      );

      return result;
    }
  });

  const result = await queryUsingInstalledAgentSdk({
    prompt: input.userMessage,
    tools: [governedTool],
    hooks: { preTool: preToolHook }
  });

  // Validate only a result not already covered by a lower model wrapper.
  await governance.afterModel(extractFinalText(result), mapModelContext(result));
  await governance.finish();
  return result;
}
```

If the installed SDK does not expose every provider request and intermediate
response, place `beforeModel` and `afterModel` in an application-owned provider
client or gateway. A final result check cannot retroactively stop a tool choice
made from an unchecked intermediate response.

Verify whether user or repository configuration can add tools, hooks, MCP
servers, or instructions. Restrict those sources through the installed SDK's
supported configuration when the solution requires a closed tool set.

When converting `GovernanceDeniedError` to a permission response, use the
installed hook contract. Unexpected errors must remain fail-closed; do not
convert every exception into an allow or ordinary tool result.
