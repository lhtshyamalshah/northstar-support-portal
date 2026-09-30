# Phase 5: SDK Quick Reference

## Purpose

Use this page as the implementation-time reference for the current
`@zbrain/governance-sdk` package. It describes the API exported from
[`src/index.ts`](../../src/index.ts), not planned platform behavior.

For design and authoring decisions, use the earlier phases:

1. [Solution manifest](01-solution-manifest.md)
2. [Solution policies](02-solution-policies.md)
3. [Backend integration](03-backend-integration.md)
4. [Framework lifecycle mapping](04-framework-integrations.md)

The normal backend path is intentionally small:

```text
initializeGovernanceSDK once
        |
        v
getGovernance().policyEngine at each boundary
        |
        v
requireAllowed
        |
        +---- denied ----> stop or controlled reroute
        |
        v
record allowed usage when applicable
        |
        v
dispatch
```

Most application code should not construct the exported low-level client,
context builder, evaluator, or usage tracker directly.

## 1. Package contract

| Property      | Current contract                                              |
| ------------- | ------------------------------------------------------------- |
| Package name  | `@zbrain/governance-sdk`                                      |
| Version       | `0.1.0`                                                       |
| Distribution  | Private local `file:` dependency; not published to a registry |
| Entry point   | Package root only                                             |
| Module output | ESM `dist/index.js` and CommonJS `dist/index.cjs`             |
| Types         | `dist/index.d.ts` and `dist/index.d.cts`                      |
| Runtime       | Node.js 22 or newer                                           |
| Package tool  | npm 10 or newer                                               |

Reference the checked-out SDK directory from the backend:

```json
{
  "dependencies": {
    "@zbrain/governance-sdk": "file:package/zbrain-governance-sdk"
  }
}
```

Build the SDK before the backend installs or compiles it. Import only from the
package root:

```ts
import { initializeGovernanceSDK } from "@zbrain/governance-sdk";
```

```js
const { initializeGovernanceSDK } = require("@zbrain/governance-sdk");
```

Do not import from `src/`, `dist/`, `test/`, or `examples/`. See
[Phase 3](03-backend-integration.md) for the complete file-package workflow.

## 2. Recommended application API

These are the main application-facing exports:

| Export                    | Use                                                                       |
| ------------------------- | ------------------------------------------------------------------------- |
| `initializeGovernanceSDK` | Load the manifest, register, validate the bundle, and start refresh       |
| `getGovernance`           | Require and return the active process-wide handle                         |
| `maybeGetGovernance`      | Probe whether initialization has completed                                |
| `requireAllowed`          | Evaluate one boundary and throw when it is denied                         |
| `GovernanceDeniedError`   | Recognize an expected policy denial and access its decision               |
| `GovernancePolicyEngine`  | Manifest-backed evaluation and usage recording                            |
| `ActiveGovernanceHandle`  | Type the initialized runtime handle                                       |
| `PolicyContextInput`      | Type a complete direct engine evaluation                                  |
| `PolicyBoundaryInput`     | Type `requireAllowed` input without the separately supplied `sessionId`   |
| `PolicyDecision`          | Inspect the deterministic result                                          |
| `clearGovernance`         | Destroy the current scheduler and clear global state in tests or shutdown |

There is no exported framework adapter. The framework names used in Phase 4
are pseudocode owned by the consuming backend.

## 3. Minimum governed operation

This example shows the required order around a tool. It assumes initialization
has already completed:

```ts
import { getGovernance, requireAllowed, type PolicyDecision } from "@zbrain/governance-sdk";

async function governedLookup(
  sessionId: string,
  agentDid: string,
  toolDid: string,
  customerId: string
) {
  const tool = {
    toolDid,
    arguments: { customerId }
  };

  // Read the active engine for this dispatch boundary.
  const callEngine = getGovernance().policyEngine;
  const callDecision = await requireAllowed(callEngine, sessionId, {
    checkpoint: "tool_call",
    agent: { agentDid },
    tool
  });

  recordSafeDecision(callDecision);
  callEngine.recordToolCall(sessionId, toolDid, agentDid);
  const result = await lookupCustomer(customerId);
  const serializedResult = typeof result === "string" ? result : JSON.stringify(result);
  if (serializedResult === undefined) {
    throw new Error("Tool result is not JSON-serializable");
  }

  // Re-read for the result boundary so a refresh can take effect.
  const resultDecision = await requireAllowed(getGovernance().policyEngine, sessionId, {
    checkpoint: "tool_result",
    agent: { agentDid },
    tool,
    governedTexts: [
      {
        source: "retrieved_content",
        content: serializedResult
      }
    ]
  });

  recordSafeDecision(resultDecision);
  return result;
}

declare function lookupCustomer(customerId: string): Promise<unknown>;
declare function recordSafeDecision(decision: PolicyDecision): void;
```

The pre-call denial prevents execution. A `tool_result` denial cannot undo the
lookup, but it must prevent the result from being routed, stored, returned, or
placed in another model prompt.

## 4. Initialization

### Signature

```ts
function initializeGovernanceSDK(options: GovernanceOptions): Promise<ActiveGovernanceHandle>;
```

### `GovernanceOptions`

```ts
interface GovernanceOptions {
  callbacks: CallbackEndpoints;
  manifestPath: string;
  customPolicyHandlers?: Readonly<Record<string, CustomPolicyHandler>>;
  promptInjection?: PromptInjectionRuntimeOptions;
}
```

