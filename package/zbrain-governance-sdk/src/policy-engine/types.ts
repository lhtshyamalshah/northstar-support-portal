import type { AgentDefinition } from "../manifest/agent-defination.js";
import type { ToolDefinition } from "../manifest/tool-defination.js";
import type { RISK_TIER } from "../manifest/types.js";

/**
 * Lifecycle points where a host may ask the policy engine for a decision.
 *
 * Context and custom rules are evaluated only when their checkpoint matches
 * `checkpoint`. Prompt-injection validation uses the explicit
 * `validation_lifecycle` rule scope and is routed to the concrete runtime
 * checkpoints listed here.
 */
export const POLICY_CHECKPOINTS = [
  "agent_start",
  "model_call",
  "tool_call",
  "tool_result",
  "model_result",
  "agent_end",
  "handoff"
] as const;

/** A concrete runtime lifecycle location for policy evaluation. */
export type PolicyCheckpoint = (typeof POLICY_CHECKPOINTS)[number];

/**
 * Explicit multi-boundary scope used by a prompt-injection rule.
 *
 * This is a policy placement value, not a runtime event. Decisions and policy
 * contexts always retain one of the concrete `PolicyCheckpoint` values above.
 */
export const VALIDATION_LIFECYCLE_CHECKPOINT = "validation_lifecycle" as const;

/** The required checkpoint value for a prompt-injection validation rule. */
export type ValidationLifecycleCheckpoint = typeof VALIDATION_LIFECYCLE_CHECKPOINT;

/**
 * Built-in fallback actions when no rule matches a checkpoint.
 *
 * Tool invocation and agent handoff are effectful boundaries, so they require
 * an explicit permitting policy. All other lifecycle checkpoints proceed by
 * default.
 */
export const POLICY_CHECKPOINT_DEFAULT_ACTIONS = {
  agent_start: "allow",
  model_call: "allow",
  tool_call: "deny",
  tool_result: "allow",
  model_result: "allow",
  agent_end: "allow",
  handoff: "deny"
} as const satisfies Readonly<Record<PolicyCheckpoint, PolicyAction>>;

/**
 * The authority layer that authored a rule.
 *
 * Enterprise rules are organization-wide guardrails. Solution rules add
 * solution-specific controls, but cannot override a matching enterprise deny.
 */
export type PolicyLevel = "enterprise" | "solution";

/**
 * Converts a governance-service policy level to the SDK's canonical lowercase form.
 *
 * Rule authors continue to use `enterprise` and `solution`; this accepts the
 * uppercase values returned by the governance microservice at runtime.
 */
export function normalizePolicyLevel(value: unknown): PolicyLevel | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.toLowerCase();
  return normalized === "enterprise" || normalized === "solution" ? normalized : undefined;
}

/**
 * The outcome selected when a policy rule matches.
 *
 * - `allow` permits the governed work.
 * - `audit` permits the work and requests a later audit record.
 * - `warn` permits the governed work and returns a warning for the host to
 *   surface or record.
 * - `deny` prevents the governed work and lets the host return a controlled
 *   refusal to its caller.
 */
export type PolicyAction = "allow" | "audit" | "warn" | "deny";

/** JSON values supported as policy operands. */
export type PolicyValue = string | number | boolean | null;

/** JSON-compatible static configuration carried by a custom policy rule. */
export type PolicyConfigValue = PolicyValue | readonly PolicyConfigValue[] | PolicyConfig;

/** Static configuration passed to the locally registered custom policy handler. */
export interface PolicyConfig {
  readonly [key: string]: PolicyConfigValue;
}

/**
 * The complete set of comparison operators supported by the policy engine.
 *
 * Operators are data, rather than executable expressions, so bundles can be
 * validated before they are evaluated.
 */
export const POLICY_OPERATORS = [
  "eq",
  "ne",
  "gt",
  "lt",
  "gte",
  "lte",
  "in",
  "contains",
  "regex-match",
  "glob-match"
] as const;

