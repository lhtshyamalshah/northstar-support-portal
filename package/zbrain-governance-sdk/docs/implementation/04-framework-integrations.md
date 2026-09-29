# Phase 4: Map Framework Lifecycles to Governance Boundaries

## Goal

Build a thin, application-owned adapter between the backend's installed agent
framework and the framework-neutral governance boundaries created in phase 3.
The adapter and its framework dependencies belong to the consuming backend,
not to the private governance package.

The framework examples in this repository are **implementation sketches, not
copy-ready adapters**. Framework packages change their imports, hook names,
callback arguments, return contracts, retry behavior, and streaming behavior
between versions. Copy the governance ordering and security properties, then
implement them against the exact framework version installed by the backend.

Complete the [manifest](01-solution-manifest.md),
[policies](02-solution-policies.md), and
[backend integration](03-backend-integration.md) phases first. A framework
adapter cannot compensate for an undeclared agent, an undeclared tool, a
missing permit rule, or an uninitialized governance runtime.

## 1. Separate the stable contract from version-sensitive APIs

| Stable integration contract                                       | Version-sensitive in the host framework                              |
| ----------------------------------------------------------------- | -------------------------------------------------------------------- |
| Manifest DIDs identify agents and tools                           | Agent, tool, graph, runner, and provider types                       |
| An application helper maps work to SDK checkpoints                | Hook names and callback registration                                 |
| A denied pre-action check must prevent dispatch                   | Whether denial is a thrown error, return value, or permission object |
| Tool and handoff checkpoints require an explicit permit           | Where tools and handoffs can be intercepted                          |
| Governed text keeps its source provenance                         | Request, response, message, event, and stream payload shapes         |
| Usage is recorded after allow and immediately before dispatch     | Retry, parallelism, sub-agent, and middleware execution semantics    |
| Tool/model results are checked before they are reused or released | Whether intermediate and streamed outputs are observable             |
| Each boundary reads the currently active policy engine            | Framework lifecycle and shutdown behavior                            |

Do not present a framework adapter as complete until the installed version has
been checked and its boundary tests pass.

## 2. Required lifecycle mapping

Map every real operation to the closest available boundary:

| Application event         | Checkpoint     | Conceptual helper               | Required placement                                                               |
| ------------------------- | -------------- | ------------------------------- | -------------------------------------------------------------------------------- |
| Governed run begins       | `agent_start`  | `start(userMessage)`            | Before the framework receives the user request                                   |
| Provider request          | `model_call`   | `beforeModel(...)`              | Immediately before each actual provider dispatch                                 |
| Provider response         | `model_result` | `afterModel(...)`               | Before framework routing, persistence, return, or streaming                      |
| Tool invocation           | `tool_call`    | `beforeTool(...)`               | After resolving the tool name to a manifest DID and immediately before execution |
| Tool or retrieval result  | `tool_result`  | `afterTool(...)`                | Before the result enters another prompt, route, store, or application response   |
| Transfer to another agent | `handoff`      | `beforeHandoff(targetAgentDid)` | Before any state, message, or control is transferred                             |
| Governed run completes    | `agent_end`    | `finish()`                      | Before reporting successful completion                                           |

The helper names in this table and in the framework sketches belong to a
conceptual application-defined `GovernanceBoundaries` wrapper. The SDK does
not export that class, and this repository does not provide an implementation
file for it. A backend may create a thin wrapper or call `requireAllowed`
directly using the Phase 3 ordering.

Use one stable application session ID for the complete run. Use the manifest
agent DID for the active agent and an exact manifest tool DID for every tool.
Framework display names are not governance identities.

The conceptual wrapper must use `requireAllowed`, which throws
`GovernanceDeniedError` when a decision is not allowed. Translate that error
into the framework's supported stop mechanism without weakening it. An unknown
tool name, missing DID mapping, or unsupported route must fail closed.

## 3. Audit the installed framework before implementing

For the exact dependency version in the backend:

1. Pin the framework and provider package versions.
2. Read the installed TypeScript declarations and the matching official
   documentation.
3. Locate the real interception point for each lifecycle row above.
4. Confirm whether a callback runs before or after dispatch.
5. Confirm how a callback blocks work: throw, structured denial, alternate
   response, or another documented mechanism.
6. Check whether hooks apply to retries, parallel calls, nested agents,
   subgraphs, handoffs, built-in tools, remote tools, and provider calls made
   inside the framework.
7. Check whether intermediate and streamed model output can be withheld before
   another component consumes it.
