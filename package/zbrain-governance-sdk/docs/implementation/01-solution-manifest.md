# Phase 1: Write and Register the Solution Manifest

## Goal

During development, a developer or coding agent creates the solution manifest
from the application that will actually be deployed, validates it together
with the solution policies, and registers the reviewed manifest with
Governance.

The primary deliverable is a source-controlled `solution-manifest.json`. It is
both:

- the development-time inventory registered with Governance; and
- the runtime trust inventory loaded by the SDK from `manifestPath`.

This guide follows the behavior implemented by the current
[manifest types](../../src/manifest/solution-manifest.ts),
[agent definition](../../src/manifest/agent-defination.ts),
[tool definition](../../src/manifest/tool-defination.ts),
[context resolver](../../src/policy-engine/context.ts), and
[manifest-backed policy engine](../../src/core/index.ts).

## 1. Understand the development and runtime lifecycle

Development-time manifest registration and runtime deployment registration are
separate operations:

```text
developer or coding agent
        |
        | inspect the application during development
        v
solution-manifest.json
        |
        | validate with policies and register with Governance
        v
registered solution inventory

deployed application packages the same manifest
        |
        | initializeGovernanceSDK({ manifestPath })
        v
SDK parses manifest and computes manifestHash
        |
        | runtime deployment registration sends both
        | solutionManifest and manifestHash
        v
Governance returns the active policy bundle
        |
        v
manifest-backed local enforcement
```

Unlike the solution policy authoring file, the runtime SDK **does** load the
manifest file. Keep the registered development artifact and the packaged
runtime artifact identical.

This repository does not currently provide a developer-facing manifest
registration command or API wrapper. The developer or coding agent must use
the Governance registration workflow supplied outside this SDK. Runtime
deployment registration is implemented by the SDK, but it is not a substitute
for the development review and registration step.

## 2. Use the exact manifest shape

The complete public contract is:

```ts
interface SolutionManifest {
  agents: readonly AgentDefinition[];
  tools: readonly ToolDefinition[];
  capabilities: readonly string[];
  resources: readonly string[];
}

interface AgentDefinition {
  agentKey: string;
  capabilities: readonly string[];
  tools: readonly string[];
  name: string;
  agentDid: string;
  riskTier: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "MINIMAL";
  riskScore: number;
  metadata?: Readonly<Record<string, unknown>>;
}

interface ToolDefinition {
  key: string;
  capability: string;
  resources: readonly string[];
  category: "read" | "write" | "execute" | "communicate" | "delete" | "other";
  riskTier: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "MINIMAL";
  toolDid: string;
  metadata?: Readonly<Record<string, unknown>>;
}
```

All four root arrays are required, even when one is empty. The manifest has no
`version`, `hash`, `solutionId`, deployment ID, policy list, callback URL, or
environment field. The runtime receives `solutionId` and deployment data from
SDK configuration, and computes `manifestHash` separately.

A complete example is:

```json
{
  "agents": [
    {
      "agentKey": "support-agent",
      "agentDid": "did:zbrain:customer-support:agent:support",
      "name": "Customer Support Agent",
      "capabilities": ["support.answer", "customer.lookup"],
      "tools": ["did:zbrain:customer-support:tool:lookup-customer"],
      "riskTier": "MEDIUM",
      "riskScore": 0.3,
      "metadata": {
        "owner": "customer-support",
        "dataDomain": "customer-records"
      }
    }
  ],
  "tools": [
    {
      "key": "lookup-customer",
      "toolDid": "did:zbrain:customer-support:tool:lookup-customer",
      "capability": "customer.lookup",
      "resources": ["crm.customers"],
      "category": "read",
      "riskTier": "MEDIUM",
      "metadata": {
        "dataClassification": "confidential"
      }
    }
  ],
  "capabilities": ["support.answer", "customer.lookup"],
  "resources": ["crm.customers"]
}
```

The SDK currently has no `validateSolutionManifest` function. Its loader reads
UTF-8 JSON and casts the parsed value to `SolutionManifest`; it does not
validate this schema. The development workflow and Governance registration
must therefore reject malformed shapes before deployment.

## 3. Inventory deployed code, not planned features

Build the manifest by reading the code paths that can execute:

- application and worker entrypoints;
- framework agent definitions;
- model-facing agent or workflow nodes;
- tool registries and tool factories;
- agent-to-tool bindings;
- delegation and handoff routes;
- resource clients, data stores, queues, and external APIs;
- feature flags that can expose an agent or tool in the target release; and
- custom policy handlers that depend on manifest metadata.