/** A supported comparison operator name. */
export type PolicyOperatorName = (typeof POLICY_OPERATORS)[number];

/** A single comparison applied to a field. */
export interface PolicyOperator {
  /** Strict value equality, including type. */
  eq?: PolicyValue;
  /** Strict value inequality. A missing context value is not equal to a supplied value. */
  ne?: PolicyValue;
  /** Numeric comparisons. The context value must also be a number. */
  gt?: number;
  lt?: number;
  gte?: number;
  lte?: number;
  /** Matches when the context value equals one member of this primitive-value list. */
  in?: readonly PolicyValue[];
  /** String substring match, or an exact member match when the context value is an array. */
  contains?: PolicyValue;
  /** JavaScript regular-expression match. The context value must be a string. */
  "regex-match"?: string;
  /** Shell-style glob match. The context value must be a string. */
  "glob-match"?: string;
}

/**
 * A declarative rule distributed in a governance bundle.
 *
 * Rule evaluation has three stages:
 * 1. Select enabled rules for the current checkpoint, including explicit
 *    validation-lifecycle routing.
 * 2. Keep rules whose AND-combined condition matches the context.
 * 3. Resolve the remaining candidates into one decision.
 */
interface PolicyRuleBase<
  TCheckpoint extends PolicyCheckpoint | ValidationLifecycleCheckpoint = PolicyCheckpoint
> {
  /** MongoDB identifier returned for this rule by the governance microservice. */
  _id?: string;

  /** Stable identifier for this individual rule. */
  name: string;

  /** The concrete checkpoint or explicit validation lifecycle scope for this rule. */
  checkpoint: TCheckpoint;

  /** Larger values take precedence when rules otherwise have equal authority. */
  priority: number;

  /** Set to `false` to retain a rule in a bundle without enforcing it. */
  enabled: boolean;

  /** Enforcement outcome selected when `condition` matches. */
  action: PolicyAction;

  /** Safe, caller-facing explanation for the decision. */
  reason: string;
}

/** A rule that matched the current context and is awaiting conflict resolution. */
export interface PolicyCandidate {
  rule: PolicyRule;
  /** Optional caller-safe facts supplied by a matched policy evaluator. */
  auditData?: PolicyAuditData;
}

/**
 * The deterministic result returned for every policy evaluation.
 *
 * For normal conflict resolution, `matchedRules` contains every candidate in
 * deterministic order and `matchedRule` identifies the winner. Defaults,
 * manifest authorization denials, and fail-closed evaluation errors have no
 * winner.
 */
export interface PolicyDecision {
  /** Whether the host may continue with the governed action. */
  allowed: boolean;

  /** Effective policy action after conflict resolution. */
  action: PolicyAction;

  /** Checkpoint evaluated for this decision. */
  checkpoint: PolicyCheckpoint;

  /** Winning rule, omitted when no rule won or evaluation failed closed. */
  matchedRule?: string;

  /** Governance-microservice `_id` of the winning rule, when supplied in the bundle. */
  matchedRuleId?: string;

  /** Authority level of the winning rule. */
  matchedRuleLevel?: PolicyLevel;

  /** Normal-resolution candidates in deterministic order; empty when no winner is resolved. */
  matchedRules: readonly string[];

  /** Whether matching candidates included both a permitting action and a deny. */
  conflictDetected: boolean;

  /** Deterministic, caller-safe explanation of how the decision was resolved. */
  resolutionTrace: readonly string[];

  /** Caller-safe explanation of the result. */
  reason: string;

  /** Optional caller-safe facts supplied by the winning policy evaluator. */
  auditData?: PolicyAuditData;
}