8. Implement the smallest adapter that supplies SDK context without spreading
   an untrusted framework object into policy input.
9. Compile against the pinned version and run denial-path tests.
10. Repeat this audit whenever a framework or provider dependency changes.

If a required event is not exposed, enforce it at a lower layer that the
operation cannot bypass, such as a custom provider client, model wrapper,
governed tool registry, MCP server, or workflow node. Document any boundary
that remains unenforced.

## 4. Framework-neutral shape

This is pseudocode. `GovernanceBoundaries` represents an application-defined
wrapper, and the `framework.*` methods deliberately do not represent a real
package API:

```ts
const governance = new GovernanceBoundaries(sessionId, agentDid);

await governance.start(userMessage);

framework.beforeEachModelDispatch(async (request) => {
  await governance.beforeModel({
    model: mapModelContext(request),
    governedTexts: mapModelInputWithProvenance(request)
  });
});

framework.afterEachModelResponse(async (response) => {
  await governance.afterModel(extractGovernedText(response), mapModelContext(response));
});

framework.wrapEachTool(async (frameworkToolName, args, dispatch) => {
  const toolDid = requireManifestToolDid(frameworkToolName);
  const boundary = { toolDid, arguments: selectPolicyArguments(args) };

  await governance.beforeTool(boundary);
  const result = await dispatch();
  await governance.afterTool(boundary, result, classifyResultSource(result));
  return result;
});

framework.beforeEachHandoff(async (targetFrameworkAgent) => {
  await governance.beforeHandoff(requireManifestAgentDid(targetFrameworkAgent));
});

const result = await framework.run();
await governance.finish();
return result;
```

The important property is adjacency: no provider, tool, or handoff dispatch can
occur between its governance check and the operation it controls.

## 5. Direct LLM calls

When application code invokes the provider client directly, it normally owns
both sides of the most important boundary:

```text
agent_start
  -> model_call check
  -> provider dispatch
  -> model_result check
  -> release result
  -> agent_end
```

Adapt the [direct LLM sketch](../../examples/quick-integrations/llm-call.md) to
the installed provider SDK. Build `ModelContext` from fields the installed
client actually exposes. Do not guess token or cost values.

For streaming, either buffer the governed output until `model_result` passes or
use a separately designed incremental control. If tokens have already been
sent to the caller, a later denial cannot retract them.

## 6. OpenAI Agents

Use the [OpenAI Agents sketch](../../examples/quick-integrations/openai-agents.md)
to identify these seams:

- run entry for `agent_start`;
- the closest pre-provider interception point for `model_call`;
- a model/provider wrapper when the agent hook cannot observe every internal
  request and response;
- a wrapper inside every application tool for `tool_call` and `tool_result`;
- a pre-handoff hook or governed handoff wrapper;
- intermediate model-result interception before tool routing; and
- final-result interception before returning to the application.

An input filter is not automatically a model-result guard. A check performed
only after the complete agent run cannot stop an earlier model-generated tool
choice. Verify the installed version's actual coverage instead of relying on a
hook name shown in an example.

## 7. LangGraph

Use the [LangGraph sketch](../../examples/quick-integrations/langgraph.md) as a
graph-placement guide:

- wrap explicit model nodes with `model_call` and `model_result`;
- run `model_result` before a conditional edge interprets tool calls;
- wrap tool nodes with `tool_call` and `tool_result`;
- gate handoff edges before the target node receives state; and
- carry one application session ID through graph state or run configuration.

Prebuilt nodes, nested graphs, retries, and parallel branches can hide or
repeat dispatches. Verify their behavior in the installed version. Every
actual retry or parallel operation needs its own immediately adjacent check;
the same dispatch must not be counted twice by overlapping wrappers.

## 8. Claude Agent SDK

Use the [Claude Agent SDK sketch](../../examples/quick-integrations/claude-agent-sdk.md)
to map:

- run entry to `agent_start`;
- a pre-tool permission seam to `tool_call`;
- an application-owned tool or MCP wrapper to `tool_result`;
- provider/gateway interception to `model_call` and intermediate
  `model_result` when the agent runtime does not expose them; and
- the final successful result to `model_result` before application release.

Verify the installed SDK's hook events, permission response shape, MCP tool
contract, result events, and configuration inheritance. A tool hook does not
prove that internal provider calls are governed. If per-call model quotas or
intermediate-output policies are required, the provider layer must supply
those boundaries.

## 9. Google ADK