Declare an entity only when the deployed application can invoke it. Do not add
future agents, speculative tools, unused capabilities, or broad resource
access “just in case.”

For each invocation boundary, answer:

1. Which stable agent identity is executing?
2. Which stable tool identity can it call?
3. What capability does the code actually implement?
4. Which resources can the operation read, modify, execute against, disclose
   to, or delete?
5. What is the operation's externally observable effect?
6. What risk classification and non-secret metadata do policies need?

A coding agent should derive these facts from executable registrations and
call sites, not from README descriptions alone.

## 4. Choose stable and unambiguous identities

The manifest has five identity-like fields:

| Field        | Purpose                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------- |
| `agentDid`   | Runtime security identity used to resolve and authorize the calling agent.               |
| `agentKey`   | Stable, human-readable agent identifier commonly used in solution policy conditions.     |
| agent `name` | Human-readable name also exposed to solution policy context.                             |
| `toolDid`    | Runtime security identity used to resolve a tool and enforce the agent's tool allowlist. |
| tool `key`   | Stable, human-readable tool identifier commonly used in solution policy conditions.      |

Use a predictable DID convention:

```text
did:zbrain:<solution>:agent:<agent-key>
did:zbrain:<solution>:tool:<tool-key>
```

For example:

```text
did:zbrain:customer-support:agent:support
did:zbrain:customer-support:tool:lookup-customer
```

This is an authoring convention, not an SDK parser requirement. The
implementation treats DIDs as exact, case-sensitive strings. It does not
validate the `did:zbrain:` prefix, normalize case, trim whitespace, or check
the number of segments.

Identity rules for development:

- use non-empty values even though the loader does not enforce them;
- keep DIDs stable across restarts, releases, environments, and framework
  migrations;
- do not include deployment IDs, pod names, environments, random instance
  UUIDs, framework names, or software versions;
- define runtime DIDs once as application constants and reuse them at every
  governance boundary;
- keep `agentKey` and tool `key` stable because policy conditions depend on
  their exact spelling; and
- change a DID only when the security identity or authority truly changes.

### Duplicate identity hazards

The SDK builds agent and tool lookup maps directly from the arrays. Duplicate
DIDs are not rejected. When two agents share an `agentDid`, or two tools share
a `toolDid`, the later array entry silently replaces the earlier entry in the
runtime lookup map.

Duplicate `agentKey` or tool `key` values are also not rejected. They do not
control lookup, but they make key-based policy conditions ambiguous because
multiple runtime identities can produce the same policy fact.

Require:

- globally unique DIDs;
- unique agent keys within `agents`;
- unique tool keys within `tools`; and
- no duplicate values within capability, resource, or agent-tool arrays.

Array order should never decide identity. Treat any duplicate as a registration
error.

## 5. Author agent definitions

Each agent entry has:

| Field          | Required authoring meaning                                                        |
| -------------- | --------------------------------------------------------------------------------- |
| `agentKey`     | Stable policy-facing key for this agent.                                          |
| `agentDid`     | Exact DID the backend supplies on every governed boundary executed by this agent. |
| `name`         | Non-secret human-readable name.                                                   |
| `capabilities` | Capabilities the agent's implemented logic can exercise.                          |
| `tools`        | Exact `toolDid` values this agent is authorized to request.                       |
| `riskTier`     | One uppercase risk tier: `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`, or `CRITICAL`.       |
| `riskScore`    | Organization-defined numeric score. The SDK imposes no range or scale.            |
| `metadata`     | Optional JSON object containing non-secret facts required by solution policies.   |

Example:

```json
{
  "agentKey": "support-agent",
  "agentDid": "did:zbrain:customer-support:agent:support",
  "name": "Customer Support Agent",
  "capabilities": ["support.answer", "customer.lookup"],
  "tools": [
    "did:zbrain:customer-support:tool:lookup-customer",
    "did:zbrain:customer-support:tool:create-support-ticket"
  ],
  "riskTier": "MEDIUM",
  "riskScore": 0.3,
  "metadata": {
    "owner": "customer-support",
    "region": "global"
  }
}
```

### `tools` is a hard authorization allowlist

At `tool_call`, the manifest-backed engine requires:

1. the calling `agentDid` to exist;
2. the requested `toolDid` to exist; and
3. the requested `toolDid` to appear in that agent's `tools` array.

A permitting policy cannot bypass these checks. Give each agent only the tools
its implementation needs.