export interface ModelContext {
  provider?: string;
  name?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

/** Origins accepted for text validated at model input and output boundaries. */
export const GOVERNED_TEXT_SOURCES = [
  "user_message",
  "tool_result",
  "retrieved_content",
  "model_output"
] as const;

/** Origin of text supplied to prompt-injection validation. */
export type GovernedTextSource = (typeof GOVERNED_TEXT_SOURCES)[number];

/** Runtime text and its origin, retained only for the current policy evaluation. */
export interface GovernedTextContext {
  source: GovernedTextSource;
  content: string;
}

/** Runtime tool facts, enriched from the active solution manifest by `toolDid`. */
export interface ToolContext {
  toolDid: string;
  /** Whether `toolDid` resolved in the manifest associated with this runtime. */
  registered: boolean;
  key?: ToolDefinition["key"];
  capability?: ToolDefinition["capability"];
  resources?: ToolDefinition["resources"];
  category?: ToolDefinition["category"];
  riskTier?: RISK_TIER;
  metadata?: ToolDefinition["metadata"];
  /** Runtime arguments are solution data, not enterprise policy fields. */
  arguments?: Readonly<Record<string, unknown>>;
}

/** Runtime agent facts, enriched from the active solution manifest by `agentDid`. */
export interface AgentContext {
  agentDid: string;
  /** Whether `agentDid` resolved in the manifest associated with this runtime. */
  registered: boolean;
  agentKey?: AgentDefinition["agentKey"];
  capabilities?: AgentDefinition["capabilities"];
  tools?: AgentDefinition["tools"];
  name?: AgentDefinition["name"];
  riskTier?: RISK_TIER;
  riskScore?: AgentDefinition["riskScore"];
  metadata?: AgentDefinition["metadata"];
  /** Runtime arguments are solution data, not enterprise policy fields. */
  systemPrompt?: string;
  userMessage?: string;
}

/** Target-agent facts resolved from the active manifest for a handoff. */
export interface HandoffContext {
  targetAgentDid: string;
  /** Whether `targetAgentDid` resolved in the manifest associated with this runtime. */
  registered: boolean;
  agentKey?: AgentDefinition["agentKey"];
  capabilities?: AgentDefinition["capabilities"];
  tools?: AgentDefinition["tools"];
  name?: AgentDefinition["name"];
  riskTier?: RISK_TIER;
  riskScore?: AgentDefinition["riskScore"];
  metadata?: AgentDefinition["metadata"];
}

/** Session-scoped counters maintained by the SDK, never trusted from callers. */
export interface UsageContext {
  /** Calls of the current tool within this session. Zero when no tool is in context. */
  perToolCallCount: number;
  /** All allowed tool calls in the session. */
  totalToolCallCount: number;
  /** Model calls by the current agent in this session. Zero when no agent is in context. */
  modelCallPerAgentCount: number;
  /** Agent turns observed in the session. */
  turnCount: number;
}

/**
 * Runtime data evaluated by a policy rule.
 *
 * `checkpoint` is the mandatory concrete runtime boundary. Context and custom
 * rules match it exactly; validation-lifecycle routing preserves it in the
 * resulting decision.
 */
export interface PolicyContext {
  sessionId: string;
  timestamp: string;
  checkpoint: PolicyCheckpoint;
  model?: ModelContext;
  /** Provenance-preserving untrusted text segments supplied at validation boundaries. */
  governedTexts?: readonly GovernedTextContext[];
  tool?: ToolContext;
  agent?: AgentContext;
  handoff?: HandoffContext;
  usage: UsageContext;
}

/**
 * A `PolicyContext` with every untrusted-content leaf removed, for telemetry
 * that leaves the process.
 *
 * The evaluated context carries the governed content itself: system prompts
 * (which may embed canary tokens), user messages, raw tool arguments, and the
 * provenance-labelled `governedTexts` segments. None of that may be shipped to
 * the governance microservice. What remains is the manifest-derived
 * classification — DIDs, keys, capabilities, resources, category, risk tiers,
 * and non-secret metadata — plus model metrics and session counters, which is
 * where the forensic value of a violation actually sits.
 *
 * A rule's rationale is carried by the decision (`matchedRule`,
 * `resolutionTrace`, and safe `auditData` such as prompt-injection hashes and
 * pattern keys), not by replaying the offending content.
 */
export interface RedactedPolicyContext
  extends Omit<PolicyContext, "agent" | "tool" | "governedTexts"> {
  agent?: Omit<AgentContext, "systemPrompt" | "userMessage">;
  tool?: Omit<ToolContext, "arguments">;
}

/** Primitive or array values that can be compared directly by a policy operator. */
type PolicyConditionLeaf = PolicyValue | readonly PolicyValue[];

/** String keys only; symbols cannot be represented as bundle dot paths. */
type StringKey<T> = Extract<keyof T, string>;

/**
 * Produces valid leaf paths for a context type.
 *
 * Index-signature objects deliberately become `${path}.${string}`. This keeps
 * solution-specific tool arguments and manifest metadata available without
 * weakening the typed, fixed portion of `PolicyContext`.
 */
type ContextPath<T> = T extends object
  ? {
      [Key in StringKey<T>]: NonNullable<T[Key]> extends PolicyConditionLeaf
        ? Key
        : NonNullable<T[Key]> extends readonly unknown[]
          ? Key
          : NonNullable<T[Key]> extends object
            ? string extends keyof NonNullable<T[Key]>
              ? `${Key}.${string}`
              : `${Key}.${ContextPath<NonNullable<T[Key]>>}`
            : never;
    }[StringKey<T>]
  : never;

/** Every supported solution-policy condition path derived from `PolicyContext`. */
export type PolicyContextPath = ContextPath<PolicyContext>;

/**
 * An AND-combined set of comparisons over a context type.
 *
 * The default is the complete `PolicyContext`; callers may supply a narrower
 * context type when building a specialized host integration.
 */
export type PolicyCondition<TContext extends object = PolicyContext> = Readonly<
  Partial<Record<ContextPath<TContext>, PolicyOperator>>
>;

/**
 * Conditions available to enterprise policies.
 *
 * These describe runtime facts that are independent of any particular
 * solution, agent implementation, or tool schema.
 */
export const ENTERPRISE_POLICY_CONDITION_FIELDS = [
  "model.name",
  "model.provider",
  "model.inputTokens",
  "model.outputTokens",
  "model.totalTokens",
  "model.costUsd",

  "tool.category",
  "tool.riskTier",
  "tool.registered",

  "agent.riskTier",
  "agent.riskScore",
  "agent.registered",

  "handoff.riskTier",
  "handoff.riskScore",
  "handoff.registered",

  "usage.perToolCallCount",
  "usage.totalToolCallCount",
  "usage.modelCallPerAgentCount",
  "usage.turnCount"
] as const;

/** A solution-agnostic context path that an enterprise policy may inspect. */
export type EnterprisePolicyConditionField = (typeof ENTERPRISE_POLICY_CONDITION_FIELDS)[number];

/** Conditions that an enterprise policy may use. */
export type EnterprisePolicyCondition = Readonly<
  Partial<Record<EnterprisePolicyConditionField, PolicyOperator>>
>;

/** A policy authored at the enterprise layer. */
export interface EnterprisePolicyRule extends PolicyRuleBase<PolicyCheckpoint> {
  level: "enterprise";
  kind?: "context";
  condition: EnterprisePolicyCondition;
}

/** A policy authored for one solution and evaluated against its full context. */
export interface SolutionPolicyRule extends PolicyRuleBase<PolicyCheckpoint> {
  level: "solution";
  kind?: "context";
  condition: PolicyCondition;
}

/** A solution-owned rule evaluated by a locally registered handler. */
export interface CustomPolicyRule extends PolicyRuleBase<PolicyCheckpoint> {
  level: "solution";
  kind: "custom";
  config: PolicyConfig;
}

/** Prompt-injection categories recognized by the built-in detector. */
export const PROMPT_INJECTION_TYPES = [
  "directOverride",
  "delimiterAttack",
  "encodingAttack",
  "rolePlay",
  "contextManipulation",
  "canaryLeak",
  "multiTurnEscalation"
] as const;

/** A recognized prompt-injection category. */
export type PromptInjectionType = (typeof PROMPT_INJECTION_TYPES)[number];

/**
 * Static configuration for a prompt-injection policy rule.
 *
 * Additional patterns are additive. They never replace the SDK baseline
 * patterns, so a solution rule cannot weaken the detector used by an
 * enterprise rule in the same active bundle.
 */
export interface PromptInjectionPolicyConfig {
  blocklist?: readonly string[];
  allowlist?: readonly string[];
  additionalPatterns?: Readonly<Partial<Record<PromptInjectionType, readonly string[]>>>;
}

/**
 * Selects the built-in input checks evaluated by a prompt-injection rule.
 * A rule matches when any selected check identifies an injection.
 */
export interface PromptInjectionValidationCondition {
  checks: Readonly<{
    in: readonly PromptInjectionType[];
  }>;
}

/** Safe detector result returned to the policy evaluator and host audit layer. */
export interface PromptInjectionDetection {
  isInjection: boolean;
  matchedTypes: readonly PromptInjectionType[];
  /** Built-in pattern names or hashes only; never configurable pattern bodies or secrets. */
  matchedPatternKeys: readonly string[];
  /** True when the result represents a fail-closed detector error or regex timeout. */
  detectorFailed: boolean;
  inputHash: string;
  inputLengthCharacters: number;
  reason: string;
}

/**
 * A single built-in prompt-injection rule routed internally across the
 * validation lifecycle. Its policy checkpoint remains explicit while every
 * returned decision reports the concrete runtime checkpoint that was checked.
 */
export interface PromptInjectionPolicyRule extends PolicyRuleBase<ValidationLifecycleCheckpoint> {
  level: PolicyLevel;
  kind: "validation";
  condition: PromptInjectionValidationCondition;
  config?: PromptInjectionPolicyConfig;
}

/** A declarative or custom rule from either authority layer. */
export type PolicyRule =
  EnterprisePolicyRule | SolutionPolicyRule | CustomPolicyRule | PromptInjectionPolicyRule;

/** Structured, non-secret data returned by a custom handler for auditing. */
export type CustomPolicyAuditData = Readonly<Record<string, PolicyConfigValue>> & {
  /** Reserved as the discriminator for built-in validation audit records. */
  readonly validationType?: never;
};

/** Trusted host-only options used by prompt-injection validation. */
export interface PromptInjectionRuntimeOptions {
  /** Secret canaries checked locally and never serialized into a policy bundle. */
  canaryTokens?: readonly string[];
}

/** Caller-safe evidence attached to a winning prompt-injection policy candidate. */
export interface PromptInjectionAuditData extends PromptInjectionDetection {
  readonly [key: string]: PolicyConfigValue | undefined;
  validationType: "promptInjection";
  policyName: string;
}

/** Safe audit facts produced by built-in or locally registered policy evaluators. */
export type PolicyAuditData = CustomPolicyAuditData | PromptInjectionAuditData;

/** Result of evaluating a custom policy rule. */
export interface CustomPolicyEvaluation {
  /** Whether the custom rule matched the supplied context. */
  matched: boolean;
  /** Optional handler-provided facts that may be included in an audit record. */
  auditData?: CustomPolicyAuditData;
}

/** Input supplied by the policy engine to a custom policy handler. */
export interface CustomPolicyHandlerInput {
  context: PolicyContext;
  rule: CustomPolicyRule;
  config: PolicyConfig;
}

/**
 * Trusted solution code that evaluates one custom policy rule.
 *
 * Handlers are registered by `PolicyRule.name` at SDK initialization. They
 * are never loaded from a governance bundle.
 */
export interface CustomPolicyHandler {
  /** Reject malformed or unsupported static configuration during bundle loading. */
  validateConfig(config: PolicyConfig): void | Promise<void>;
  /** Evaluate runtime context and return whether the associated rule matched. */
  evaluate(
    input: CustomPolicyHandlerInput
  ): CustomPolicyEvaluation | Promise<CustomPolicyEvaluation>;
}
