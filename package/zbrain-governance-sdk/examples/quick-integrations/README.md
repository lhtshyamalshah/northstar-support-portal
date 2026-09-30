# Framework Integration Sketches

These files show where governance belongs in common agent and LLM lifecycles.
They are **not copy-ready framework adapters**.

Framework APIs change between versions. The sketches use symbolic names and
incomplete pseudocode on purpose. Implement the same governance ordering
against the exact package versions installed in the backend, then compile and
test that adapter locally.

## Illustrative framework mappings

| Integration       | Sketch                                       | Boundary idea                                                  |
| ----------------- | -------------------------------------------- | -------------------------------------------------------------- |
| Direct LLM call   | [`llm-call.md`](llm-call.md)                 | Wrap the application-owned provider request and response       |
| OpenAI Agents SDK | [`openai-agents.md`](openai-agents.md)       | Combine run, provider, tool, result, and handoff interception  |
| LangGraph         | [`langgraph.md`](langgraph.md)               | Place checks inside explicit model/tool nodes and before edges |
| Claude Agent SDK  | [`claude-agent-sdk.md`](claude-agent-sdk.md) | Combine tool hooks with application or provider-layer wrappers |
| Google ADK        | [`google-adk.md`](google-adk.md)             | Map available before/after callbacks to governance boundaries  |

Names such as `framework.beforeModel`, `provider.generate`, and
`denyAccordingToFrameworkContract` are placeholders. They do not claim that a
package exports those methods.

`GovernanceBoundaries`, `SUPPORT_AGENT_DID`, and `TOOL_DIDS` are also
conceptual application names. They refer to the boundary and manifest-identity
patterns explained in
[Phase 3](../../docs/implementation/03-backend-integration.md). This directory
does not provide implementations for those names.

This directory intentionally contains no manifest fixture, policy fixture,
runtime implementation, framework dependency, or executable framework test.

## Before adapting a sketch

1. Pin the framework and provider versions used by the backend.
2. Inspect the installed TypeScript declarations and matching official
   documentation.
3. Verify hook timing, denial behavior, retries, parallel calls, nested agents,
   built-in tools, handoffs, and streaming.
4. Map framework names to exact DIDs from the registered manifest.
5. Implement a thin adapter without spreading untrusted framework payloads
   into policy context.
6. Test both allow and denial paths with fake providers and tools.
7. Repeat the review whenever a dependency version changes.

The complete requirements and test matrix are in
[Phase 4: Map Framework Lifecycles to Governance Boundaries](../../docs/implementation/04-framework-integrations.md).

## Required ordering

```text
run input -> agent_start
provider dispatch -> model_call -> dispatch -> model_result -> route/release
tool dispatch -> tool_call -> side effect -> tool_result -> reuse/release
handoff -> handoff -> transfer state
successful completion -> agent_end
```

Copy this ordering, not the pseudocode syntax.

## Coverage warning

A framework hook governs only operations that actually pass through it. If the
installed version hides provider calls, retries, remote tools, nested agents,
or intermediate outputs, move the relevant check to an application-owned
provider, tool, MCP, or workflow layer. Never describe an unobservable
boundary as governed.