The values in `tools` are tool DIDs, not tool keys. A typo or a key placed in
this array does not resolve to the intended tool.

### Capabilities are policy facts, not hard permissions

`agent.capabilities` is copied into policy context. The engine does not compare
an agent capability to a tool capability during hard authorization. If that
relationship is required, enforce it during manifest validation or with a
policy/custom handler.

### Define one risk-score scale

The TypeScript contract says only `number`; the loader does not check
finiteness, range, or agreement between `riskScore` and `riskTier`. JSON itself
cannot encode `NaN` or infinity, but it can encode negative or arbitrarily
large values.

Define one Governance-approved scale, document its tier thresholds, and use it
consistently across every solution. Do not infer a scale from repository
fixtures or tests.

## 6. Author tool definitions

Each tool entry has:

| Field        | Required authoring meaning                                         |
| ------------ | ------------------------------------------------------------------ |
| `key`        | Stable policy-facing key matching the application's tool registry. |
| `toolDid`    | Exact DID supplied when the tool is evaluated.                     |
| `capability` | One primary capability implemented by the tool.                    |
| `resources`  | Every security-relevant resource the tool can access or affect.    |
| `category`   | The tool's primary effect category.                                |
| `riskTier`   | One uppercase risk tier.                                           |
| `metadata`   | Optional JSON object containing non-secret policy facts.           |

Example:

```json
{
  "key": "create-support-ticket",
  "toolDid": "did:zbrain:customer-support:tool:create-support-ticket",
  "capability": "support.ticket.create",
  "resources": ["ticketing.tickets"],
  "category": "write",
  "riskTier": "MEDIUM",
  "metadata": {
    "dataClassification": "internal",
    "system": "ticketing"
  }
}
```

Tool categories are exact lowercase values:

| Category      | Use when the primary externally observable effect is                                        |
| ------------- | ------------------------------------------------------------------------------------------- |
| `read`        | Reading without intentionally changing state.                                               |
| `write`       | Creating or modifying state.                                                                |
| `execute`     | Starting code, jobs, workflows, or other active operations.                                 |
| `communicate` | Sending or publishing information to another party or system.                               |
| `delete`      | Deleting or irreversibly removing state.                                                    |
| `other`       | No listed category describes the effect; document the choice in metadata and policy review. |

Classify by effect, not transport:

- an HTTP `GET` that starts a job is `execute`;
- an HTTP `POST` that performs a read-only search can be `read`;
- publishing a message is `communicate`;
- a soft-delete endpoint is still `delete` when users experience removal; and
- a tool with several effects should use its highest-consequence primary
  category and expose additional facts through capability, resources, or
  metadata.

A tool has one `capability`, one `category`, and one `riskTier`, but can list
multiple `resources`. There is no tool `name` or `riskScore` field in the
current schema.

Tool capability, resources, category, and risk tier become policy facts. They
do not independently authorize the tool; registration plus the agent's
`tools` list and a permitting `tool_call` policy do.

## 7. Maintain exact root indexes

The root arrays are the solution-wide catalog:

```json
{
  "agents": [],
  "tools": [],
  "capabilities": ["support.answer", "customer.lookup", "support.ticket.create"],
  "resources": ["crm.customers", "ticketing.tickets"]
}
```

Author them as exact, duplicate-free unions:

- `capabilities` is the union of every agent capability and every tool
  capability;
- `resources` is the union of every tool resource; and
- do not retain unreferenced future values.

The current SDK neither validates these relationships nor uses the root arrays
for local authorization or policy context. It sends and hashes them as part of
the manifest. Per-agent and per-tool fields are what the context resolver
copies into decisions.

This means a missing root index entry does not automatically deny an action,
and an extra root entry does not grant one. Maintain exact indexes because they
are part of the manifest registered with Governance. This SDK does not define
how the service validates or otherwise uses those indexes.

Use stable security-boundary names such as:

```text
crm.customers
payments.refunds
ticketing.tickets
public-web
```

Do not use URLs with credentials, access tokens, customer identifiers,
environment-specific tenant IDs, or runtime user data.

## 8. Understand how manifest fields become policy context

The host supplies runtime identities. The resolver looks them up in the active
manifest and adds trusted fields:

| Manifest field         | Runtime policy path                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `agentDid`             | `agent.agentDid`                                                                                 |
| agent existence        | `agent.registered`                                                                               |
| `agentKey`             | `agent.agentKey`                                                                                 |
| agent `name`           | `agent.name`                                                                                     |
| agent `capabilities`   | `agent.capabilities`                                                                             |
| agent `tools`          | `agent.tools`                                                                                    |
| agent risk             | `agent.riskTier`, `agent.riskScore`                                                              |
| agent metadata         | `agent.metadata.<key>`                                                                           |
| `toolDid`              | `tool.toolDid`                                                                                   |
| tool existence         | `tool.registered`                                                                                |
| tool `key`             | `tool.key`                                                                                       |
| tool `capability`      | `tool.capability`                                                                                |
| tool `resources`       | `tool.resources`                                                                                 |
| tool category and risk | `tool.category`, `tool.riskTier`                                                                 |
| tool metadata          | `tool.metadata.<key>`                                                                            |
| target agent fields    | The corresponding `handoff.*` paths, including `handoff.targetAgentDid` and `handoff.registered` |

Known agent and tool DIDs receive `registered: true`. Unknown DIDs receive
`registered: false` and no manifest-derived classification.

The supported host input contains only runtime fields such as `agentDid`,
`toolDid`, tool arguments, and `targetAgentDid`. The SDK does not perform a
general runtime schema validation of arbitrary extra input properties. Backend
adapters must construct these objects explicitly and must never spread an
untrusted request body into policy input as if it contained manifest facts.

The root `capabilities` and `resources` arrays do not have policy context paths.
Policies inspect the fields attached to the current agent, tool, or handoff
target.

### Metadata authoring rules

Although the TypeScript type uses `unknown` values, a JSON manifest can contain
only JSON-compatible metadata. Keep metadata:

- non-secret and safe to expose in decision context;
- stable across requests;
- limited to facts needed by policy or Governance inventory;
- consistent in type across entities and versions; and
- addressable with dot-separated policy paths.

Primitive values and primitive arrays are easiest to use in context rules.
Nested objects can be addressed with paths such as
`agent.metadata.ownership.team`. Keys containing dots cannot be addressed
literally, and array indices are not traversed by the policy evaluator.

Never put system prompts, API keys, canary tokens, credentials, personal
records, session data, tool arguments, model outputs, or user messages in the
manifest.

## 9. Understand manifest authorization boundaries

Manifest authorization happens before policy matching:

| Runtime checkpoint | Manifest requirement                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| Every checkpoint   | The calling `agent.agentDid` must resolve in `agents`. `agent` is a required input.            |
| `tool_call`        | The tool must resolve in `tools` and its DID must appear in the calling agent's `tools` array. |
| `handoff`          | The target agent DID must resolve in `agents`.                                                 |

Failure returns a deny decision with no matched policy rule. The reasons are:

```text
The calling agent is not registered in the solution manifest
The requested tool is not registered in the solution manifest
The calling agent is not authorized for the requested tool
The handoff target is not registered in the solution manifest
```

Manifest authorization and policy authorization are cumulative:

```text
manifest hard gate passes
        AND
a policy/default permits the boundary
        =
operation may proceed
```

Consequences:

- declaring a tool does not let every agent use it;
- assigning a tool to an agent does not bypass the default-deny behavior at
  `tool_call`;
- declaring a handoff target does not permit the route, because `handoff`
  defaults to deny and the manifest has no handoff-route allowlist;
- a broad solution `allow` cannot authorize an unknown agent, unknown tool, or
  unassigned tool;
- a dangling DID in `agent.tools` never registers the missing tool; and
- changing an agent's tool list is an authorization change and requires the
  same review as changing a policy.

The hard tool check runs only at `tool_call`. A `tool_result` can carry an
unknown or omitted tool without being rejected by this manifest gate. If the
application requires result provenance to be bound to a registered tool,
enforce that in its adapter and policies.

## 10. Register and load the manifest correctly

### Development-time registration

After authoring:

1. validate the complete schema and internal references;
2. test it with the solution policy set;
3. review identity, tool access, effects, risk, resources, and metadata;
4. register the reviewed manifest through the Governance developer workflow;
   and
5. package that same reviewed file with the deployment.

The development registration transport is not exposed by this SDK. Do not call
`registerDeployment` directly as a replacement; that function represents
runtime registration.

### Runtime loading and registration

`initializeGovernanceSDK`:

1. requires a non-empty `manifestPath`;
2. reads and `JSON.parse`s the UTF-8 file;
3. computes `manifestHash`;
4. sends the parsed `solutionManifest` and `manifestHash` in runtime deployment
   registration;