| Field                          | Required | Current behavior                                                                            |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------- |
| `manifestPath`                 | yes      | Reads and parses the manifest JSON from an absolute or process-relative path                |
| `callbacks.bundleUpdateUrl`    | yes      | Submitted as a registration placeholder; no callback route or handler is implemented        |
| `callbacks.killSwitchUrl`      | yes      | Submitted as a registration placeholder; no kill-switch state or enforcement is implemented |
| `customPolicyHandlers`         | no       | Trusted local handlers keyed by exact custom-rule name                                      |
| `promptInjection.canaryTokens` | no       | Trusted local secrets used only when an enabled rule selects `canaryLeak`                   |

Use explicit dummy values until a callback contract exists:

```ts
await initializeGovernanceSDK({
  manifestPath,
  callbacks: {
    bundleUpdateUrl: "https://callbacks.invalid/governance/bundle-update",
    killSwitchUrl: "https://callbacks.invalid/governance/kill-switch"
  }
});
```

The SDK does not validate those strings as URLs, listen on them, call them, or
create backend routes. The `killSwitchUrl` placeholder provides no safety
behavior.

### Environment

Initialization reads these variables directly:

| Variable                          | Required | Behavior                                            |
| --------------------------------- | -------- | --------------------------------------------------- |
| `ZBRAIN_GOVERNANCE_BASE_URL`      | yes      | Governance service base URL; trimmed and normalized |
| `ZBRAIN_GOVERNANCE_API_KEY`       | yes      | Bearer credential; trimmed                          |
| `ZBRAIN_GOVERNANCE_SOLUTION_ID`   | yes      | Stable solution identifier; trimmed                 |
| `ZBRAIN_GOVERNANCE_DEPLOYMENT_ID` | yes      | Runtime deployment identifier; trimmed              |
| `CRON_TIME`                       | no       | Valid cron expression; defaults to `0 */6 * * *`    |

`ZBRAIN_GOVERNANCE_ENVIRONMENT` is not read by initialization. A backend may
use its own environment value when calling the low-level
`fetchGovernanceBundle` API.

### Initialization sequence

On success, initialization:

1. reads and validates the required environment strings and cron expression;
2. creates the authenticated governance client;
3. reads and JSON-parses the manifest;
4. computes a deterministic `sha256:<hex>` manifest hash;
5. registers the deployment with the manifest, hash, and callback
   placeholders;
6. validates the returned governance bundle;
7. validates custom-rule configuration and constructs enabled prompt
   detectors;
8. creates a manifest-backed policy engine and in-memory usage tracker;
9. starts the no-overlap refresh schedule; and
10. stores the handle process-wide.

The manifest loader parses JSON but does not perform runtime schema validation,
reference validation, or duplicate-DID detection. Complete those checks during
Phase 1 before deployment.

### Startup behavior

Initialization is fail-closed. Missing environment, invalid cron, an unreadable
or invalid-JSON manifest file, registration failure, an invalid initial
bundle, invalid custom-handler configuration, or detector construction failure
logs the failure and calls `process.exit(1)`.

There is no disabled handle or fallback engine. Do not catch startup failure
and serve ungoverned traffic.

Call `initializeGovernanceSDK` exactly once. The current implementation does
not reject or clean up a second initialization; a repeated call can leave the
previous scheduled task alive.

### Canary configuration

Configure canaries only when an enabled bundle rule selects `canaryLeak`:

```ts
const canary = process.env.GOVERNANCE_CANARY_TOKEN;
if (!canary) {
  throw new Error("GOVERNANCE_CANARY_TOKEN is required");
}

await initializeGovernanceSDK({
  manifestPath,
  callbacks,
  promptInjection: {
    canaryTokens: [canary]
  }
});
```

Canaries stay in trusted local configuration. Never place them in a manifest,
policy bundle, callback placeholder, decision log, or prompt.

## 5. Active handle and global access

### `ActiveGovernanceHandle`

| Member                 | Current meaning                                                                 |
| ---------------------- | ------------------------------------------------------------------------------- |
| `enabled`              | Always `true`; there is no disabled runtime mode                                |
| `solutionId`           | Stable solution identifier sent with registration and telemetry                 |
| `deploymentId`         | Deployment identifier sent with registration and telemetry                      |
| `policyEngine`         | Currently active manifest-backed enforcement engine                             |
| `bundle`               | Currently active `{ version, hash, rules }`                                     |
| `manifest`             | Loaded manifest; optional in the public type but set after successful init      |
| `manifestHash`         | Deterministic manifest hash; optional in the type but set after successful init |
| `customPolicyHandlers` | Local handler map used for initial and refreshed bundles                        |
| `client`               | Authenticated low-level service client                                          |
| `callbacks`            | Submitted placeholder strings                                                   |
| `cronTime`             | Effective refresh cron expression                                               |
| `scheduledTask`        | `node-cron` task used for refresh                                               |
| `refreshBundle()`      | Re-register, validate, construct, and activate the next bundle and engine       |

`client.apiKey` contains the bearer credential. Do not serialize, spread, or
log the handle or client.

Treat `bundle`, `policyEngine`, `manifest`, and `manifestHash` as
SDK-controlled state even though the interface does not mark every property
readonly. Assigning `handle.bundle` does not rebuild the engine and therefore
does not change enforcement.

### Accessors

```ts
const handle = getGovernance(); // throws before initialization
const optional = maybeGetGovernance(); // undefined before initialization
clearGovernance(); // destroys the current scheduled task and clears the global
```

