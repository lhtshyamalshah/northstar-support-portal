# Phase 3: Integrate the File-Based SDK into the Backend

## Goal

Add the private Governance SDK to the backend as a local file dependency,
initialize it before the application accepts governed work, and enforce every
agent, model, tool, result, and handoff boundary.

The SDK is not published to a package registry. The backend still imports
`@zbrain/governance-sdk`, but its `package.json` resolves that name to a local
directory with a `file:` dependency.

This guide is self-contained. Its TypeScript blocks show the current SDK
surface and the ordering the consuming backend must implement. The Phase 4
framework files are pseudocode placement sketches rather than a second
runnable implementation.

Complete and register the
[solution manifest](01-solution-manifest.md) and
[solution policies](02-solution-policies.md) before this phase.

## 1. Add the SDK as a file-based package

### Recommended repository layout

Place the SDK checkout inside the backend or at a stable sibling path:

```text
backend/
  package.json
  package-lock.json
  package/
    zbrain-governance-sdk/   # source-controlled folder or pinned submodule
      package.json
      src/
      dist/                  # build output the entrypoints resolve to
  governance/
    solution-manifest.json   # loaded at runtime via manifestPath
  src/
```

The SDK directory must be available in development, CI, container builds, and
production builds. Pin the checkout or submodule revision so the dependency is
reproducible.

### Backend dependency

Reference the directory relative to the backend's `package.json`:

```json
{
  "dependencies": {
    "@zbrain/governance-sdk": "file:package/zbrain-governance-sdk"
  }
}
```

For a sibling checkout, use the corresponding path:

```json
{
  "dependencies": {
    "@zbrain/governance-sdk": "file:../zbrain-governance-sdk"
  }
}
```

Do not run:

```text
npm install @zbrain/governance-sdk
```

That command requests a registry package, which is not the distribution model.

### Build before the backend consumes it

The package entrypoints refer to generated files in `dist/`, and this package
defines no `prepare` script, so the SDK must be built before the backend
compiles or runs.

For a plain `file:` dependency, build it explicitly:

```bash
npm --prefix ./package/zbrain-governance-sdk ci
npm --prefix ./package/zbrain-governance-sdk run build
npm install
```

If the backend declares the SDK as an npm workspace instead, `npm install` at
the backend root installs and links it, and the build becomes one script. Do
not mix the two: `npm --prefix` treats the SDK as a standalone install and
bypasses the workspace link.

```json
{
  "workspaces": ["package/zbrain-governance-sdk"],
  "scripts": {
    "build:sdk": "npm run build --workspace=@zbrain/governance-sdk",
    "build": "npm run build:sdk && tsc",
    "test": "npm run build:sdk && vitest run"
  }
}
```

Either way, the SDK must be built before the backend's own build or test step —
wire it into those scripts rather than relying on it having been run by hand.

The SDK build emits ESM, CommonJS, and type declarations. The backend imports
only the package name:

```ts
import { initializeGovernanceSDK } from "@zbrain/governance-sdk";
```

Do not import:

```text
../package/zbrain-governance-sdk/src/...
../package/zbrain-governance-sdk/dist/...
```

The exported package surface is stable across the package boundary; source and
build-layout imports are not.

Commit the backend lockfile so the local dependency is reproducible.

## 2. Configure the runtime

Requirements:

```text
Node.js >= 22
npm >= 10
```

The SDK reads these variables:

| Environment variable              | Required | Purpose                                               |
| --------------------------------- | -------- | ----------------------------------------------------- |
| `ZBRAIN_GOVERNANCE_BASE_URL`      | yes      | Governance service base URL.                          |
| `ZBRAIN_GOVERNANCE_API_KEY`       | yes      | Bearer credential used by the SDK client.             |
| `ZBRAIN_GOVERNANCE_SOLUTION_ID`   | yes      | Stable solution identifier.                           |
| `ZBRAIN_GOVERNANCE_DEPLOYMENT_ID` | yes      | Runtime deployment identifier.                        |
| `CRON_TIME`                       | no       | Internal refresh schedule; defaults to `0 */6 * * *`. |

