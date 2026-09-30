# Phase 2: Write and Register Solution-Level Policies

## Goal

During development, a developer or coding agent writes the rules that govern
one solution, validates them with the application and manifest, and registers
the reviewed policy document with the governance service.

Complete, validate, and register the
[Phase 1 solution manifest](01-solution-manifest.md) before authoring these
rules. Policies must use the exact identities, assignments, capabilities,
resources, classifications, risk values, and metadata declared by that
manifest rather than inventing parallel facts.

The primary deliverable from this phase is a solution policy authoring document
containing `version` and `rules`. This guide focuses on writing those rules. It
explains lifecycle boundaries, manifest authorization, checkpoint defaults,
context paths and operators, priority and conflict resolution, usage counters,
custom handlers, prompt-injection validation, bundle activation, decisions,
testing, and current implementation limits wherever they affect correct
authoring.

This guide describes the behavior implemented by the current codebase. The
principal sources are the
[policy types](../../src/policy-engine/types.ts),
[bundle validator](../../src/policy-engine/bundle-validation.ts),
[context builder](../../src/policy-engine/context.ts),
[policy evaluator](../../src/policy-engine/evaluator.ts), and
[manifest-backed engine](../../src/core/index.ts).

## 1. Understand the development and runtime lifecycle

Policy registration during development and deployment registration at runtime
are separate operations:

```text
developer or coding agent
        |
        | during development: write, review, and test
        v
solution policy authoring document: { version, rules }
        |
        | register policies with the governance service
        v
governance service
        |
        | later: SDK deployment registration returns
        |        GovernanceBundle { version, hash, rules }
        v
SDK bundle validation
        |
        v
manifest-backed policy engine
```

The expected development-time authoring document contains `version` and
`rules`, but not the `hash` required by a runtime `GovernanceBundle`. Keep this
document in source control, review it with the manifest and application code,
and register it through the governance service's developer-facing workflow.

The runtime SDK does not load this file or upload its policies. Passing its
path to `initializeGovernanceSDK` has no effect, and this repository currently
provides neither a policy-file loader nor a developer policy-registration
command. The exact service transport and registration request are outside this
SDK's current API.

At runtime:

- `initializeGovernanceSDK` loads only `manifestPath`;
- the SDK registers the deployment, not the development-time policy document;
- that deployment registration returns `{ version, hash, rules }`;
- the SDK validates that bundle before constructing the evaluator;
- the active bundle can contain enterprise and solution rules; and
- scheduled or manual re-registration can replace the active bundle.

The SDK checks that `version` and `hash` are non-empty strings. It does not
calculate the bundle hash, validate its format, verify a signature, or prove
that a rule's declared `level` came from an authorized policy author. Those are
control-plane responsibilities.

## 2. Know where policy evaluation sits in enforcement

Use the initialized `GovernancePolicyEngine`, not `PolicyEvaluator` directly,
in application code. The engine evaluates a boundary in this order:

1. Build context from host input.
2. Resolve agent, tool, and handoff DIDs against the active manifest.
3. Attach SDK-maintained session counters.
4. Enforce hard manifest authorization.
5. Evaluate all applicable policy rules.
6. Resolve matching rules into one `PolicyDecision`.
7. Return the decision for the host to enforce.

The raw `PolicyEvaluator` performs steps 5 and 6 only. It is useful for focused
unit tests, but using it as the production enforcement boundary bypasses the
manifest authorization checks.

### Hard manifest authorization

These checks run before policy matching and cannot be overridden by an `allow`
rule:

| Boundary         | Hard requirement                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Every checkpoint | `agent.agentDid` must resolve to an agent in the manifest. `agent` is required input.                                     |
| `tool_call`      | `tool.toolDid` must resolve to a manifest tool and that DID must be present in the calling agent's manifest `tools` list. |
| `handoff`        | `handoff.targetAgentDid` must resolve to a manifest agent.                                                                |

A manifest authorization denial has no `matchedRule`; its
`resolutionTrace` starts with `Manifest authorization denied`.

The tool-specific hard gate is applied only at `tool_call`. At `tool_result`,
an omitted or unknown tool is not rejected by this gate. If the result must be
bound to a known tool, pass the tool DID and write an explicit policy or
validate that relationship in the host adapter.

## 3. Start from checkpoint defaults

Rules are evaluated at concrete lifecycle checkpoints:

| Checkpoint     | No-match default | Typical placement                                                                   |
| -------------- | ---------------- | ----------------------------------------------------------------------------------- |
| `agent_start`  | `allow`          | Validate the initial user message; constrain who may start.                         |
| `model_call`   | `allow`          | Validate model inputs; enforce model, cost, token, or usage controls.               |
| `tool_call`    | `deny`           | Explicitly permit approved tool invocations; deny risky arguments or excessive use. |
| `tool_result`  | `allow`          | Validate untrusted tool or retrieval output before reuse.                           |
| `model_result` | `allow`          | Detect canary leakage; request output audit or warning behavior.                    |
| `agent_end`    | `allow`          | Audit or constrain completion.                                                      |
| `handoff`      | `deny`           | Explicitly permit specific agent-to-agent handoffs.                                 |

`validation_lifecycle` is also used in policy JSON, but it is not a runtime
checkpoint. It is the required placement for a built-in prompt-injection
validation rule. The evaluator routes that rule to supported concrete
checkpoints and reports the concrete checkpoint in the decision.