5. receives and validates a `GovernanceBundle`; and
6. builds lookup maps and the manifest-backed policy engine.

Missing, unreadable, or malformed JSON calls `process.exit(1)` through the
startup failure path. Valid JSON with an invalid manifest shape is not rejected
by `loadSolutionManifest`; it may be sent to Governance and can fail later
without a field-specific manifest validation error.

The initialized handle exposes the parsed `manifest` and its `manifestHash`.
Treat both as read-only runtime state.

### Manifest hash behavior

`computeJsonSha256Hash` creates:

```text
sha256:<64 lowercase hexadecimal characters>
```

It hashes the parsed JSON after recursively sorting object keys:

- whitespace and object-property order do not change the hash;
- array order does change the hash;
- metadata array order also changes the hash;
- values and types change the hash;
- unknown fields are retained, sent, and included in the hash; and
- the hash is computed from parsed content, not raw file bytes.

The SDK does not verify a signature over the manifest or compare the hash with
a separately trusted development-registration record. Governance must decide
how the submitted hash is used.

### No hot reload

The file is loaded once during initialization. Bundle refresh:

- re-registers with the same in-memory manifest and original hash;
- does not reread `manifestPath`; and
- constructs the next policy engine from that same manifest object.

Editing the file after startup has no effect. Deploy and restart the process to
activate a manifest change.

Do not mutate `handle.manifest` in memory. The object is not deep-frozen, the
resolver's lookup maps were already constructed, and runtime registration
retains the original hash. Mutation can create partial state or a
manifest/hash mismatch.

## 11. Compensate for the current validation gap

The SDK loader currently enforces only:

- `manifestPath` is not empty;
- the file can be read; and
- the contents are syntactically valid JSON.

It does **not** enforce:

| Required development invariant                                 | Current SDK behavior                             |
| -------------------------------------------------------------- | ------------------------------------------------ |
| Root value is an object with all four arrays                   | Not checked by the loader.                       |
| Required agent/tool fields exist and have the documented types | Not checked.                                     |
| Strings are non-empty and unpadded                             | Not checked or normalized.                       |
| DIDs and keys are unique                                       | Not checked; duplicate DIDs are last-entry-wins. |
| Agent tool DIDs resolve to declared tools                      | Not checked.                                     |
| Capabilities and resources are duplicate-free                  | Not checked.                                     |
| Root indexes equal referenced unions                           | Not checked.                                     |
| Risk tiers and tool categories use supported values            | TypeScript-only; JSON is not checked.            |
| Risk scores follow the Governance-approved scale               | Not checked.                                     |
| Metadata is limited to approved non-secret fields              | Not checked.                                     |
| Unknown fields are absent                                      | Not checked; they remain in the object and hash. |

TypeScript interfaces do not validate JSON at runtime. A cast such as
`JSON.parse(text) as SolutionManifest` only tells the compiler to trust the
value.

Use one of these development controls:

- validate JSON against a project-owned schema that exactly matches the public
  interfaces;
- author a typed object with `satisfies SolutionManifest`, then serialize it;
- add explicit runtime assertions in a build script; and
- keep reference, uniqueness, and authorization tests in CI.

Do not depend solely on Governance registration to find errors late in the
workflow.

## 12. Test schema, consistency, and enforcement

After runtime schema validation, test internal references:

```ts
import { expect } from "vitest";
import type { SolutionManifest } from "@zbrain/governance-sdk";

export function expectConsistentManifest(manifest: SolutionManifest): void {
  expectUnique(manifest.agents.map((agent) => agent.agentKey));
  expectUnique(manifest.agents.map((agent) => agent.agentDid));
  expectUnique(manifest.tools.map((tool) => tool.key));
  expectUnique(manifest.tools.map((tool) => tool.toolDid));
  expectUnique([
    ...manifest.agents.map((agent) => agent.agentDid),
    ...manifest.tools.map((tool) => tool.toolDid)
  ]);
  expectUnique(manifest.capabilities);
  expectUnique(manifest.resources);

  const toolsByDid = new Set(manifest.tools.map((tool) => tool.toolDid));
  const referencedCapabilities = new Set([
    ...manifest.agents.flatMap((agent) => agent.capabilities),
    ...manifest.tools.map((tool) => tool.capability)
  ]);
  const referencedResources = new Set(manifest.tools.flatMap((tool) => tool.resources));

  for (const agent of manifest.agents) {
    expectUnique(agent.capabilities);
    expectUnique(agent.tools);

    for (const toolDid of agent.tools) {
      expect(toolsByDid.has(toolDid)).toBe(true);
    }
  }

  for (const tool of manifest.tools) {
    expectUnique(tool.resources);
  }

  expect(new Set(manifest.capabilities)).toEqual(referencedCapabilities);
  expect(new Set(manifest.resources)).toEqual(referencedResources);
}

function expectUnique(values: readonly string[]): void {
  expect(new Set(values).size).toBe(values.length);
}
```