Example:

```dotenv
ZBRAIN_GOVERNANCE_BASE_URL=https://governance.example.com
ZBRAIN_GOVERNANCE_API_KEY=replace-with-secret
ZBRAIN_GOVERNANCE_SOLUTION_ID=customer-support
ZBRAIN_GOVERNANCE_DEPLOYMENT_ID=production-region-a
CRON_TIME=0 */6 * * *
```

An optional fetch-based helper also needs an application-owned environment
name:

```dotenv
ZBRAIN_GOVERNANCE_ENVIRONMENT=production
```

`ZBRAIN_GOVERNANCE_ENVIRONMENT` is not read by
`initializeGovernanceSDK`. It is used only when the backend calls
`fetchGovernanceBundle`, whose input contract requires `environment`.

Do not commit the API key or canary tokens.

## 3. Pass dummy callback placeholders

`GovernanceOptions.callbacks` currently requires two strings:

```ts
interface CallbackEndpoints {
  bundleUpdateUrl: string;
  killSwitchUrl: string;
}
```

These fields are registration placeholders in the current integration. The SDK
does not create routes, receive callbacks, authenticate callback requests, or
implement a kill switch.

Use explicit dummy URLs:

```ts
import type { CallbackEndpoints } from "@zbrain/governance-sdk";

export const PLACEHOLDER_CALLBACKS = {
  bundleUpdateUrl: "https://callbacks.invalid/governance/bundle-update",
  killSwitchUrl: "https://callbacks.invalid/governance/kill-switch"
} as const satisfies CallbackEndpoints;
```

The `.invalid` top-level domain makes the placeholder intent clear. Do not add
dummy router handlers, callback authentication, command parsing, shared
kill-switch state, or boundary checks for a kill switch that does not exist.

The placeholder `killSwitchUrl` provides no safety behavior. Do not describe
the backend as kill-switch protected.

If Governance later defines a real callback payload, authentication contract,
retry behavior, and reachability requirement, implement those as a separate
feature and replace the placeholders.

## 4. Initialize before accepting governed work