Use the [Google ADK sketch](../../examples/quick-integrations/google-adk.md)
to look for before/after model and tool callbacks in the installed version.
Verify their names, arguments, return semantics, error propagation, and whether
they cover nested agents and retries.

The after-model boundary must run before a model-generated tool request is
routed. The before-tool boundary must run after the framework tool has been
mapped to its manifest DID and before its implementation starts. Preserve the
backend's stable session ID even if the runner also has application, user, or
framework-specific session identifiers.

## 10. Results, side effects, and denial handling

A pre-action denial must prevent the action:

- denied `model_call`: do not invoke the provider;
- denied `tool_call`: do not execute the tool;
- denied `handoff`: do not transfer control or state.

A result denial controls onward use, not the action that already happened:

- denied `model_result`: do not route, persist, return, or stream the model
  output;
- denied `tool_result`: do not place the result in a prompt, route, store, or
  response.

Do not retry a governance denial as though it were a transient provider error.
If a framework requires a structured deny response, convert only
`GovernanceDeniedError`; allow unexpected SDK or adapter failures to propagate
to the backend's fail-closed error path.

`allow`, `audit`, and `warn` decisions all permit execution. The adapter must
still send safe decision data to the backend's audit or warning mechanism when
the application requires it. Do not log governed text, complete tool
arguments, credentials, or provider payloads as ordinary diagnostic data.

## 11. Usage and concurrency

The Phase 3 ordering records:

- one turn after an allowed `agent_start`;
- one model call after an allowed `model_call`; and
- one tool call after an allowed `tool_call`.

These are in-memory counters in the current runtime. They are not token, cost,
distributed, durable, or atomic cross-process accounting. Model token and cost
fields passed in `ModelContext` are policy facts for that evaluation; they do
not extend the usage counter automatically.

Place the adapter so each actual dispatch is checked and recorded exactly once.
For parallel work, govern every branch before starting it. For framework-owned
retries, confirm whether the hook runs per attempt. If it does not, move the
boundary into a provider or tool wrapper that sees each attempt.

## 12. Required adapter tests

Use fake providers, tools, handoff targets, and framework events. At minimum,
prove:

1. An allowed provider request dispatches once.
2. A denied provider request never dispatches.
3. A denied model result is not routed or returned.
4. An allowed tool dispatches once.
5. A denied tool never dispatches.
6. A denied tool result is not supplied to the next model or caller.
7. Unknown framework agent and tool names fail closed before dispatch.
8. A denied handoff transfers no state.
9. Usage is recorded once for each allowed dispatch and never for a denial.
10. Retries and parallel branches receive separate checks without duplicate
    counting.
11. Nested agents, subgraphs, built-in tools, and remote tools cannot bypass
    the intended boundary.
12. One stable session ID is used for the complete run.
13. The next boundary uses the active engine after a bundle refresh.
14. A hook or adapter failure follows the backend's fail-closed path.
15. Streamed content is not released before the applicable output control.

Re-run these tests after every framework or provider upgrade.

## 13. Current non-features

The current SDK does not provide:

- supported, version-pinned adapters for these frameworks;
- automatic framework or provider interception;
- automatic discovery of hidden model, tool, retry, sub-agent, or handoff
  operations;
- automatic mapping from framework names to manifest DIDs;
- automatic streaming-output buffering;
- distributed or durable usage counting;
- compensation or rollback for a tool side effect after `tool_result` denial;
- callback handling or kill-switch enforcement; or
- a guarantee that an illustrative framework hook exists in the installed
  version.

The files under
[`examples/quick-integrations`](../../examples/quick-integrations/README.md)
show boundary placement only. They are intentionally not compiled against
framework dependencies and are not compatibility claims.

## Completion checklist

- [ ] The framework and provider versions are pinned.
- [ ] Installed types and matching documentation were checked.
- [ ] Every runtime agent and tool maps to an exact manifest DID.
- [ ] Every real provider dispatch has an adjacent `model_call` check.
- [ ] Model output is checked before framework routing or application release.
- [ ] Every tool has adjacent `tool_call` and `tool_result` boundaries.
- [ ] Every handoff is checked before state transfer.
- [ ] Retries, parallel branches, nested agents, and built-ins were audited.
- [ ] One stable application session ID crosses the complete run.
- [ ] Denials and adapter failures stop or safely reroute the workflow.
- [ ] Usage is recorded exactly once after permission.
- [ ] Streaming does not release content before its required check.
- [ ] Boundary tests pass against the pinned framework versions.
- [ ] Unsupported or unenforced boundaries are documented explicitly.