Also test through `GovernancePolicyEngine`, not only the raw context builder:

- every registered agent at each boundary it can execute;
- an unknown calling agent (an omitted one is a compile error, since `agent` is
  required on `PolicyContextInput`);
- every legitimate agent-tool assignment;
- a registered tool that is not assigned to the calling agent;
- an unknown tool;
- each permitted and rejected handoff target;
- the exact manifest-derived values used by policy conditions;
- changed risk, category, resource, capability, and metadata classifications;
- policy near-misses caused by key/DID spelling or casing; and
- the packaged file's hash and successful Governance registration.

Relevant repository tests are:

- [manifest loading](../../test/manifest/solution-manifest.test.ts);
- [manifest context enrichment](../../test/policy-engine/context.test.ts);
- [hard agent-to-tool authorization](../../test/core/manifest-authorization.test.ts);
- [runtime registration payload](../../test/core/client.test.ts);
- [SDK lifecycle](../../test/core/index.test.ts);
- [hashing behavior](../../test/utils/index.test.ts).

## 13. Authoring workflow for developers and coding agents

Use this sequence:

1. **Discover runtime entities.** Trace entrypoints, agent definitions, tool
   registries, call sites, and handoffs.
2. **Assign stable identities.** Reuse application constants for DIDs and
   policy-facing keys.
3. **Classify agents and tools.** Record implemented capabilities, actual
   resources, effect categories, risk, and approved metadata.
4. **Apply least privilege.** Give each agent only the exact tool DIDs it can
   legitimately request.
5. **Build exact root indexes.** Derive duplicate-free capability and resource
   unions.
6. **Cross-check policies.** Every manifest key, DID, capability, resource,
   risk field, and metadata path referenced by the
   [solution policies](02-solution-policies.md) must exist and use the same
   type.
7. **Validate and test.** Run schema, consistency, authorization, and
   policy-integration tests.
8. **Register with Governance.** The developer or coding agent submits the
   reviewed development artifact through the Governance registration workflow.
9. **Package the same artifact.** Point runtime `manifestPath` at the reviewed
   file; do not regenerate a divergent manifest during deployment.
10. **Restart on change.** A manifest update is not picked up by bundle refresh.

## 14. Current non-features and boundaries

Do not assume the current SDK provides:

- a developer-facing manifest registration CLI or API wrapper;
- runtime manifest schema validation;
- DID parsing, normalization, or uniqueness validation;
- agent/tool key uniqueness validation;
- dangling-reference or root-index validation;
- a built-in `riskScore` scale or tier-to-score consistency check;
- capability-to-tool authorization;
- resource-level authorization without a matching policy;
- a manifest handoff-route allowlist;
- manifest file watching or hot reload;
- manifest immutability or deep freezing;
- manifest signature verification;
- runtime rejection of unsupported extra properties in host policy input; or
- filtering of unknown manifest fields.

Treat these as development validation, Governance registration, policy, or
deployment responsibilities.

## Completion checklist

- [ ] The manifest was derived from the target release's executable code.
- [ ] All four root arrays are present.
- [ ] Agent keys, tool keys, and all DIDs are non-empty and unique.
- [ ] DIDs are stable and reused exactly by backend adapters.
- [ ] Every agent tool entry is a declared `toolDid`.
- [ ] Every agent has only the tools it needs.
- [ ] Agent and tool capabilities describe implemented behavior.
- [ ] Root capabilities are the exact union of agent and tool capabilities.
- [ ] Root resources are the exact union of tool resources.
- [ ] Tool categories describe real effects.
- [ ] Risk tiers and scores follow the Governance-approved scale.
- [ ] Metadata is JSON-compatible, stable, policy-relevant, and non-secret.
- [ ] Manifest paths and types agree with the solution policies.
- [ ] Unknown-agent, unassigned-tool, unknown-tool, and handoff tests pass.
- [ ] The reviewed manifest is registered with Governance during development.
- [ ] The identical registered file is packaged at runtime.
- [ ] Manifest changes trigger a new deployment or process restart.