The defaults have two important design consequences:

- every allowed `tool_call` and `handoff` needs a matching permitting rule;
- deny rules at those checkpoints do not create permission by themselves; and
- controls at the other checkpoints need an explicit deny, warn, or audit rule
  because absence of a match permits execution.

## 4. Choose the right rule family

Every rule has these common fields:

| Field        | Requirement and behavior                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`       | Non-empty and unique across the entire active bundle. Matching of names is case-sensitive. Custom handlers are keyed by this exact name.                         |
| `level`      | `solution` for solution-owned rules. JSON validation accepts case variants such as `SOLUTION`, then normalizes them. Do not use `enterprise` to claim authority. |
| `kind`       | `context`, `custom`, or `validation`. Omitting `kind` means `context`. Other values are rejected.                                                                |
| `checkpoint` | A concrete checkpoint for context/custom rules; exactly `validation_lifecycle` for validation rules.                                                             |
| `priority`   | A number from `1` through `1000`, inclusive. Higher values win ordinary conflicts. Use whole numbers for a simpler shared convention.                            |
| `enabled`    | Must be a boolean. Disabled rules do not evaluate, but are still bundle-validated.                                                                               |
| `action`     | `allow`, `audit`, `warn`, or `deny`. Validation rules cannot use `allow`.                                                                                        |
| `reason`     | Non-empty, caller-safe text returned when the rule wins. Do not put secrets or internal diagnostics here.                                                        |

There are three rule families.

The `1`–`1000` range is the policy-authoring and governance-service contract.
The current SDK bundle validator checks only that `priority` is a finite
number; it does not yet reject zero, negative, or above-range values.
Developers, coding agents, and service-side registration must enforce the
documented range rather than treating SDK acceptance as validity.

### Context rules

Use a context rule when supported operators can express the policy:

```json
{
  "name": "solution-allow-support-customer-lookup",
  "level": "solution",
  "kind": "context",
  "checkpoint": "tool_call",
  "priority": 200,
  "enabled": true,
  "condition": {
    "agent.agentKey": {
      "eq": "support-agent"
    },
    "tool.key": {
      "eq": "lookup-customer"
    }
  },
  "action": "allow",
  "reason": "The support agent may use the approved customer lookup."
}
```

All paths in `condition` and all operators on each path are combined with
logical AND. An empty condition object is valid and matches every evaluation at
that checkpoint. Use an empty condition only when an unconditional rule is
intentional.

### Custom rules

Use a custom rule when the policy needs logic that declarative operators cannot
express:

```json
{
  "name": "solution-deny-high-value-transfer",
  "level": "solution",
  "kind": "custom",
  "checkpoint": "tool_call",
  "priority": 600,
  "enabled": true,
  "config": {
    "maximumAmount": 1000,
    "currency": "USD"
  },
  "action": "deny",
  "reason": "The transfer exceeds the solution's unattended limit."
}
```

The host must register a trusted handler under the exact rule name. Custom
rules are solution-only and their `config` must be a recursively JSON-compatible
object.

### Prompt-injection validation rules

Use a validation rule for the SDK's built-in prompt-injection detector:

```json
{
  "name": "solution-deny-prompt-injection",
  "level": "solution",
  "kind": "validation",
  "checkpoint": "validation_lifecycle",
  "priority": 900,
  "enabled": true,
  "condition": {
    "checks": {
      "in": [
        "directOverride",
        "delimiterAttack",
        "encodingAttack",
        "rolePlay",
        "contextManipulation",
        "multiTurnEscalation"
      ]
    }
  },
  "action": "deny",
  "reason": "Prompt-injection indicators are not permitted."
}
```

The rule becomes a candidate only when a selected detector check finds a
signal. Clean or absent input does not make the validation rule match.
`config` is optional: omit it to use only the selected built-in checks, or use
the strict [validation config](#validation-config-reference) to add blocklist
entries, span-scoped allowlist entries, or category-specific RE2 patterns.

## 5. Author context conditions against real data

### Data supplied by the host

The host can provide these values to `policyEngine.evaluate`:

- `sessionId`;
- `checkpoint`;
- optional `timestamp` (the SDK supplies the current ISO timestamp when
  omitted);
- `model.provider`, `model.name`, token counts, and `model.costUsd`;
- `agent.agentDid`, `agent.systemPrompt`, and `agent.userMessage`;
- `tool.toolDid` and `tool.arguments`;
- `handoff.targetAgentDid`; and
- provenance-labeled `governedTexts`.

The SDK does not calculate or verify model token counts, model cost, tool
arguments, system prompts, or user messages. A policy using those values is
only as accurate as the host adapter that supplies them.

### Data derived from the manifest

The SDK resolves DIDs and adds these facts:

| Context        | Manifest-derived paths                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agent          | `agent.registered`, `agent.agentKey`, `agent.capabilities`, `agent.tools`, `agent.name`, `agent.riskTier`, `agent.riskScore`, `agent.metadata.<key>`                 |
| Tool           | `tool.registered`, `tool.key`, `tool.capability`, `tool.resources`, `tool.category`, `tool.riskTier`, `tool.metadata.<key>`                                          |
| Handoff target | `handoff.registered`, `handoff.agentKey`, `handoff.capabilities`, `handoff.tools`, `handoff.name`, `handoff.riskTier`, `handoff.riskScore`, `handoff.metadata.<key>` |

Prefer manifest-derived keys, capabilities, categories, risk values, and
metadata over duplicating those facts in runtime arguments.

### Data maintained by the SDK

The context always contains:

| Path                           | Scope                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------- |
| `usage.perToolCallCount`       | Calls of the current tool in the current session; zero when no tool is present.                   |
| `usage.totalToolCallCount`     | All recorded tool calls in the current session.                                                   |
| `usage.modelCallPerAgentCount` | Recorded model calls for the current agent in the current session; zero when no agent is present. |
| `usage.turnCount`              | Recorded turns in the current session.                                                            |

These facts are not accepted from the caller, but the host must explicitly
record events. See [Usage policies](#9-use-usage-rules-with-their-runtime-limits).

### Complete solution context path surface

Supported fixed solution paths are:

```text
sessionId
timestamp
checkpoint