Use `maybeGetGovernance` only for readiness probes, tests, or controlled
shutdown logic. Do not use its `undefined` result as permission to bypass
governance.

`clearGovernance` is primarily a test and shutdown helper. It initiates
scheduled-task destruction and returns immediately; task-destruction errors
are logged.

## 6. Bundle refresh and retrieval

The public APIs have different contracts:

| Operation                                | Transport               | Validates | Builds engine | Activates | Failure behavior                                  |
| ---------------------------------------- | ----------------------- | --------- | ------------- | --------- | ------------------------------------------------- |
| `initializeGovernanceSDK`                | Runtime registration    | yes       | yes           | yes       | Logs and exits startup                            |
| `getGovernance().refreshBundle()`        | Runtime re-registration | yes       | yes           | yes       | Rejects; old bundle and engine remain active      |
| Scheduled refresh                        | Calls `refreshBundle()` | yes       | yes           | yes       | Logs failure; old bundle and engine remain active |
| `fetchGovernanceBundle(client, input)`   | Bundle GET              | no        | no            | no        | Rejects on transport/service-envelope failure     |
| `validateGovernanceBundle(bundle, map?)` | No transport            | yes       | no            | no        | Rejects on validation or handler-config failure   |

`refreshBundle()` does not call `fetchGovernanceBundle`. It re-registers the
same deployment and manifest, validates the response, constructs a new engine,
and then replaces `handle.bundle` and `handle.policyEngine`. It preserves the
existing in-memory usage tracker. It does not reload or re-hash the manifest.

For fetch-only retrieval:

```ts
const current = getGovernance();
const fetched = await fetchGovernanceBundle(current.client, {
  solutionId,
  environment,
  currentHash: current.bundle.hash
});

await validateGovernanceBundle(fetched, current.customPolicyHandlers);
```

The validated `fetched` value is still inactive. The current SDK has no public
operation for atomically installing an arbitrary fetched bundle. Do not assign
it to `handle.bundle` and do not construct a raw `PolicyEvaluator` as a
substitute.

## 7. Enforcement APIs

### `GovernancePolicyEngine.evaluate`

```ts
const decision = await getGovernance().policyEngine.evaluate({
  sessionId,
  checkpoint: "model_call",
  agent: { agentDid },
  model: { provider, name: modelName }
});
```

`evaluate` builds manifest-derived context, performs hard manifest
authorization, and then evaluates the active rules. An ordinary policy denial
is returned as `PolicyDecision`; it is not thrown.

Use the initialized engine in backend code. Constructing `PolicyEvaluator`
directly skips manifest authorization, manifest enrichment, and the
initialized usage tracker.

### `requireAllowed`

```ts
function requireAllowed(
  engine: GovernancePolicyEngine,
  sessionId: string,
  input: PolicyBoundaryInput
): Promise<PolicyDecision>;
```

`PolicyBoundaryInput` is `PolicyContextInput` without `sessionId`, preventing a
typed caller from accidentally overriding the stable session ID passed
separately.

`requireAllowed`:

1. calls `engine.evaluate({ sessionId, ...input })`;
2. returns the decision when `allowed` is `true`; and
3. throws `GovernanceDeniedError` with the complete decision when `allowed` is
   `false`.

```ts
import {
  GovernanceDeniedError,
  getGovernance,
  requireAllowed,
  type PolicyBoundaryInput,
  type PolicyDecision
} from "@zbrain/governance-sdk";

async function enforceBoundary(
  sessionId: string,
  input: PolicyBoundaryInput
): Promise<PolicyDecision> {
  try {
    const decision = await requireAllowed(getGovernance().policyEngine, sessionId, input);
    recordSafeDecision(decision);
    return decision;
  } catch (error) {
    if (error instanceof GovernanceDeniedError) {
      recordSafeDecision(error.decision);
    }
    throw error;
  }
}

declare function recordSafeDecision(decision: PolicyDecision): void;
```

Convert only `GovernanceDeniedError` into the application's supported denial
path. Unexpected adapter, serialization, context-construction, or SDK errors
must remain fail-closed.

Read `getGovernance().policyEngine` at each boundary. A cached process-lifetime
engine continues evaluating the bundle with which it was constructed.

## 8. Runtime input and derived context

### `PolicyContextInput`

```ts
interface PolicyContextInput {
  sessionId: string;
  checkpoint: PolicyCheckpoint;
  timestamp?: string;
  model?: ModelContext;
  /** Required at every checkpoint. */
  agent: {
    agentDid: string;
    systemPrompt?: string;
    userMessage?: string;
  };
  governedTexts?: readonly {
    source: GovernedTextSource;
    content: string;
  }[];
  tool?: {
    toolDid: string;
    arguments?: Readonly<Record<string, unknown>>;
  };
  handoff?: {
    targetAgentDid: string;
  };
  /** Outcome of a completed operation: `"completed"` or `"failed"`. */
  status?: BoundaryStatus;
  /** Actual host-measured operation duration in milliseconds. */
  duration?: number;
  /** Short explanation for a non-successful `status`. */
  statusReason?: string;
}
```

`ModelContext` contains optional `provider`, `name`, `inputTokens`,
`outputTokens`, `totalTokens`, and `costUsd`.