Initialization belongs in exactly one module. If the backend already provides a
governance runtime module, extend it rather than adding a second one: two
`initializeGovernanceSDK` call sites mean one of them ends up holding a stale
`policyEngine`, and the second call is not cleaned up (see
[Startup behavior](05-sdk-quick-reference.md#startup-behavior)).

That module resolves the manifest and supplies the placeholder callbacks, plus
canary tokens when an enabled rule selects `canaryLeak`:

```ts
import { fileURLToPath } from "node:url";

import {
  initializeGovernanceSDK,
  type ActiveGovernanceHandle,
  type CallbackEndpoints
} from "@zbrain/governance-sdk";

const PLACEHOLDER_CALLBACKS = {
  bundleUpdateUrl: "https://callbacks.invalid/governance/bundle-update",
  killSwitchUrl: "https://callbacks.invalid/governance/kill-switch"
} as const satisfies CallbackEndpoints;

export async function initializeGovernanceRuntime(): Promise<ActiveGovernanceHandle> {
  return await initializeGovernanceSDK({
    manifestPath: fileURLToPath(
      new URL("../../governance/solution-manifest.json", import.meta.url)
    ),
    callbacks: PLACEHOLDER_CALLBACKS
  });
}
```

Resolve `manifestPath` from a stable base. The example resolves it relative to
the module; `process.cwd()` also works, but only when the process is always
started from the backend root.

Call it before starting the listener or worker:

```ts
import { initializeGovernanceRuntime } from "./governance/runtime.js";

await initializeGovernanceRuntime();
await startHttpServer();
```

If the framework must create a server object first, keep readiness false until
initialization completes:

```ts
const server = await createHttpServer({ ready: false });

await initializeGovernanceRuntime();

server.setReady(true);
await server.listen();
```

Initialization:

1. validates required environment variables;
2. reads and hashes the local manifest;
3. creates an authenticated Governance client;
4. registers the runtime with the manifest, hash, and placeholder callbacks;
5. receives and validates the initial policy bundle;
6. constructs a manifest-backed policy engine;
7. stores the active handle process-wide; and
8. starts the scheduled refresh task.

Startup is fail-closed. Missing configuration, an unreadable manifest,
registration failure, invalid bundle, invalid custom-handler configuration, or
an unconstructable prompt-injection detector calls `process.exit(1)`.

Do not catch startup failure and continue without Governance.

### Custom handlers and canaries

Register custom policy handlers during initialization by exact policy name:

```ts
await initializeGovernanceSDK({
  manifestPath,
  callbacks: PLACEHOLDER_CALLBACKS,
  customPolicyHandlers: {
    "solution-deny-high-value-transfer": highValueTransferHandler
  }
});
```

Only configure canaries when an enabled validation rule selects `canaryLeak`:

```ts
const canary = process.env.GOVERNANCE_CANARY_TOKEN;
if (!canary) {
  throw new Error("GOVERNANCE_CANARY_TOKEN is required");
}

await initializeGovernanceSDK({
  manifestPath,
  callbacks: PLACEHOLDER_CALLBACKS,
  promptInjection: {
    canaryTokens: [canary]
  }
});
```

Canaries are trusted local secrets. Never put them in the manifest, policy
document, callback placeholder, or logs.

## 5. Distinguish bundle fetching from active refresh

The current public API exposes two different operations.

### `fetchGovernanceBundle`: fetch only

`fetchGovernanceBundle` performs an authenticated GET using:

```ts
interface FetchGovernanceBundleInput {
  solutionId: string;
  environment: string;
  currentHash?: string;
}
```

It returns a `GovernanceBundle`, but does not validate it and does not install
it into the active `GovernancePolicyEngine`.

A backend refresh helper can fetch and validate:

```ts
import {
  fetchGovernanceBundle,
  getGovernance,
  validateGovernanceBundle,
  type GovernanceBundle
} from "@zbrain/governance-sdk";

export async function fetchBundleForRefresh(): Promise<GovernanceBundle> {
  const governance = getGovernance();
  const bundle = await fetchGovernanceBundle(governance.client, {
    solutionId: requiredEnvironment("ZBRAIN_GOVERNANCE_SOLUTION_ID"),
    environment: requiredEnvironment("ZBRAIN_GOVERNANCE_ENVIRONMENT"),
    currentHash: governance.bundle.hash
  });

  await validateGovernanceBundle(bundle, governance.customPolicyHandlers);
  return bundle;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}
```

This is suitable for a future callback or application-owned refresh workflow,
but the returned bundle is still fetch-only.

Do not assign `governance.bundle = bundle`. That would change the diagnostic
field without rebuilding `policyEngine`; enforcement would continue using the
old rules.

Do not construct a raw `PolicyEvaluator` as a replacement. That would bypass
the initialized engine's manifest authorization and discard its usage state.

The current SDK needs a new public, validated, atomic activation operation
before an arbitrary fetched bundle can safely become active.

### `ActiveGovernanceHandle.refreshBundle`: fetch and activate by re-registration

The initialized handle also exposes:

```ts
await getGovernance().refreshBundle();
```

Despite its name, the current implementation does not call
`fetchGovernanceBundle`. It re-registers the runtime, validates the bundle in
the registration response, constructs the next engine, and only then swaps the
active `bundle` and `policyEngine`.

If validation or engine construction fails, the previous bundle and engine
remain active. The SDK's cron task calls this method with overlap prevention
and logs failures.

This distinction is a current implementation boundary:

| Operation                         | Retrieves bundle                     | Validates bundle | Activates engine |
| --------------------------------- | ------------------------------------ | ---------------- | ---------------- |
| `fetchGovernanceBundle(...)`      | yes                                  | no               | no               |
| Fetch helper above                | yes                                  | yes              | no               |
| `getGovernance().refreshBundle()` | yes, through runtime re-registration | yes              | yes              |

The placeholder callback URLs are not wired to either operation.

## 6. Read the active engine at every boundary

Initialization stores one process-wide `ActiveGovernanceHandle`.

Use:

```ts
import { getGovernance } from "@zbrain/governance-sdk";

const engine = getGovernance().policyEngine;
```

Read `getGovernance().policyEngine` at each boundary rather than caching it for
the life of the process. A successful active refresh replaces the engine on
the handle. A previously cached engine continues evaluating its old bundle.

Use `maybeGetGovernance()` only when probing initialization state. It returns
`undefined` before startup. `getGovernance()` throws before initialization.

Use `clearGovernance()` only in tests or controlled shutdown; it destroys the
scheduled task and clears the global handle.

## 7. Use one session identity for the complete run

Usage counters are scoped to the application `sessionId`. Create one stable ID
for the complete request, agent run, workflow, or conversation:

```ts
import { randomUUID } from "node:crypto";

const sessionId =
  typeof request.headers["x-session-id"] === "string"
    ? request.headers["x-session-id"]
    : randomUUID();
```

Validate any caller-provided session ID according to the backend's trust
model. Do not use a new ID for each model or tool request, or usage policies
will see fragmented counters.

Keep the current agent DID in trusted backend configuration or a typed constant
derived from the registered manifest. The `GovernanceBoundaries` name used in
Phase 4 is conceptual shorthand for grouping the direct SDK calls shown below;
it is not an SDK export or a provided TypeScript implementation.

The DID must be the exact `agentDid` from the registered and packaged
manifest. Do not pass an agent name, key, framework label, or untrusted request
value.

## 8. Place checks next to dispatch

The boundary must be adjacent to the operation it controls:

```text
build trusted policy input
        |
        v
evaluate / requireAllowed
        |
        +---- denied ----> stop or controlled reroute
        |
        v
record usage when applicable
        |
        v
dispatch the real operation
```

Do not rely on one check at the HTTP route when the governed side effect occurs
later in a framework, queue worker, provider adapter, or tool executor.

Use `requireAllowed` for the common throw-on-denial pattern:

```ts
const decision = await requireAllowed(engine, sessionId, {
  checkpoint: "tool_call",
  agent: { agentDid },
  tool: { toolDid, arguments: toolArguments }
});
```

`requireAllowed` returns permitted `allow`, `audit`, and `warn` decisions. It
throws `GovernanceDeniedError` for `deny`.

## 9. Gate the agent lifecycle

Start:

```ts
const engine = getGovernance().policyEngine;
await requireAllowed(engine, sessionId, {
  checkpoint: "agent_start",
  agent: { agentDid, userMessage }
});
engine.recordTurn(sessionId);
```

Finish:

```ts
await requireAllowed(getGovernance().policyEngine, sessionId, {
  checkpoint: "agent_end",
  agent: { agentDid },
  // Outcome of the completed operation: "completed" or "failed" only.
  // Explain a failure with `statusReason`, not with a custom status. Omitting
  // these records the boundary as "unknown" rather than losing the event.
  status: "completed",
  duration: agentDurationMs
});
```

Every checkpoint requires a calling agent registered in the manifest.

At `agent_start`, `agent.userMessage` is automatically routed as governed
`user_message` text for prompt-injection validation. Explicit
`governedTexts` supplied at that checkpoint is ignored by the context builder.

## 10. Gate model calls and outputs

Before provider dispatch:

```ts
const engine = getGovernance().policyEngine;
await requireAllowed(engine, sessionId, {
  checkpoint: "model_call",
  agent: { agentDid },
  model: {
    provider: "provider-name",
    name: modelName,
    inputTokens: estimatedInputTokens
  },
  governedTexts: [
    { source: "user_message", content: userMessage },
    { source: "retrieved_content", content: retrievedContext }
  ]
});

engine.recordModelCall(sessionId, agentDid);
const response = await provider.generate(providerRequest);
```

Model facts are host-supplied. The SDK does not calculate or verify provider,
model name, token counts, or cost.

After provider dispatch and before releasing or internally consuming output:

```ts
await requireAllowed(getGovernance().policyEngine, sessionId, {
  checkpoint: "model_result",
  agent: { agentDid },
  model: {
    provider: "provider-name",
    name: modelName,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
    totalTokens: response.usage.totalTokens
  },
  // Outcome; see the `agent_end` example above.
  status: "completed",
  duration: modelDurationMs,
  governedTexts: [{ source: "model_output", content: response.text }]
});

return response.text;
```

Current validation inspects `model_output` only for selected `canaryLeak`.
Other prompt-injection checks do not run at `model_result`.

An output denial cannot undo provider execution. For streaming, buffer content
until required output validation completes; otherwise denied content may
already have reached the caller or another agent.

## 11. Gate tool calls and results

Before the real side effect:

```ts
const input = {
  toolDid: lookupCustomerToolDid,
  arguments: { customerId }
};

const engine = getGovernance().policyEngine;
await requireAllowed(engine, sessionId, {
  checkpoint: "tool_call",
  agent: { agentDid },
  tool: input
});

engine.recordToolCall(sessionId, input.toolDid, agentDid);
const customer = await crm.lookupCustomer(customerId);
```

The manifest-backed engine first requires:

- the calling agent DID to exist;
- the tool DID to exist; and
- the tool DID to appear in that agent's manifest `tools` list.

Policy matching occurs only after those checks pass. `tool_call` defaults to
deny, so a permitting policy must also match.

Validate untrusted output before a model, another agent, a caller, or an
untrusted sink consumes it:

```ts
await requireAllowed(getGovernance().policyEngine, sessionId, {
  checkpoint: "tool_result",
  agent: { agentDid },
  tool: input,
  // Outcome; see the `agent_end` example above.
  status: "completed",
  duration: toolDurationMs,
  governedTexts: [
    {
      source: "retrieved_content",
      content: JSON.stringify(customer)
    }
  ]
});

return customer;
```

Use `tool_result` for a tool's returned text and `retrieved_content` for search,
RAG, document, or data-retrieval content.

If result serialization fails, stop rather than skipping validation. If
`tool_result` evaluation denies, do not pass the result to a model or caller.

The hard manifest tool gate runs at `tool_call`, not `tool_result`. Preserve
the original registered tool DID in the result boundary and enforce provenance
in the backend.

## 12. Gate handoffs before state transfer

```ts
await requireAllowed(getGovernance().policyEngine, sessionId, {
  checkpoint: "handoff",
  agent: { agentDid },
  handoff: { targetAgentDid }
});

await runTargetAgent(targetAgentDid, workflowState);
```

Evaluate before copying workflow state, prompts, credentials, tool results, or
memory to the target.

The target must exist in the manifest and a permitting handoff policy must
match because `handoff` defaults to deny. The current manifest has no
agent-to-agent handoff allowlist.

## 13. Record usage at the correct moment

Usage snapshots are read before evaluation. The SDK does not automatically
record events.

For tool and model calls:

1. evaluate;
2. stop on denial;
3. record immediately before dispatch; and
4. dispatch.

For a rule using:

```json
{
  "usage.perToolCallCount": {
    "gte": 5
  }
}
```

five previously recorded calls cause the next evaluation to match.

The initialized tracker is in-memory and process-local. It is lost on restart,
not shared across replicas, and evaluation plus recording is not atomic.
Parallel requests can observe the same count. Treat usage policies as local
signals rather than distributed hard quotas.

## 14. Preserve governed-text provenance

Use only the accepted source labels:

| Source              | Meaning                                          |
| ------------------- | ------------------------------------------------ |
| `user_message`      | Direct user input.                               |
| `retrieved_content` | RAG, search, or retrieved document/data content. |
| `tool_result`       | Untrusted output returned by a tool.             |
| `model_output`      | Actual model-generated output.                   |

Checkpoint contracts are:

| Checkpoint     | Accepted validation input                                 |
| -------------- | --------------------------------------------------------- |
| `agent_start`  | `agent.userMessage`; explicit `governedTexts` is ignored. |
| `model_call`   | `user_message`, `tool_result`, `retrieved_content`.       |
| `tool_result`  | `tool_result`, `retrieved_content`.                       |
| `model_result` | `model_output`, with only `canaryLeak` routed.            |

Do not label trusted system/developer instructions as untrusted input. Do not
relabel a tool result as a user message to bypass the checkpoint contract.
Invalid source/checkpoint combinations fail closed when an applicable
validation rule is active.

## 15. Handle decisions and denials

```ts
import { GovernanceDeniedError } from "@zbrain/governance-sdk";

try {
  return await runApplicationWorkflow();
} catch (error) {
  if (error instanceof GovernanceDeniedError) {
    await persistGovernanceDecision(error.decision);
    return controlledDenial(error.decision.reason);
  }
  throw error;
}
```

The error retains the full `PolicyDecision`.

### Decision reporting is the SDK's job

`GovernancePolicyEngine.evaluate` reports each decision to the governance
microservice before it returns:

| Condition                            | Endpoint                     | Payload                                              |
| ------------------------------------ | ---------------------------- | ---------------------------------------------------- |
| Supported checkpoint with an outcome | `POST v1/api/audit-logs`     | Checkpoint-shaped event, attributed to the agent     |
| A rule won with a non-`allow` action | `POST v1/api/violation-logs` | Matched rule, level, and resolution diagnostics |

Both calls are best-effort: a transport failure is logged and swallowed, so
telemetry can never turn an enforced decision into an error or relax a denial.

### What is deliberately not reported

The separate violation-log endpoint only records matched rules. These outcomes
produce no separate violation record:

| Not reported                                     | Why                                                |
| ------------------------------------------------ | -------------------------------------------------- |
| Checkpoint-default deny (`tool_call`, `handoff`) | No rule won, so there is no matched rule to report |
| Manifest-authorization denial                    | The denial precedes rule matching, so no rule won  |
| Fail-closed evaluation error                     | Same: no rule won                                  |

These outcomes are included in supported audit events with `policyViolation:
true` and `violationDetails`. The details contain `action`, `reason`,
`matchedRules`, `conflictDetected`, and `resolutionTrace`, plus winning-rule
fields (`matchedRule`, `matchedRuleId`, `matchedRuleLevel`) and safe `auditData`
when available. `warn` and `audit` outcomes also include these details. Allow
events omit them. Unexpected exception messages are replaced with a generic
failure reason in audit telemetry; the returned decision is unchanged.
After-boundary events still require a valid host-supplied status and duration.

The violation payload carries rule identifiers, `matchedRules` (every candidate
in resolution order), and `resolutionTrace` (deterministic diagnostic steps).
It excludes `arguments` and `auditData`. Evaluator metadata, when available,
is carried by the audit event's `metadata` and `violationDetails.auditData`.

**Do not build a second audit store that mirrors these events.** Duplicating
them costs storage and creates a copy of governed data outside the governance
service's retention rules.

### What the backend still owns

- stop when `allowed` is false;
- implement the operational behavior of winning `audit` and `warn` actions —
  the SDK records the decision but never acts on it;
- return a controlled denial rather than provider or tool internals; and
- alert on repeated fail-closed evaluation or refresh failures.

If the application keeps its own decision log for operational reasons, log only
the safe `PolicyDecision` fields. Never add raw prompts, tool arguments, tool
results, retrieved content, API keys, manifest metadata secrets, or canary
tokens to that record.

Custom-handler error messages can become deny reasons. Keep them caller-safe.

## 16. Test the integration at real dispatch seams

Test:

- the backend resolves the `file:` dependency without registry access;
- the SDK `dist/` build exists before backend compilation;
- both ESM and CommonJS package entrypoints load when the backend supports
  both;
- readiness stays false until initialization succeeds;
- placeholder callbacks are submitted without creating fake callback
  behavior;
- startup exits on missing environment, unreadable manifest, registration
  failure, or invalid bundle;
- each model, tool, handoff, and output side effect is not invoked after
  denial;
- usage is recorded once and only after permission;
- every framework path reads the current active engine;
- fetch-based refresh sends `solutionId`, `environment`, and `currentHash`;
- fetched invalid bundles are rejected by explicit validation;
- fetch-only refresh does not claim to activate a bundle;
- active `refreshBundle()` keeps the prior engine on failure;
- prompt-validation source routing is correct; and
- audit/deny responses contain no governed content or secrets.

Relevant implementation tests are:

- [runtime initialization and active refresh](../../test/core/index.test.ts);
- [runtime registration payload](../../test/core/client.test.ts);
- [fetching governance bundles](../../test/bundle/governance-bundle.test.ts);
- [manifest authorization](../../test/core/manifest-authorization.test.ts);
- [`requireAllowed` behavior](../../test/core/enforcement.test.ts);
- [context and usage tracking](../../test/policy-engine/context.test.ts).

## 17. Current non-features and boundaries

Do not assume this integration currently provides:

- a registry-published SDK package;
- automatic building of the local file dependency;
- implemented callback routes;
- callback authentication or payload parsing;
- kill-switch state or enforcement;
- atomic activation of a bundle returned by `fetchGovernanceBundle`;
- fetch-based behavior inside `ActiveGovernanceHandle.refreshBundle`;
- automatic manifest hot reload;
- automatic handling or presentation of a winning `audit` or `warn` action
  (decisions are reported to the governance service, but acting on them is the
  application's job);
- automatic tool/model/turn recording;
- distributed or atomic usage limits;
- automatic streaming-output buffering;
- runtime validation of arbitrary extra properties in host policy input; or
- automatic interception of framework operations.

These are backend, deployment, framework-adapter, or future SDK
responsibilities.

## Integration rules for coding agents

- Add the SDK with a pinned `file:` dependency; never request it from a
  registry.
- Build the SDK before compiling or starting the backend.
- Import only from `@zbrain/governance-sdk`.
- Initialize once during process bootstrap.
- Use dummy callback URLs without inventing kill-switch behavior.
- Never construct `PolicyEvaluator` in ordinary backend code.
- Read the active engine at each dispatch boundary.
- Construct policy input explicitly; never spread an untrusted request body
  into agent, tool, model, or handoff context.
- Pass exact manifest DIDs, not names or keys.
- Put each policy check directly before the action it controls.
- Record usage only after permission and immediately before dispatch.
- Govern every parallel operation independently before starting it.
- Preserve governed-text provenance.
- Treat `fetchGovernanceBundle` as fetch-only until the SDK exposes safe
  activation.
- Stop or safely reroute every denial.

## Completion checklist

- [ ] The backend uses a pinned local `file:` dependency.
- [ ] The SDK is built before backend install/build.
- [ ] Consumer imports use only `@zbrain/governance-sdk`.
- [ ] The registered manifest is available at `manifestPath`.
- [ ] Required Governance environment variables are present.
- [ ] Initialization completes before readiness or work consumption.
- [ ] Callback values are explicit placeholders.
- [ ] No kill-switch implementation or claim exists.
- [ ] One stable session ID crosses the complete run.
- [ ] Every provider request has a `model_call` boundary.
- [ ] Every model output requiring canary validation has a `model_result`
      boundary before release.
- [ ] Every tool side effect has a `tool_call` boundary.
- [ ] Every untrusted tool/retrieval result is checked before consumption.
- [ ] Every handoff is checked before state transfer.
- [ ] Usage is recorded after permission and immediately before dispatch.
- [ ] Every boundary reads the active engine.
- [ ] Fetch-only bundle retrieval is not mistaken for activation.
- [ ] Denials stop or safely reroute the workflow.
- [ ] Safe decisions are persisted without sensitive inputs.