model.provider
model.name
model.inputTokens
model.outputTokens
model.totalTokens
model.costUsd

agent.agentDid
agent.registered
agent.agentKey
agent.capabilities
agent.tools
agent.name
agent.riskTier
agent.riskScore
agent.systemPrompt
agent.userMessage
agent.metadata.<key>[.<nested-key>...]

tool.toolDid
tool.registered
tool.key
tool.capability
tool.resources
tool.category
tool.riskTier
tool.arguments.<key>[.<nested-key>...]
tool.metadata.<key>[.<nested-key>...]

handoff.targetAgentDid
handoff.registered
handoff.agentKey
handoff.capabilities
handoff.tools
handoff.name
handoff.riskTier
handoff.riskScore
handoff.metadata.<key>[.<nested-key>...]

usage.perToolCallCount
usage.totalToolCallCount
usage.modelCallPerAgentCount
usage.turnCount
```

`governedTexts` is an array of structured values. It is intended for validation
rules, not ordinary primitive context comparisons.

The bundle validator restricts enterprise context rules to the exported
`ENTERPRISE_POLICY_CONDITION_FIELDS` list:

```text
model.name                 model.provider
model.inputTokens          model.outputTokens
model.totalTokens          model.costUsd
tool.category              tool.riskTier
tool.registered
agent.riskTier             agent.riskScore
agent.registered
handoff.riskTier           handoff.riskScore
handoff.registered
usage.perToolCallCount     usage.totalToolCallCount
usage.modelCallPerAgentCount
usage.turnCount
```

Solution paths are more flexible. For JSON bundles, the validator checks a
solution path for safe segments but does not prove that the path exists.
TypeScript's `PolicyCondition` type catches fixed-path mistakes when rules are
authored in code; plain JSON needs tests.

### Path behavior and hazards

- Nested metadata and argument fields are addressed with dot-separated paths.
- Only own object properties are read.
- Empty segments and `__proto__`, `constructor`, and `prototype` segments are
  rejected.
- Array indices are not traversed. Compare an array as a whole with
  `contains`, rather than writing a path such as `agent.capabilities.0`.
- A key that itself contains a dot cannot be addressed literally.
- Missing paths resolve to `undefined`.
- Most comparisons against `undefined` are false, but `ne` is true whenever
  the missing value is not identical to the expected value.

The last point makes typos dangerous:

```json
{
  "tool.argumnts.approved": {
    "ne": true
  }
}
```

`tool.argumnts.approved` passes solution-path validation, resolves to
`undefined`, and therefore matches `ne: true`. Do not assume an unknown path
simply produces a no-match. Test both present and absent input for every `ne`
condition.

## 6. Use operators according to their exact semantics

| Operator                 | Expected value      | Match behavior                                                                                                                            |
| ------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `eq`                     | primitive           | `Object.is(runtimeValue, expected)`. Types must match. A missing value does not match.                                                    |
| `ne`                     | primitive           | Negation of `Object.is`. A missing value usually matches.                                                                                 |
| `gt`, `lt`, `gte`, `lte` | finite number       | Both values must be numbers; then normal numeric comparison is used.                                                                      |
| `in`                     | array of primitives | The entire runtime value must equal one array member. This is not array intersection. An empty expected array is valid and never matches. |
| `contains`               | primitive           | Case-sensitive substring for two strings, or exact primitive membership when the runtime value is an array.                               |
| `regex-match`            | string              | Runs a native JavaScript `RegExp` against a runtime string.                                                                               |
| `glob-match`             | string              | Case-sensitive full-string match. `*` means any sequence and `?` means one character; other regex metacharacters are escaped.             |

Several operators on one path are also AND-combined:

```json
{
  "model.totalTokens": {
    "gte": 1000,
    "lt": 8000
  }
}
```

Important limitations:

- there is no `OR`, `NOT`, `exists`, arithmetic, aggregation, or cross-field
  comparison;
- use `in` for alternatives over one scalar field;
- use separate rules when either condition should independently lead to the
  same action;
- use a custom handler for more complex logic;
- `contains` and `glob-match` are case-sensitive;
- context `regex-match` has no flags field and no runtime timeout; and
- context regex is native JavaScript regex, not RE2. Policy authors are trusted
  and must avoid catastrophic backtracking.

The validator rejects unknown operators, empty operator objects, non-finite
operands for numeric range operators, and invalid context regex syntax.

## 7. Design explicit allow and deny rules

### Permit a tool call

The manifest first proves that the tool is registered and assigned to the
agent. The policy then grants contextual permission:

```json
{
  "name": "solution-allow-support-customer-lookup",
  "level": "solution",
  "checkpoint": "tool_call",
  "priority": 200,
  "enabled": true,
  "condition": {
    "agent.agentKey": {
      "eq": "support-agent"
    },
    "tool.key": {
      "eq": "lookup-customer"
    }
  },
  "action": "allow",
  "reason": "The support agent may use the customer lookup tool."
}
```

Do not omit the manifest assignment merely because this rule exists. The hard
gate will still deny the call.

### Permit a handoff

The manifest proves that the target exists; the rule defines the permitted
route:

```json
{
  "name": "solution-allow-support-to-escalation",
  "level": "solution",
  "checkpoint": "handoff",
  "priority": 200,
  "enabled": true,
  "condition": {
    "agent.agentKey": {
      "eq": "support-agent"
    },
    "handoff.agentKey": {
      "eq": "escalation-agent"
    }
  },
  "action": "allow",
  "reason": "Support cases may be handed to the registered escalation agent."
}
```

### Deny a risky argument

```json
{
  "name": "solution-deny-destructive-storage-operation",
  "level": "solution",
  "checkpoint": "tool_call",
  "priority": 700,
  "enabled": true,
  "condition": {
    "tool.key": {
      "eq": "manage-storage"
    },
    "tool.arguments.operation": {
      "in": ["delete", "purge"]
    }
  },
  "action": "deny",
  "reason": "Destructive storage operations require an out-of-band workflow."
}
```

Give a specific deny a higher priority than ordinary solution permits. A
solution deny does not automatically override a higher-priority permit.

### Request audit or warning handling

```json
{
  "name": "solution-audit-support-model-result",
  "level": "solution",
  "checkpoint": "model_result",
  "priority": 200,
  "enabled": true,
  "condition": {
    "agent.agentKey": {
      "eq": "support-agent"
    }
  },
  "action": "audit",
  "reason": "Support-agent model results require an audit record."
}
```

`allow`, `audit`, and `warn` all produce `allowed: true`.

Every `evaluate` call reports to the governance microservice on its own: an
audit event for supported checkpoints, plus a violation record when a bundle
rule won and its action is not `allow`. That reporting is the SDK's, and the
backend does not need to reproduce it. Note that reporting is narrower than
enforcement — a checkpoint-default deny is enforced but not reported, because no
rule won. See
[Decision reporting](03-backend-integration.md#decision-reporting-is-the-sdks-job)
and [what is not reported](03-backend-integration.md#what-is-deliberately-not-reported).

What the SDK does **not** do is act on the decision. It does not emit a warning
event, display a warning, pause for approval, or run any application workflow
the rule implies. The application must interpret the winning action and
implement those effects. A context rule with action `audit` does not
automatically produce `auditData`.

## 8. Account for conflict resolution

The evaluator does not stop after the first matching rule. It evaluates every
enabled applicable rule, collects candidates, and orders them by:

1. higher numeric `priority`;
2. `enterprise` before `solution` when priority is equal; and
3. rule `name` using `localeCompare` when both are equal.

It then resolves candidates with one additional guardrail:

1. if any matching candidate is an enterprise `deny`, the first ordered
   enterprise deny wins regardless of every candidate's priority;
2. otherwise, the first ordered candidate wins.

Consequences:

| Matches                                                 | Result                                                            |
| ------------------------------------------------------- | ----------------------------------------------------------------- |
| Solution allow at priority 200; solution deny at 100    | The allow wins. Deny is not generally dominant.                   |
| Enterprise allow and solution deny at the same priority | The enterprise allow wins the tie.                                |
| Solution deny at 500; enterprise allow at 200           | The solution deny wins. Enterprise level alone does not dominate. |
| Enterprise deny at priority 1; solution allow at 1000   | The enterprise deny wins.                                         |

`conflictDetected` is true only when the candidate set contains both a `deny`
and at least one permitting action (`allow`, `audit`, or `warn`). It does not
change the winner. `matchedRules` contains every candidate in resolution order;
`matchedRule` names the winner.

All applicable custom handlers and validation rules can run before resolution.
A handler exception, detector failure, or other evaluation exception returns an
immediate fail-closed deny rather than resolving already collected candidates.
Keep handlers bounded, deterministic, and independent of fragile remote
services.

Priority is shared across all non-enterprise-deny candidates in the active
bundle. Keep every priority within `1`–`1000`, establish a documented
whole-number convention with the control-plane owners, and test solution rules
together with the enterprise rules that will be deployed.

## 9. Use usage rules with their runtime limits

A call-count limit can be expressed as a deny that outranks the normal permit:

```json
{
  "name": "solution-deny-after-five-customer-lookups",
  "level": "solution",
  "checkpoint": "tool_call",
  "priority": 700,
  "enabled": true,
  "condition": {
    "tool.key": {
      "eq": "lookup-customer"
    },
    "usage.perToolCallCount": {
      "gte": 5
    }
  },
  "action": "deny",
  "reason": "This session has reached the customer lookup limit."
}
```

Usage is a snapshot taken before the current evaluation. The host must record
an allowed operation:

```ts
const decision = await governance.policyEngine.evaluate({
  sessionId,
  checkpoint: "tool_call",
  agent: { agentDid },
  tool: { toolDid, arguments: toolArguments }
});