| Host supplies explicitly                | SDK derives from trusted state                                    |
| --------------------------------------- | ----------------------------------------------------------------- |
| Stable session ID                       | Current timestamp when one is omitted                             |
| Concrete checkpoint                     | Agent/tool/handoff registration                                   |
| Agent and tool DIDs                     | Manifest keys, names, risk, category, resources, and capabilities |
| User message and optional system prompt | Agent-to-tool manifest authorization                              |
| Model provider/name/token/cost facts    | Session usage snapshot                                            |
| Selected tool arguments                 | Policy decision and conflict trace                                |
| Handoff target DID                      | Prompt-injection detection metadata                               |
| Provenance-labeled governed text        |                                                                   |
| Actual result status/duration           |                                                                   |

Model facts, timestamp, system prompt, user message, tool arguments, and
governed text are host-supplied. The SDK does not calculate or verify them.
Construct policy input explicitly; never spread an untrusted request or
framework event into it.

`agent` is required. Manifest authorization rejects an unresolved calling agent
before any rule matching, and every audit event is attributed to that DID, so a
boundary without one is neither enforceable nor auditable. The type makes this a
compile error rather than a runtime denial.

The remaining sections stay optional because different checkpoints genuinely
need different facts — `tool` at tool boundaries, `model` at model boundaries,
`handoff` at a transfer.

`status` and `duration` are used only for an after-boundary audit event; they
are not added to the policy context. At `agent_end`, `model_result`, and
`tool_result`, provide the real host-measured operation duration in milliseconds.

## 9. Checkpoints, defaults, and hard authorization

| Checkpoint     | Place it at                                             | No-match default | Record after allow                             |
| -------------- | ------------------------------------------------------- | ---------------- | ---------------------------------------------- |
| `agent_start`  | Before the framework or agent loop receives the request | `allow`          | `recordTurn(sessionId)`                        |
| `model_call`   | Immediately before each provider dispatch               | `allow`          | `recordModelCall(sessionId, agentDid)`         |
| `tool_call`    | Immediately before each tool execution or side effect   | `deny`           | `recordToolCall(sessionId, toolDid, agentDid)` |
| `tool_result`  | Before untrusted result reuse or release                | `allow`          | none                                           |
| `model_result` | Before model output routing, persistence, or release    | `allow`          | none                                           |
| `agent_end`    | Before reporting successful completion                  | `allow`          | none                                           |
| `handoff`      | Before transferring state or control                    | `deny`           | none                                           |

Hard manifest authorization runs before policy matching:

- every checkpoint requires the calling agent DID to resolve in the manifest;
- `tool_call` requires the tool DID to resolve and appear in that agent's
  manifest `tools` list; and
- `handoff` requires the target agent DID to resolve.

No rule can permit an unknown caller, an unknown tool, a tool outside the
calling agent's manifest assignment, or an unknown handoff target.

The hard tool gate applies only to `tool_call`. Preserve and pass the original
tool DID at `tool_result`; the SDK does not reapply agent-to-tool authorization
there. The manifest also has no handoff allowlist: a registered target still
requires a permitting `handoff` policy because that checkpoint defaults to
deny.

## 10. Governed text routing

Prompt-injection validation runs only when an enabled `validation` rule applies
and the concrete boundary supplies eligible text:

| Runtime checkpoint | Text location                     | Accepted sources                                   | Eligible checks                 |
| ------------------ | --------------------------------- | -------------------------------------------------- | ------------------------------- |
| `agent_start`      | `agent.userMessage`               | Automatically labeled `user_message`               | All checks selected by the rule |
| `model_call`       | `governedTexts`                   | `user_message`, `tool_result`, `retrieved_content` | All checks selected by the rule |
| `tool_result`      | `governedTexts`                   | `tool_result`, `retrieved_content`                 | All checks selected by the rule |
| `model_result`     | `governedTexts`                   | `model_output`                                     | `canaryLeak` only               |
| Other checkpoints  | Not routed to built-in validation | none                                               | none                            |

At `agent_start`, explicit `governedTexts` is ignored. `agent.systemPrompt` is
available to ordinary context rules but is not automatically routed into
prompt-injection validation.

At the other supported boundaries, an absent or empty `governedTexts` array
means there is no text to inspect. When validation applies, a supplied text
with an invalid source fails closed.

Keep segments separate by provenance. Do not concatenate user input, retrieved
content, tool output, and model output into one unlabeled string. The detector
returns hashes, lengths, categories, and safe pattern keys rather than the
governed text itself.

## 11. Decisions and denial errors

### `PolicyDecision`

| Field              | Meaning                                                                      |
| ------------------ | ---------------------------------------------------------------------------- |
| `allowed`          | `true` for `allow`, `audit`, and `warn`; `false` for `deny`                  |
| `action`           | Effective `allow`, `audit`, `warn`, or `deny`                                |
| `checkpoint`       | Concrete runtime checkpoint evaluated                                        |
| `matchedRule`      | Winning rule; omitted for defaults, manifest denials, and fail-closed errors |
| `matchedRuleId`    | Governance-microservice `_id` of the winning rule, when the bundle has one   |
| `matchedRuleLevel` | Authority level of the winning rule (`enterprise` or `solution`)             |
| `matchedRules`     | Ordered matching candidates for normal conflict resolution                   |
| `conflictDetected` | Whether a deny and at least one permitting candidate both matched            |
| `resolutionTrace`  | Deterministic diagnostic steps without governed text                         |
| `reason`           | Winning, default, manifest, or failure reason                                |
| `auditData`        | Optional custom-handler or prompt-detection facts                            |

`GovernanceDeniedError` extends `Error` and exposes the denied decision as
`error.decision`.