if (!decision.allowed) {
  throw new Error(decision.reason);
}

governance.policyEngine.recordToolCall(sessionId, toolDid, agentDid);
const result = await invokeTool(toolArguments);
```

With the `gte: 5` rule above and correct recording, five prior calls are
permitted and the sixth evaluation is denied. Record after permission is
granted and immediately before dispatch, so a failed policy check is not
counted and a dispatched operation is not omitted.

Equivalent host calls are:

- `recordToolCall(sessionId, toolDid, agentDid)`;
- `recordModelCall(sessionId, agentDid)`; and
- `recordTurn(sessionId)`.

Current runtime limitations are security-significant:

- `initializeGovernanceSDK` creates an in-memory tracker;
- counters are process-local, are lost on restart, and are not shared across
  replicas;
- the same tracker is retained when a bundle refresh succeeds;
- evaluation and recording are separate operations, not an atomic
  evaluate-and-reserve transaction; and
- concurrent calls can observe the same count and all pass.

These counters are suitable for process-local governance signals, not a hard
distributed quota. Although low-level `UsageStore` and `SessionUsageTracker`
types are public, ordinary SDK initialization does not currently accept an
external shared store.

Likewise, token and cost limits use host-supplied `model.*` values; the SDK
does not read a provider bill or tokenizer.

## 10. Implement custom rules safely

For the custom rule shown earlier, register a handler with the same name:

```ts
import type { CustomPolicyHandler } from "@zbrain/governance-sdk";