`evaluate` reports to the governance microservice before returning: an audit
event for supported checkpoints, and a violation record when a bundle rule won
and its action is not `allow`. Reporting is narrower than enforcement — a
checkpoint-default deny, a manifest-authorization denial, and a fail-closed
evaluation error are enforced but produce no violation record, because no rule
won.
See [what is not reported](03-backend-integration.md#what-is-deliberately-not-reported).
The violation payload carries rule identifiers, `matchedRules`, and
`resolutionTrace`. It excludes `arguments` and `auditData`; evaluator metadata
is carried by the audit event. Both calls are best-effort and never affect the
returned decision. Do not build a second audit store that mirrors them.

Reporting a decision is not acting on it. The backend must still handle
permitted `audit` and `warn` decisions explicitly.

### Audit event shape

Every audit event carries the `AuditLogBase` fields — `checkpoint`, `timestamp`,
`agentDid`, `agentName`, `policyViolation`, and optional `metadata` (the winning
candidate's `auditData`). An event that cannot be attributed to an agent cannot
be audited, so `agentDid` and `agentName` are present on all of them;
`agentName` is resolved from the manifest and is never host-supplied. Both are
empty strings only when the DID does not resolve, which is itself a denial.

When `policyViolation` is `true`, the event also carries `violationDetails`
(`AuditViolationDetails`): `action`, `reason`, `matchedRules`, `conflictDetected`,
and `resolutionTrace`, plus `matchedRule`, `matchedRuleId`, `matchedRuleLevel`,
and safe `auditData` when available. This includes `warn` and `audit` outcomes,
checkpoint-default denials, manifest-authorization denials, and fail-closed
evaluation errors. Unmatched denials omit the winning-rule fields. Unexpected
exception messages are replaced with a generic failure reason in the audit
payload. Allow events omit `violationDetails`; existing `metadata` is preserved.

Each checkpoint then adds its own fields:

| Checkpoint     | Type             | Adds                                                         |
| -------------- | ---------------- | ------------------------------------------------------------ |
| `agent_start`  | `BeforeAgentLog` | `tools`                                                      |
| `agent_end`    | `AfterAgentLog`  | `status`, opt. `duration`, opt. `statusReason`, `summary`    |
| `model_call`   | `BeforeModelLog` | `modelName`, `modelProvider`, `estimatedInputTokens`         |
| `model_result` | `AfterModelLog`  | `modelName`, `status`, opt. `duration`, opt. `statusReason`, token counts, opt. `cost` |
| `tool_call`    | `BeforeToolLog`  | `toolName`                                                   |
| `tool_result`  | `AfterToolLog`   | `toolName`, `status`, opt. `duration`, opt. `statusReason`   |
| `handoff`      | `HandoffLog`     | `targetAgentDid`, `targetAgentName`                          |

`targetAgentName` is resolved from the manifest and falls back to the target DID
when it does not resolve.

Every evaluated boundary emits exactly one audit event. `BoundaryStatus` is
`"completed" | "failed"`, and the same two values are checked again at runtime
because a JavaScript host is not held to the type.

An `agent_end`, `model_result`, or `tool_result` boundary whose host reports no
usable outcome is still recorded, as the SDK-set status `unknown`
(`AuditBoundaryStatus`), with the cause in `statusReason` and a console error.
`duration` is omitted rather than invented, so it is optional on the three
after-boundary payloads. A host cannot send `unknown`: it always means the
integration did not report an outcome.

`statusReason` explains a non-successful `status` on those same three
boundaries. The SDK trims it, replaces any configured canary token with
`[redacted]`, drops it when it is empty, and truncates it to 500 characters. It
is not inspected further, so supply a failure classification — never prompts,
user content, tool arguments, credentials, or other governed text. It is
ignored at before-boundaries, which carry no status.

Rule names, rule reasons, and custom-handler error messages can appear in
decisions. Keep them caller-safe and apply the backend's normal disclosure
rules before returning a reason externally. Never add prompts, secrets, or
complete tool arguments to ordinary decision logs.

## 12. Usage counters

The initialized engine exposes:

```ts
engine.recordTurn(sessionId);
engine.recordModelCall(sessionId, agentDid);
engine.recordToolCall(sessionId, toolDid, agentDid);
```

The next evaluation reads:

| Context path                   | Counter scope                 |
| ------------------------------ | ----------------------------- |
| `usage.turnCount`              | Session                       |
| `usage.modelCallPerAgentCount` | Session and current agent DID |
| `usage.perToolCallCount`       | Session and current tool DID  |
| `usage.totalToolCallCount`     | All tools in the session      |

Evaluation reads the existing count. Record only after allowance and
immediately before the corresponding dispatch:

```text
evaluate -> deny or continue -> record -> dispatch
```

The standard initialized runtime uses one in-memory tracker:

- counters are not automatic;
- refresh preserves them;
- process restart or a new initialization loses them;
- replicas do not share them;
- evaluation and recording are separate, non-atomic operations;
- parallel requests can observe the same pre-dispatch value; and
- token and cost fields in `ModelContext` do not feed the policy-visible
  `usage.*` counters, which count events only.

Tokens and cost **are** accumulated elsewhere. At `model_result` the engine
automatically sums `inputTokens`, `outputTokens`, `totalTokens`, and `costUsd`
into that agent's `AgentAuditSummary`, which is emitted in the `agent_end` audit
event. That total is audit data, not a policy fact: no condition path exposes
it, so a token or spend limit still has to be written against the per-call
`model.*` values the host supplies.

`UsageStore` is public for low-level custom composition, but
`initializeGovernanceSDK` does not accept a custom store. Distributed hard
quotas require additional SDK and storage integration.

## 13. Bundle contract and validation

```ts
interface GovernanceBundle {
  version: string;
  hash: string;
  rules: readonly PolicyRule[];
}
```

`validateGovernanceBundle(bundle, customPolicyHandlers?)` is asynchronous and
returns `Promise<void>`. It throws when validation fails.

It currently validates:

- object shape, non-empty `version` and `hash`, and a rules array;
- unique non-empty rule names;
- supported levels, kinds, checkpoints, actions, and finite priorities;
- required reasons, conditions, operators, and safe path segments;
- the enterprise condition-path allowlist;
- custom-rule solution level, JSON config, handler presence, and handler
  `validateConfig`;
- validation-rule lifecycle, non-`allow` action, unique checks, and detector
  configuration.

It currently does **not**:

- recompute or verify `hash`;
- verify a signature;
- prove that a rule's claimed level came from an authorized control-plane
  author;
- validate rule references against the manifest;
- reject every arbitrary extra property; or
- enforce the documented priority range.

Policy-authoring priority remains `1` through `1000`, inclusive. The current
validator accepts any finite number, including fractions and out-of-range
values, so the governance service and development validation must enforce the
authoring contract.

Validation alone does not activate a bundle.

## 14. Manifest APIs

```ts
interface SolutionManifest {
  agents: readonly AgentDefinition[];
  tools: readonly ToolDefinition[];
  capabilities: readonly string[];
  resources: readonly string[];
}
```

`AgentDefinition` requires:

- `agentKey`, `agentDid`, and `name`;
- `capabilities` and assigned tool DIDs in `tools`;
- `riskTier` and numeric `riskScore`; and
- optional `metadata`.

`ToolDefinition` requires:

- `key`, `toolDid`, and `capability`;
- `resources`, `category`, and `riskTier`; and
- optional `metadata`.

`RISK_TIER` is `CRITICAL | HIGH | MEDIUM | LOW | MINIMAL`.
`ToolDefinition["category"]` is
`read | write | execute | communicate | delete | other`; `TOOL_CATEGORY` is
not a named package export.

`loadSolutionManifest(path)` reads and JSON-parses the file, but then treats
the result as `SolutionManifest` without runtime schema checking. An empty
path, read error, or JSON parse error follows the SDK startup path and calls
`process.exit(1)`.

`computeJsonSha256Hash(manifest)` recursively sorts object keys, preserves array
order, stringifies the value, and returns `sha256:<hex>`. Initialization always
hashes the parsed manifest and submits both content and hash.

The manifest is loaded once. Bundle refresh does not reload it. Restart and
re-register the deployment to activate a changed manifest.

## 15. Custom policy handlers

```ts
interface CustomPolicyHandler {
  validateConfig(config: PolicyConfig): void | Promise<void>;
  evaluate(
    input: CustomPolicyHandlerInput
  ): CustomPolicyEvaluation | Promise<CustomPolicyEvaluation>;
}
```

Register handlers by exact custom-rule name:

```ts
await initializeGovernanceSDK({
  manifestPath,
  callbacks,
  customPolicyHandlers: {
    "solution-deny-high-value-transfer": highValueTransferHandler
  }
});
```

Current behavior:

- custom rules must have `level: "solution"` and `kind: "custom"`;
- `config` must be a JSON object;
- every custom rule in a validated bundle, including a disabled one, requires a
  valid locally registered handler;
- `validateConfig` runs during initial and refreshed bundle validation;
- `evaluate` runs only for an enabled custom rule at its exact checkpoint;
- a missing handler or thrown evaluation error produces a fail-closed denial;
- `auditData`, when returned, belongs to the trusted handler and must remain
  JSON-compatible and non-secret.

Handlers are never downloaded or executed from the bundle.

## 16. Prompt-injection runtime API

The public runtime option is:

```ts
interface PromptInjectionRuntimeOptions {
  canaryTokens?: readonly string[];
}
```

Policy-side `PromptInjectionPolicyConfig` contains optional `blocklist`,
`allowlist`, and additive category-scoped `additionalPatterns`. The recognized
categories are exposed through `PROMPT_INJECTION_TYPES`:

```text
directOverride
delimiterAttack
encodingAttack
rolePlay
contextManipulation
canaryLeak
multiTurnEscalation
```

Important behavior:

- an enabled rule selecting `canaryLeak` requires at least one trusted local
  canary;
- canaries must be unique strings with at least three non-whitespace
  characters;
- a canary detection is forced to `deny`, even when its rule requested `audit`
  or `warn`;
- only `canaryLeak` runs at `model_result`;
- detector failure and invalid routed input fail closed;
- policy blocklists, allowlists, and patterns are not secret;
- canary tokens never appear in decisions; and
- `PromptInjectionDetector` itself is not exported from the package.

See Phase 2 for normalization, provenance, pattern, allowlist, canary, and
detector limitations.

## 17. Low-level control-plane APIs

### Client

```ts
const client = createZBrainGovernanceClient({
  baseUrl,
  apiKey
});
```

`ZBrainGovernanceClient`:

- normalizes `baseUrl` with a trailing slash;
- sends `Authorization: Bearer <apiKey>` and JSON content type;
- requires the governance service envelope
  `{ responseData, message, success, responseCode }`;
- throws on non-2xx, `success: false`, or an invalid envelope;
- exposes the normalized `baseUrl` and sensitive `apiKey` as readonly
  properties; and
- currently configures no SDK retry policy or request timeout.

`registerDeployment(client, input)` delegates to
`client.registerRuntime(input)`. The client posts to
`v1/api/runtime/register`, adds `solutionAppId`, and sends the transport
deployment ID as `<deploymentId>-<solutionId>`.

`fetchGovernanceBundle(client, input)` delegates to the client's bundle GET:

```ts
interface FetchGovernanceBundleInput {
  solutionId: string;
  environment: string;
  currentHash?: string;
}
```

The low-level client validates the response envelope, not the complete
registration response or bundle payload. Call `validateGovernanceBundle`
before trusting a fetched bundle.

Ordinary backend startup should prefer `initializeGovernanceSDK`, which
performs registration, validation, engine construction, scheduling, and
global activation together.

## 18. Low-level policy and context APIs

These exports support focused tests, internal tooling, or deliberately custom
composition:

| Export                    | Purpose                                                      | Main caution                                      |
| ------------------------- | ------------------------------------------------------------ | ------------------------------------------------- |
| `PolicyEvaluator`         | Evaluate already-enriched `PolicyContext` against rules      | No manifest authorization or context enrichment   |
| `PolicyContextBuilder`    | Build enriched context and attach usage                      | Does not enforce manifest authorization by itself |
| `ManifestContextResolver` | Resolve agent, tool, and handoff DIDs                        | Duplicate manifest DIDs are not rejected          |
| `SessionUsageTracker`     | Read and increment session counters                          | Evaluation and recording remain non-atomic        |
| `InMemoryUsageStore`      | Process-local `UsageStore`                                   | Not durable or distributed                        |
| `GovernancePolicyEngine`  | Combine context building, hard authorization, and evaluation | Prefer the instance owned by the active handle    |

If custom composition is genuinely required, preserve the initialized runtime
properties: manifest authorization before policy matching, one stable usage
tracker, bundle validation before evaluator construction, trusted local custom
handlers, prompt-injection runtime secrets, and atomic bundle/engine
replacement.

## 19. Utility exports

| Export                         | Behavior                                             |
| ------------------------------ | ---------------------------------------------------- |
| `requireString(value, field)`  | Returns a trimmed non-empty string or throws         |
| `stableJsonStringify(value)`   | Recursively sorts object keys; preserves array order |
| `sha256Digest(value)`          | Returns a UTF-8 string digest as `sha256:<hex>`      |
| `computeJsonSha256Hash(value)` | Stable-stringifies then hashes JSON-like data        |

Use the hashing helpers with JSON-compatible values. They do not sign data or
verify governance-service hashes.

## 20. Exhaustive public export map

All package exports come from the root entry point.

### Runtime values and constants

| Group                    | Exports                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Runtime lifecycle        | `initializeGovernanceSDK`, `getGovernance`, `maybeGetGovernance`, `clearGovernance`                                 |
| Enforcement              | `GovernancePolicyEngine`, `requireAllowed`, `GovernanceDeniedError`                                                 |
| Control plane            | `ZBrainGovernanceClient`, `createZBrainGovernanceClient`, `registerDeployment`, `fetchGovernanceBundle`             |
| Manifest and bundle      | `loadSolutionManifest`, `validateGovernanceBundle`                                                                  |
| Policy/context internals | `PolicyEvaluator`, `PolicyContextBuilder`, `ManifestContextResolver`, `SessionUsageTracker`, `InMemoryUsageStore`   |
| Hashing and validation   | `computeJsonSha256Hash`, `stableJsonStringify`, `sha256Digest`, `requireString`                                     |
| Policy constants         | `POLICY_CHECKPOINTS`, `POLICY_CHECKPOINT_DEFAULT_ACTIONS`, `POLICY_OPERATORS`, `ENTERPRISE_POLICY_CONDITION_FIELDS` |
| Validation constants     | `VALIDATION_LIFECYCLE_CHECKPOINT`, `GOVERNED_TEXT_SOURCES`, `PROMPT_INJECTION_TYPES`                                |

### Exported types

| Group                    | Types                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime                  | `ActiveGovernanceHandle`, `GovernanceHandle`, `GovernanceEnv`, `GovernanceOptions`, `PolicyBoundaryInput`                                                                                                                                                                                                                                                             |
| Control plane and bundle | `ZBrainGovernanceClientOptions`, `CallbackEndpoints`, `RuntimeRegistrationRequest`, `RuntimeRegistrationResponse`, `FetchGovernanceBundleInput`, `GovernanceBundle`                                                                                                                                                                                                   |
| Decision telemetry       | `AuditLogBase`, `AuditLogData`, `AuditLogRequest`, `BeforeAgentLog`, `AfterAgentLog`, `BeforeModelLog`, `AfterModelLog`, `BeforeToolLog`, `AfterToolLog`, `HandoffLog`, `AgentAuditSummary`, `PolicyViolationLogRequest`, `TrustScoreUpdateRequest`                                                                                                                   |
| Manifest                 | `SolutionManifest`, `AgentDefinition`, `ToolDefinition`, `RISK_TIER`                                                                                                                                                                                                                                                                                                  |
| Runtime input            | `PolicyContextInput`, `AgentContextInput`, `ToolContextInput`, `HandoffContextInput`, `GovernedTextContextInput`, `ModelContext`                                                                                                                                                                                                                                      |
| Enriched context         | `PolicyContext`, `RedactedPolicyContext`, `AgentContext`, `ToolContext`, `HandoffContext`, `GovernedTextContext`, `GovernedTextSource`, `UsageContext`                                                                                                                                                                                                                |
| Core policy              | `PolicyRule`, `EnterprisePolicyRule`, `SolutionPolicyRule`, `CustomPolicyRule`, `PolicyLevel`, `PolicyAction`, `PolicyCheckpoint`, `ValidationLifecycleCheckpoint`, `PolicyCondition`, `EnterprisePolicyCondition`, `EnterprisePolicyConditionField`, `PolicyContextPath`, `PolicyOperator`, `PolicyOperatorName`, `PolicyValue`, `PolicyConfig`, `PolicyConfigValue` |
| Decisions and handlers   | `PolicyDecision`, `PolicyAuditData`, `CustomPolicyAuditData`, `CustomPolicyHandler`, `CustomPolicyHandlerInput`, `CustomPolicyEvaluation`                                                                                                                                                                                                                             |
| Prompt injection         | `PromptInjectionPolicyRule`, `PromptInjectionPolicyConfig`, `PromptInjectionValidationCondition`, `PromptInjectionRuntimeOptions`, `PromptInjectionType`, `PromptInjectionDetection`, `PromptInjectionAuditData`                                                                                                                                                      |
| Low-level composition    | `PolicyEvaluatorOptions`, `UsageStore`                                                                                                                                                                                                                                                                                                                                |

`TOOL_CATEGORY`, `PolicyCandidate`, `normalizePolicyLevel`,
`PromptInjectionDetector`, prompt-pattern constants, and `failStartup` are not
root package exports.

### Out of scope: agent identity and trust

The package also exports an `agentmesh` surface — agent identity and DID
generation (`AgentIdentity`, `generateAgentDid`, `generateIdentity`,
`issueCredential`, `validateCredential`, `sign`, `verifySignature`), risk
scoring (`RiskScorer`, `RiskScore`, `RiskSignal`), and trust/reward scoring
(`TrustScore`, `RewardEngine`, `getTrustTier`, and the `TIER_*`/`WEIGHT_*`
constants), with their supporting types.

**These are not part of the governed-application integration path** and the
tables above deliberately omit them. Manifest DIDs are authored as stable
constants under the conventions in
[Phase 1](01-solution-manifest.md#4-choose-stable-and-unambiguous-identities) —
do not generate them at runtime with `generateAgentDid`, because a DID must stay
identical across restarts, releases, and environments.

Treat this subsystem as unsupported for generated backends unless a plan
explicitly calls for it.

## 21. Failure behavior matrix

| Operation or failure                              | Current result                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| Missing initialization environment                | Log and `process.exit(1)`                                                  |
| Invalid cron expression                           | Log and `process.exit(1)`                                                  |
| Manifest path/read/JSON failure                   | Log and `process.exit(1)`                                                  |
| Initial registration or bundle failure            | Log and `process.exit(1)`                                                  |
| Initial custom config or detector failure         | Log and `process.exit(1)`                                                  |
| `getGovernance()` before initialization           | Throws `Error`                                                             |
| Manifest authorization denial                     | Returns a denied `PolicyDecision`                                          |
| Ordinary policy denial                            | Returns a denied decision; `requireAllowed` throws `GovernanceDeniedError` |
| Custom handler or evaluator error                 | Returns a fail-closed denied decision                                      |
| Invalid untyped input during context construction | May throw before a decision is produced                                    |
| Manual active refresh failure                     | Rejects and retains the old bundle and engine                              |
| Scheduled refresh failure                         | Logs and retains the old bundle and engine                                 |
| Low-level client/fetch failure                    | Rejects; no startup exit wrapper                                           |
| `validateGovernanceBundle` failure                | Rejects; does not mutate active state                                      |

## 22. Current non-features and limits

Do not assume the package currently provides:

- registry publication;
- framework adapters or automatic interception;
- policy-authoring document upload or registration;
- callback routes, callback authentication, or callback payload handling;
- kill-switch state or enforcement;
- runtime manifest schema validation, duplicate detection, or hot reload;
- bundle signature verification or hash recomputation;
- SDK enforcement of the `1`–`1000` authoring priority range;
- public activation of an arbitrary fetched bundle;
- automatic handling or presentation of a winning `audit` or `warn` action
  (decisions are reported to the governance service, but acting on them is the
  application's job);
- automatic turn, model-call, or tool-call recording;
- token or cost accumulation into the policy-visible `usage.*` counters (they
  are accumulated into the `agent_end` audit summary, but no condition path
  reads them);
- durable, distributed, or atomic cross-process usage limits;
- output-stream buffering or retraction;
- control-plane request retries or timeouts; or
- idempotent repeated initialization.

## Completion checklist

- [ ] The backend uses the built local package and imports only its root.
- [ ] Initialization runs exactly once before readiness.
- [ ] All four required environment values are present.
- [ ] `CRON_TIME`, when set, is valid.
- [ ] Callback fields contain explicit placeholders and no kill-switch claim.
- [ ] Custom handlers and required canaries are registered before bundle load.
- [ ] Every boundary supplies a registered calling agent DID.
- [ ] Tool and handoff checks use exact manifest DIDs.
- [ ] Every dispatch is checked immediately before execution.
- [ ] Usage is recorded only after allow and immediately before dispatch.
- [ ] Governed text uses the accepted source for its concrete checkpoint.
- [ ] Model and tool results are withheld after a result denial.
- [ ] Every boundary reads the currently active engine.
- [ ] Fetched bundles are not mistaken for active bundles.
- [ ] Permitted `audit` and `warn` decisions are handled by the backend.
- [ ] Denial and unexpected-error paths fail closed.