export const highValueTransferHandler: CustomPolicyHandler = {
  validateConfig(config) {
    if (
      typeof config.maximumAmount !== "number" ||
      !Number.isFinite(config.maximumAmount) ||
      config.maximumAmount < 0
    ) {
      throw new Error("maximumAmount must be a non-negative finite number");
    }

    if (typeof config.currency !== "string" || config.currency.length === 0) {
      throw new Error("currency must be a non-empty string");
    }
  },

  evaluate({ context, config }) {
    const argumentsValue = context.tool?.arguments;
    const amount = argumentsValue?.amount;
    const currency = argumentsValue?.currency;

    return {
      matched:
        typeof amount === "number" &&
        amount > Number(config.maximumAmount) &&
        currency === config.currency,
      auditData: {
        policyCheck: "high-value-transfer"
      }
    };
  }
};
```

Register it during SDK initialization:

```ts
const governance = await initializeGovernanceSDK({
  callbacks,
  manifestPath,
  customPolicyHandlers: {
    "solution-deny-high-value-transfer": highValueTransferHandler
  }
});
```

Custom handler behavior is exact:

- lookup is by rule name, not by kind, checkpoint, or another identifier;
- `validateConfig` can be synchronous or asynchronous;
- `evaluate` can be synchronous or asynchronous;
- the handler receives the enriched `PolicyContext`, normalized rule, and
  static config;
- a custom rule has no declarative `condition`; perform any preliminary
  matching inside `evaluate`;
- a missing handler or an exception fails the evaluation closed;
- the handler's `matched` and `auditData` result is trusted at runtime rather
  than schema-validated; and
- only the winning candidate's `auditData` is returned.

`auditData` must be JSON-compatible, caller-safe, and non-secret. The
`validationType` key is reserved for built-in validation audit records.

The bundle loader requires a valid handler and runs `validateConfig` for every
custom rule, including a disabled one. Register handlers before initial bundle
validation and keep them compatible with every config version the control
plane may deliver.

## 11. Configure prompt-injection validation precisely

### Available checks

The detector recognizes these category names:

| Check                 | Intended signal family                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `directOverride`      | Attempts to ignore, replace, or supersede governing instructions; also activates configured blocklist matching. |
| `delimiterAttack`     | Fake instruction delimiters or control-block boundaries.                                                        |
| `encodingAttack`      | Supported encoded or escaped instruction payloads.                                                              |
| `rolePlay`            | Attempts to obtain privileged behavior through role or identity substitution.                                   |
| `contextManipulation` | Attempts to alter trusted context, memory, tools, or instruction hierarchy.                                     |
| `canaryLeak`          | Exact leakage of a trusted local canary token.                                                                  |
| `multiTurnEscalation` | Staged attempts to build toward restricted behavior across conversational framing.                              |

`condition` must contain only `checks`, and `checks` must contain only the `in`
operator. The `checks.in` array must be non-empty, duplicate-free, and limited
to the names above.

These are deterministic, heuristic checks. Text is normalized for case, width,
diacritics, selected confusables, invisible/control characters, and guarded
compact or leetspeak forms. Some supported encoded forms are decoded. Built-in
findings in clearly analytical quoted discussions can be suppressed.

This is not a semantic classifier and is not a complete prompt-injection
defense. Novel paraphrases, unsupported languages, and new attack forms can
bypass pattern detection. The repository's
[benchmark notes](../../test/benchmarks/README.md) describe the synthetic AGT
corpus, performance targets, and limitations.

### Checkpoint and provenance routing

The same validation rule is routed according to this fixed contract:

| Runtime checkpoint                  | Text inspected                                                                                             | Checks that can run         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------- |
| `agent_start`                       | `agent.userMessage`, automatically labeled `user_message`. Explicit `governedTexts` is ignored here.       | Every selected check.       |
| `model_call`                        | Explicit `governedTexts` with source `user_message`, `tool_result`, or `retrieved_content`.                | Every selected check.       |
| `tool_result`                       | Explicit `governedTexts` with source `tool_result` or `retrieved_content`. Tool arguments are not scanned. | Every selected check.       |
| `model_result`                      | Explicit `governedTexts` with source `model_output`.                                                       | Only selected `canaryLeak`. |
| `tool_call`, `agent_end`, `handoff` | No validation routing.                                                                                     | None.                       |

At `model_call`, `tool_result`, and `model_result`, each segment must preserve
its origin:

```ts
await governance.policyEngine.evaluate({
  sessionId,
  checkpoint: "model_call",
  agent: { agentDid },
  governedTexts: [
    { source: "user_message", content: userMessage },
    { source: "retrieved_content", content: retrievedDocument }
  ]
});
```

When an applicable rule has active checks:

- omitted or empty text produces no validation candidate, so other rules or the
  checkpoint default decide;
- a provided non-string content value or disallowed source fails closed;
- each supplied segment is scanned and results are aggregated;
- a detector failure or regex scan timeout immediately fails closed and cannot
  be overridden by another policy; and
- a clean result does not match the validation rule.

A `model_result` rule that selects only `directOverride`, for example, has no
active check at that checkpoint. Model output is deliberately limited to
canary leakage detection.

### Rule action

For ordinary prompt-injection findings, the rule's action applies:

- `deny` blocks if that candidate wins;
- `warn` permits if that candidate wins and asks the host to surface or record
  the warning; and
- `audit` permits if that candidate wins and asks the host to persist an audit.

`allow` is invalid for a validation rule.

Canary detection converts that validation candidate to `deny` even when the
configured action is `warn` or `audit`. Candidate resolution still happens
afterward. A solution-level canary deny can therefore lose to a
higher-priority permit. An enterprise-level canary candidate becomes an
enterprise deny and receives the enterprise-deny override. Choose priorities
and tests accordingly; do not describe solution canary detection as an
unconditional block.

### Validation config reference

`config` customizes one validation rule's detector. It is optional; omitting it
or setting it to `{}` uses the SDK's built-in behavior for the rule's selected
`condition.checks.in`.

Keep the four controls distinct:

- `condition.checks.in` selects the detector categories that may run;
- `config` customizes this rule's selected categories;
- `action` determines the candidate action when a selected check finds a
  signal; and
- `initializeGovernanceSDK({ promptInjection: { canaryTokens } })` supplies
  trusted runtime canary secrets outside the policy document.

The exact shape is:

```ts
interface PromptInjectionPolicyConfig {
  blocklist?: readonly string[];
  allowlist?: readonly string[];
  additionalPatterns?: Readonly<Partial<Record<PromptInjectionType, readonly string[]>>>;
}
```

| Field                | Type and default                    | Effect                                                                                                                                              |
| -------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `blocklist`          | Optional string array; default `[]` | Adds normalized literal indicators to this rule. Evaluated only when `directOverride` is present in `condition.checks.in`.                          |
| `allowlist`          | Optional string array; default `[]` | Suppresses an otherwise detected finding only when an allowlisted text span overlaps that finding's span.                                           |
| `additionalPatterns` | Optional object; default `{}`       | Adds RE2 patterns by prompt-injection category. A category must also be selected in `condition.checks.in`; configuring it does not activate it.     |

These are the only accepted keys. An unknown `config` field rejects the
bundle. `canaryTokens` is deliberately not part of this schema; canaries are
trusted runtime configuration described in
[Trusted canary tokens](#trusted-canary-tokens).

A complete configured validation rule looks like this:

```json
{
  "name": "solution-deny-prompt-injection",
  "level": "solution",
  "kind": "validation",
  "checkpoint": "validation_lifecycle",
  "priority": 900,
  "enabled": true,
  "condition": {
    "checks": {
      "in": ["directOverride", "contextManipulation"]
    }
  },
  "config": {
    "blocklist": ["internal override marker"],
    "allowlist": ["quoted security training example"],
    "additionalPatterns": {
      "directOverride": ["replace\\s+the\\s+governing\\s+policy"],
      "contextManipulation": ["rewrite\\s+trusted\\s+memory"]
    }
  },
  "action": "deny",
  "reason": "Prompt-injection indicators are not permitted."
}
```

Configuration behavior and validation constraints:

- blocklist entries are normalized literal matches with token boundaries;
- the blocklist runs only when `directOverride` is selected;
- a generic blocklist phrase also needs surrounding malicious-intent context,
  so this is not a general banned-word feature;
- allowlisting is span-scoped: it suppresses a finding only when the allowlist
  span overlaps that finding;
- it does not suppress a later attack elsewhere in the same input;
- findings without a reliable span, including canary and some obfuscated
  findings, cannot be allowlisted;
- analytical quoted-text suppression applies only to eligible built-in
  findings, not additional custom patterns;
- additional patterns are additive to built-in checks and do not enable their
  category by themselves;
- allowed category keys are `directOverride`, `delimiterAttack`,
  `encodingAttack`, `rolePlay`, `contextManipulation`, `canaryLeak`, and
  `multiTurnEscalation`;
- blocklist and allowlist arrays may be empty;
- each configured additional-pattern category must contain a non-empty array;
- additional patterns use RE2-compatible syntax with case-insensitive,
  multiline, and Unicode behavior and run against the raw input text;
- a pattern cannot match the empty string, must contain at least three
  non-whitespace characters, cannot exceed 1,000 Unicode scalar characters,
  and must be exact-string unique within its category;
- blocklist and allowlist entries need at least three normalized
  non-whitespace characters and must be unique after normalization; and
- `canaryTokens` is not a valid policy config key.

If `canaryLeak` is selected, local canary tokens are still required even when
`additionalPatterns.canaryLeak` is configured. Any match categorized as
`canaryLeak`, including an additional pattern in that category, is converted
to a deny candidate.

Configuration is isolated per validation rule. An allowlist or additional
pattern on one solution rule does not alter another solution or enterprise
validation rule. Disabled validation rules do not construct detectors, but
their config is still validated when the bundle is loaded.

The current implementation has no configured cap on total blocklist entries,
allowlist entries, additional-pattern count, governed-text segment count, or
overall input length. Apply operational limits before untrusted content reaches
the evaluator. Regex scanning checks a 200 ms elapsed-time budget and fails
closed on timeout.

### Trusted canary tokens

Canaries are runtime secrets and must remain outside policy JSON:

```ts
const governance = await initializeGovernanceSDK({
  callbacks,
  manifestPath,
  promptInjection: {
    canaryTokens: [process.env.SYSTEM_PROMPT_CANARY!]
  }
});
```

Canary matching is an exact, case-sensitive substring check. Each token must
contain at least three non-whitespace characters and tokens must be unique.
There is currently no token-count or token-length cap.

An enabled validation rule selecting `canaryLeak` requires at least one local
canary token when the evaluator is constructed. Missing or invalid tokens fail
initialization; during refresh, they reject the new engine and leave the
previous bundle active. A disabled canary rule is structurally
bundle-validated but does not construct a detector and therefore does not
require tokens until enabled.

### Safe validation audit data

When a validation candidate wins, `auditData` contains:

```text
validationType
policyName
isInjection
matchedTypes
matchedPatternKeys
detectorFailed
inputHash
inputLengthCharacters
reason
```

It contains hashes and built-in names rather than raw governed text, custom
pattern bodies, or canary values. It does not contain confidence, severity, or
threat scores. Multiple text segments are aggregated with deduplicated,
deterministically ordered finding keys.

## 12. Understand bundle validation and activation

A runtime bundle has this shape:

```ts
interface GovernanceBundle {
  version: string;
  hash: string;
  rules: readonly PolicyRule[];
}
```

The validator requires:

- a non-array object;
- non-empty `version` and `hash`;
- a `rules` array, which may be empty;
- unique, non-empty rule names across enterprise and solution rules;
- all common rule fields with valid types;
- a supported concrete checkpoint for context/custom rules;
- exact `validation_lifecycle` placement for validation rules;
- valid operator values and condition structure;
- a JSON object config and registered handler for custom rules; and
- strict validation condition and config shapes for prompt-injection rules.

Duplicate names are checked case-sensitively. Disabled rules are still
validated. Only the `level` value is case-normalized; do not rely on casing
normalization for action, kind, checkpoint, operator, or validation check
names.

The validator is not a closed-schema parser for ordinary bundle and context
rule objects: several unknown top-level or rule fields are currently ignored.
Prompt-injection config is strict. Author only the exported schema and never
treat acceptance of an extra field as evidence that it has runtime meaning.
Likewise, its finite-number check for `priority` is weaker than the
governance-service contract; author and register only values from `1` through
`1000`.

Activation behavior is fail-closed:

- an invalid initial bundle causes startup failure and process exit with status
  1;
- a refresh validates the bundle and constructs the next engine before
  replacing the current one;
- a failed manual refresh rejects and keeps the last active engine;
- a failed scheduled refresh is logged and keeps the last active engine; and
- usage counters survive a successful refresh because the same in-memory
  tracker is reused.

## 13. Handle `PolicyDecision` correctly

Every evaluation returns:

```ts
interface PolicyDecision {
  allowed: boolean;
  action: "allow" | "audit" | "warn" | "deny";
  checkpoint: PolicyCheckpoint;
  matchedRule?: string;
  /** Governance-microservice `_id` of the winning rule, when the bundle has one. */
  matchedRuleId?: string;
  /** Authority level of the winning rule. */
  matchedRuleLevel?: PolicyLevel;
  matchedRules: readonly string[];
  conflictDetected: boolean;
  resolutionTrace: readonly string[];
  reason: string;
  auditData?: PolicyAuditData;
}
```

Host behavior should be:

1. stop before the governed operation when `allowed` is false;
2. persist the decision through the application's approved audit sink;
3. implement visible or operational handling for winning `warn` and `audit`
   actions;
4. keep `reason` and custom-handler errors free of secrets because evaluation
   errors can become caller-facing deny reasons; and
5. inspect `matchedRules` and `resolutionTrace` when diagnosing conflicts.

`matchedRule` is absent not only for a no-match default, but also for manifest
authorization denial and fail-closed evaluation errors. `auditData`, when
present, belongs only to the winning candidate or the immediate validation
failure.

For the common throw-on-denial pattern, use
[`requireAllowed`](../../src/core/enforcement.ts):

```ts
const decision = await requireAllowed(governance.policyEngine, sessionId, {
  checkpoint: "tool_call",
  agent: { agentDid },
  tool: { toolDid, arguments: toolArguments }
});

if (decision.action === "audit") {
  await auditSink.write(decision);
}
```

`requireAllowed` throws `GovernanceDeniedError` only when `allowed` is false.
The error retains the full decision. It does not implement audit or warning
side effects.

## 14. Test the policy set before registration

Validate an authoring document by adding a test-only bundle hash:

```ts
import {
  validateGovernanceBundle,
  type CustomPolicyHandler,
  type GovernanceBundle,
  type PolicyRule
} from "@zbrain/governance-sdk";

interface PolicyAuthoringDocument {
  version: string;
  rules: readonly PolicyRule[];
}

export async function validatePolicies(
  document: PolicyAuthoringDocument,
  customPolicyHandlers: Readonly<Record<string, CustomPolicyHandler>>
): Promise<void> {
  const testBundle: GovernanceBundle = {
    version: document.version,
    hash: "test-only-non-empty-hash",
    rules: document.rules
  };

  await validateGovernanceBundle(testBundle, customPolicyHandlers);
}
```

Then test through `GovernancePolicyEngine` with the real manifest. At minimum,
cover:

- every intended permit at `tool_call` and `handoff`;
- a near-miss for every permit, such as wrong agent, wrong tool, or wrong
  target;
- unknown agent/tool/target DIDs, and omitted tool/target DIDs (an omitted
  `agent` is a compile error, since it is required on `PolicyContextInput`);
- every deny threshold immediately below, at, and above its boundary;
- missing optional context fields, especially every path using `ne`;
- all expected priority conflicts, including enterprise policies;
- disabled rules;
- handler config validation, match, no-match, and thrown-error behavior;
- prompt-injection inputs at every supported checkpoint and provenance;
- empty, malformed, benign, malicious, and large validation inputs;
- canary leakage with the same priority environment used in production;
- no-match checkpoint defaults; and
- exact decision fields the host depends on.

The repository tests demonstrate the intended seams:

- [context and manifest enrichment](../../test/policy-engine/context.test.ts);
- [resolution and defaults](../../test/policy-engine/resolution.test.ts);
- [custom policies](../../test/policy-engine/custom-policy.test.ts);
- [prompt-injection policy routing](../../test/policy-engine/prompt-injection-policy.test.ts);
- [detector behavior](../../test/policy-engine/prompt-injection-detector.test.ts);
- [manifest-backed enforcement](../../test/core/manifest-authorization.test.ts).

## 15. Policy authoring workflow

Use this sequence for each solution:

1. **Start from the registered manifest.** Load the reviewed Phase 1 artifact
   and identify the exact fields each policy will use.
2. **Inventory boundaries.** List every agent start, model call, tool call,
   tool result, model result, agent end, and handoff the backend actually
   performs.
3. **Add explicit permits.** Cover each legitimate tool call and handoff,
   remembering their default deny behavior.
4. **Add prohibitions and limits.** Give specific solution denies priorities
   that outrank ordinary solution permits.
5. **Add validation.** Map every untrusted text source to the precise supported
   checkpoint and provenance label.
6. **Use custom handlers sparingly.** Prefer declarative rules for reviewability;
   use code when the operator model cannot express the policy.
7. **Define host obligations.** Decide where decisions are logged and how
   `audit`, `warn`, and `deny` are surfaced.
8. **Test the combined bundle.** Include enterprise rules and production-like
   handler/canary configuration.
9. **Register the reviewed policies.** The developer or coding agent submits
   the authoring document through the governance service's developer-facing
   registration workflow. A local policy file is not activated or uploaded by
   the runtime SDK.
10. **Observe refreshes.** Alert on failed registration, invalid bundles,
    handler incompatibility, and repeated detector failure.

## 16. Current non-features and boundaries

Do not design policies on assumptions the current SDK does not implement:

- no local `solution-policy.json` loading;
- no developer policy-registration CLI or API wrapper in this repository;
- no bundle hash or signature verification in `validateGovernanceBundle`;
- no SDK bundle-validation enforcement of the `1`–`1000` priority range;
- no local authorization proving that a rule labeled `enterprise` was
  enterprise-authored;
- no automatic handling of a winning `audit` or `warn` action, and no warning
  UI (the decision is reported to the governance service, but acting on it is
  the application's job);
- no automatic usage recording;
- no distributed or atomic quota enforcement;
- no `OR`, `NOT`, `exists`, cross-field expression, or array-index condition
  language;
- no timeout for context-rule JavaScript regex;
- no general prompt-injection input-size or list-count limits; and
- no guarantee that heuristic prompt-injection detection catches novel attacks.

Treat these as integration responsibilities or explicit risk acceptances, not
as undocumented SDK behavior.

## Completion checklist

- [ ] Every rule is `level: "solution"` unless it is supplied by the trusted
      enterprise control plane.
- [ ] Every `tool_call` and `handoff` that should proceed has a narrow,
      test-covered permit.
- [ ] Manifest authorization and policy authorization agree.
- [ ] Every condition path exists in the actual enriched context.
- [ ] Missing-value behavior is tested for every `ne` operator.
- [ ] Every priority is between `1` and `1000`, inclusive.
- [ ] Priority conflicts are tested against the complete deployed bundle.
- [ ] `audit` and `warn` have host-side effects.
- [ ] Usage rules account for manual recording, concurrency, restarts, and
      replicas.
- [ ] Custom handlers are registered by exact name and fail safely.
- [ ] Governed text is supplied at a supported checkpoint with valid
      provenance.
- [ ] Canary tokens remain local and secret.
- [ ] Validation false positives, bypass limitations, and input limits have
      operational controls.
- [ ] A developer or coding agent registers the reviewed authoring document
      with the governance service; it is not mistaken for an SDK-loaded file.
