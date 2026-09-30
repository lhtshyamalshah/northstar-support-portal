import { sha256Digest } from "../utils/index.js";
import { PromptInjectionDetector } from "./prompt-injection-detector.js";
import {
  normalizePolicyLevel,
  POLICY_CHECKPOINT_DEFAULT_ACTIONS,
  PROMPT_INJECTION_TYPES,
  VALIDATION_LIFECYCLE_CHECKPOINT
} from "./types.js";
import type {
  CustomPolicyHandler,
  GovernedTextContext,
  GovernedTextSource,
  PolicyAction,
  PolicyAuditData,
  PolicyCandidate,
  PolicyCheckpoint,
  PolicyCondition,
  PolicyContext,
  PolicyDecision,
  PolicyOperator,
  PolicyRule,
  PolicyValue,
  PromptInjectionAuditData,
  PromptInjectionDetection,
  PromptInjectionPolicyRule,
  PromptInjectionRuntimeOptions,
  PromptInjectionType
} from "./types.js";

const PROMPT_INJECTION_CHECKS_BY_CHECKPOINT: Readonly<
  Partial<Record<PolicyCheckpoint, readonly PromptInjectionType[]>>
> = {
  agent_start: PROMPT_INJECTION_TYPES,
  model_call: PROMPT_INJECTION_TYPES,
  tool_result: PROMPT_INJECTION_TYPES,
  model_result: ["canaryLeak"]
};

interface PromptInjectionInputContract {
  allowedSources: readonly GovernedTextSource[];
}

const PROMPT_INJECTION_INPUTS_BY_CHECKPOINT: Readonly<
  Partial<Record<PolicyCheckpoint, PromptInjectionInputContract>>
> = {
  model_call: {
    allowedSources: ["user_message", "tool_result", "retrieved_content"]
  },
  tool_result: {
    allowedSources: ["tool_result", "retrieved_content"]
  },
  model_result: {
    allowedSources: ["model_output"]
  }
};

/** Options used to construct a policy evaluator. */
export interface PolicyEvaluatorOptions {
  rules?: readonly PolicyRule[];
  customPolicyHandlers?: Readonly<Record<string, CustomPolicyHandler>>;
  /** Trusted local prompt-injection configuration that is never read from a bundle. */
  promptInjection?: PromptInjectionRuntimeOptions;
}

/**
 * Evaluates checkpoint-scoped policy rules against an enriched runtime context.
 *
 * Custom rule handlers are selected only by the rule's stable name from the
 * locally registered handler map. A handler error or missing handler produces
 * a fail-closed deny decision.
 */
export class PolicyEvaluator {
  private readonly rules: readonly PolicyRule[];
  private readonly customPolicyHandlers: Readonly<Record<string, CustomPolicyHandler>>;
  private readonly promptInjectionDetectors = new Map<
    PromptInjectionPolicyRule,
    PromptInjectionDetector
  >();

  constructor(options: PolicyEvaluatorOptions = {}) {
    this.rules = (options.rules ?? []).map(normalizeRuleLevel);
    this.customPolicyHandlers = options.customPolicyHandlers ?? {};

    for (const rule of this.rules) {
      if (rule.kind === "validation" && rule.enabled) {
        if (rule.action === "allow") {
          throw new Error(`Prompt-injection validation rule '${rule.name}' cannot use allow`);
        }
        this.promptInjectionDetectors.set(
          rule,
          new PromptInjectionDetector(rule.config ?? {}, {
            checks: rule.condition.checks.in,
            canaryTokens: options.promptInjection?.canaryTokens ?? []
          })
        );
      }
    }
  }

  async evaluate(context: PolicyContext): Promise<PolicyDecision> {
    const resolutionTrace = [];

    try {
      const candidates: PolicyCandidate[] = [];

      for (const rule of this.rules) {
        if (!rule.enabled) {
          resolutionTrace.push(`Skipped '${rule.name}': disabled`);
          continue;
        }
        if (!ruleAppliesAtCheckpoint(rule, context.checkpoint)) {
          continue;
        }

        if (rule.kind === "custom") {
          const handler = this.customPolicyHandlers[rule.name];
          if (handler === undefined) {
            return failClosedDecision(
              context,
              `Custom policy handler is not registered for rule '${rule.name}'`,
              resolutionTrace
            );
          }

          const evaluation = await handler.evaluate({ context, rule, config: rule.config });
          if (evaluation.matched) {
            const candidate: PolicyCandidate = { rule };
            if (evaluation.auditData !== undefined) {
              candidate.auditData = evaluation.auditData;
            }
            candidates.push(candidate);
            resolutionTrace.push(`Matched custom rule '${rule.name}'`);
          }
          continue;
        }

        if (rule.kind === "validation") {
          const activeChecks = promptInjectionChecksAtCheckpoint(rule, context.checkpoint);
          if (activeChecks.length === 0) {
            continue;
          }

          const detector = this.promptInjectionDetectors.get(rule);
          if (detector === undefined) {
            return failClosedDecision(
              context,
              `Prompt-injection detector is unavailable for rule '${rule.name}'`,
              resolutionTrace,
              promptInjectionFailureAudit(rule.name, "detection_error:unavailable")
            );
          }

          const validationInput = resolvePromptInjectionInputs(context);
          if (validationInput.inputs === undefined) {
            return failClosedDecision(
              context,
              `Prompt-injection validation rule '${rule.name}' ${validationInput.error}`,
              resolutionTrace,
              promptInjectionFailureAudit(rule.name, validationInput.patternKey)
            );
          }

          if (validationInput.inputs.length === 0) {
            continue;
          }

          const detection = detectPromptInjectionInputs(
            detector,
            validationInput.inputs,
            activeChecks
          );
          const auditData = promptInjectionAuditData(rule.name, detection);
          if (detection.detectorFailed) {
            return failClosedDecision(
              context,
              `Prompt-injection detector failed closed for rule '${rule.name}'`,
              resolutionTrace,
              auditData
            );
          }
          if (detection.isInjection) {
            const candidateRule = promptInjectionCandidateRule(rule, detection);
            candidates.push({ rule: candidateRule, auditData });
            resolutionTrace.push(`Matched prompt-injection validation rule '${rule.name}'`);
            if (candidateRule !== rule) {
              resolutionTrace.push(
                `Forced deny for canary leakage detected by validation rule '${rule.name}'`
              );
            }
          }
          continue;
        }

        if (matchesCondition(rule.condition, context)) {
          candidates.push({ rule });
          resolutionTrace.push(`Matched context rule '${rule.name}'`);
        }
      }

      return resolveCandidates(context, candidates, resolutionTrace);
    } catch (error) {
      return failClosedDecision(
        context,
        `Policy evaluation error: ${error instanceof Error ? error.message : "unknown error"}`,
        resolutionTrace
      );
    }
  }
}

function normalizeRuleLevel(rule: PolicyRule): PolicyRule {
  const level = normalizePolicyLevel(rule.level);

  return level === undefined || level === rule.level ? rule : ({ ...rule, level } as PolicyRule);
}

function ruleAppliesAtCheckpoint(rule: PolicyRule, checkpoint: PolicyCheckpoint): boolean {
  if (rule.kind === "validation") {
    return (
      rule.checkpoint === VALIDATION_LIFECYCLE_CHECKPOINT &&
      PROMPT_INJECTION_CHECKS_BY_CHECKPOINT[checkpoint] !== undefined
    );
  }

  return rule.checkpoint === checkpoint;
}

function promptInjectionChecksAtCheckpoint(
  rule: PromptInjectionPolicyRule,
  checkpoint: PolicyCheckpoint
): readonly PromptInjectionType[] {
  const checkpointChecks = PROMPT_INJECTION_CHECKS_BY_CHECKPOINT[checkpoint];
  if (checkpointChecks === undefined) {
    return [];
  }

  const allowedChecks = new Set(checkpointChecks);
  return rule.condition.checks.in.filter((check) => allowedChecks.has(check));
}

function matchesCondition(condition: PolicyCondition, context: PolicyContext): boolean {
  return Object.entries(condition).every(([path, operators]) => {
    const value = readContextPath(context, path);
    // Operators intentionally receive `undefined`. In particular, `ne: true`
    // must match an absent trusted fact so required registration and validation
    // checks fail closed instead of becoming a no-match allow path.
    return operators !== undefined && matchesOperators(value, operators);
  });
}

function matchesOperators(value: unknown, operators: PolicyOperator): boolean {
  return Object.entries(operators).every(([operator, expected]) => {
    switch (operator) {
      case "eq":
        return Object.is(value, expected);
      case "ne":
        return !Object.is(value, expected);
      case "gt":
        return typeof value === "number" && typeof expected === "number" && value > expected;
      case "lt":
        return typeof value === "number" && typeof expected === "number" && value < expected;
      case "gte":
        return typeof value === "number" && typeof expected === "number" && value >= expected;
      case "lte":
        return typeof value === "number" && typeof expected === "number" && value <= expected;
      case "in":
        return Array.isArray(expected) && expected.some((item) => Object.is(value, item));
      case "contains":
        return matchesContains(value, expected as PolicyValue);
      case "regex-match":
        return (
          typeof value === "string" &&
          typeof expected === "string" &&
          new RegExp(expected).test(value)
        );
      case "glob-match":
        return (
          typeof value === "string" && typeof expected === "string" && globMatches(value, expected)
        );
      default:
        return false;
    }
  });
}

function matchesContains(value: unknown, expected: PolicyValue): boolean {
  if (typeof value === "string" && typeof expected === "string") {
    return value.includes(expected);
  }

  return Array.isArray(value) && value.some((item) => Object.is(item, expected));
}

function readContextPath(context: PolicyContext, path: string): unknown {
  let value: unknown = context;

  for (const segment of path.split(".")) {
    if (!isRecord(value) || !Object.hasOwn(value, segment)) {
      return undefined;
    }
    value = value[segment];
  }

  return value;
}

function resolveCandidates(
  context: PolicyContext,
  candidates: readonly PolicyCandidate[],
  resolutionTrace: string[]
): PolicyDecision {
  if (candidates.length === 0) {
    const action = POLICY_CHECKPOINT_DEFAULT_ACTIONS[context.checkpoint];
    resolutionTrace.push(
      `No rules matched; default '${action}' applied for checkpoint '${context.checkpoint}'`
    );
    return {
      allowed: actionAllows(action),
      action,
      checkpoint: context.checkpoint,
      matchedRules: [],
      conflictDetected: false,
      resolutionTrace,
      reason: `No policy matched; default '${action}' applied for checkpoint '${context.checkpoint}'`
    };
  }

  const orderedCandidates = [...candidates].sort(compareCandidates);
  const conflictDetected =
    orderedCandidates.some((candidate) => candidate.rule.action === "deny") &&
    orderedCandidates.some((candidate) => actionAllows(candidate.rule.action));
  resolutionTrace.push(`Matched ${orderedCandidates.length} rule(s)`);
  resolutionTrace.push(
    `Candidate order: ${orderedCandidates.map((candidate) => candidate.rule.name).join(", ")}`
  );
  resolutionTrace.push(
    conflictDetected
      ? "Conflict detected: permitting and deny actions matched"
      : "No allow/deny conflict detected"
  );
  const enterpriseDeny = orderedCandidates.find(
    (candidate) => candidate.rule.level === "enterprise" && candidate.rule.action === "deny"
  );
  const winner = enterpriseDeny ?? orderedCandidates[0];

  if (winner === undefined) {
    return failClosedDecision(context, "Unable to resolve policy candidates", resolutionTrace);
  }

  resolutionTrace.push(
    enterpriseDeny === undefined
      ? `Winner '${winner.rule.name}': highest priority candidate`
      : `Winner '${winner.rule.name}': matching enterprise deny overrides priority`
  );

  const decision: PolicyDecision = {
    allowed: actionAllows(winner.rule.action),
    action: winner.rule.action,
    checkpoint: context.checkpoint,
    matchedRule: winner.rule.name,
    ...(winner.rule._id === undefined ? {} : { matchedRuleId: winner.rule._id }),
    matchedRuleLevel: winner.rule.level,
    matchedRules: orderedCandidates.map((candidate) => candidate.rule.name),
    conflictDetected,
    resolutionTrace,
    reason: winner.rule.reason
  };

  if (winner.auditData !== undefined) {
    decision.auditData = winner.auditData;
  }

  return decision;
}

function compareCandidates(left: PolicyCandidate, right: PolicyCandidate): number {
  if (left.rule.priority !== right.rule.priority) {
    return right.rule.priority - left.rule.priority;
  }
  if (left.rule.level !== right.rule.level) {
    return left.rule.level === "enterprise" ? -1 : 1;
  }
  return left.rule.name.localeCompare(right.rule.name);
}

function actionAllows(action: PolicyAction): boolean {
  return action === "allow" || action === "audit" || action === "warn";
}

function failClosedDecision(
  context: PolicyContext,
  reason: string,
  resolutionTrace: readonly string[] = [],
  auditData?: PolicyAuditData
): PolicyDecision {
  const decision: PolicyDecision = {
    allowed: false,
    action: "deny",
    checkpoint: context.checkpoint,
    matchedRules: [],
    conflictDetected: false,
    resolutionTrace: [...resolutionTrace, `Fail closed: ${reason}`],
    reason
  };

  if (auditData !== undefined) {
    decision.auditData = auditData;
  }

  return decision;
}

function promptInjectionAuditData(
  policyName: string,
  detection: PromptInjectionDetection
): PromptInjectionAuditData {
  return {
    validationType: "promptInjection",
    policyName,
    ...detection
  };
}

function promptInjectionFailureAudit(
  policyName: string,
  patternKey: string
): PromptInjectionAuditData {
  return {
    validationType: "promptInjection",
    policyName,
    isInjection: true,
    matchedTypes: [],
    matchedPatternKeys: [patternKey],
    detectorFailed: true,
    inputHash: sha256Digest(""),
    inputLengthCharacters: 0,
    reason: "Detection failed closed; governed content must be blocked"
  };
}

interface PromptInjectionInputResolution {
  inputs?: readonly GovernedTextContext[];
  error: string;
  patternKey: string;
}

function resolvePromptInjectionInputs(context: PolicyContext): PromptInjectionInputResolution {
  if (context.checkpoint === "agent_start") {
    const userMessage: unknown = context.agent?.userMessage;
    if (userMessage === undefined) {
      return { inputs: [], error: "", patternKey: "" };
    }
    return typeof userMessage === "string"
      ? {
          inputs: [{ source: "user_message", content: userMessage }],
          error: "",
          patternKey: ""
        }
      : {
          error: "requires agent.userMessage to be a string when provided",
          patternKey: "detection_error:invalid_input"
        };
  }

  const inputContract = PROMPT_INJECTION_INPUTS_BY_CHECKPOINT[context.checkpoint];
  if (inputContract === undefined) {
    return {
      error: "uses an unsupported checkpoint",
      patternKey: "detection_error:unsupported_checkpoint"
    };
  }

  const suppliedGovernedTexts: unknown = context.governedTexts;
  if (suppliedGovernedTexts === undefined) {
    return { inputs: [], error: "", patternKey: "" };
  }
  if (!Array.isArray(suppliedGovernedTexts)) {
    return {
      error: `requires governedTexts to be an array when provided at ${context.checkpoint}`,
      patternKey: "detection_error:invalid_input"
    };
  }
  const governedTextValues: readonly unknown[] = suppliedGovernedTexts;
  const allowedSources = new Set(inputContract.allowedSources);
  const governedTexts: GovernedTextContext[] = [];
  for (const governedText of governedTextValues) {
    if (
      !isRecord(governedText) ||
      typeof governedText.content !== "string" ||
      !allowedSources.has(governedText.source as GovernedTextSource)
    ) {
      return {
        error: `requires ${formatGovernedTextSources(inputContract.allowedSources)} governedTexts at ${context.checkpoint}`,
        patternKey: "detection_error:invalid_source"
      };
    }
    governedTexts.push({
      source: governedText.source as GovernedTextSource,
      content: governedText.content
    });
  }

  return { inputs: governedTexts, error: "", patternKey: "" };
}

function formatGovernedTextSources(sources: readonly GovernedTextSource[]): string {
  if (sources.length === 1) {
    return sources[0] ?? "a supported source";
  }
  if (sources.length === 2) {
    return `${sources[0]} or ${sources[1]}`;
  }

  return `${sources.slice(0, -1).join(", ")}, or ${sources.at(-1)}`;
}

function detectPromptInjectionInputs(
  detector: PromptInjectionDetector,
  inputs: readonly GovernedTextContext[],
  checks: readonly PromptInjectionType[]
): PromptInjectionDetection {
  const detections = inputs.map((input) => detector.detect(input.content, checks));
  if (detections.length === 1) {
    return detections[0] ?? promptInjectionFailureDetection("detection_error");
  }

  return aggregatePromptInjectionDetections(inputs, detections);
}

function aggregatePromptInjectionDetections(
  inputs: readonly GovernedTextContext[],
  detections: readonly PromptInjectionDetection[]
): PromptInjectionDetection {
  const metadata = {
    inputHash: sha256Digest(
      JSON.stringify(
        detections.map((detection, index) => [inputs[index]?.source, detection.inputHash])
      )
    ),
    inputLengthCharacters: detections.reduce(
      (total, detection) => total + detection.inputLengthCharacters,
      0
    )
  };
  const matchedTypes = PROMPT_INJECTION_TYPES.filter((type) =>
    detections.some((detection) => detection.matchedTypes.includes(type))
  );
  const matchedPatternKeys = [
    ...new Set(detections.flatMap((detection) => detection.matchedPatternKeys))
  ].sort();

  if (detections.some((detection) => detection.detectorFailed)) {
    return {
      isInjection: true,
      matchedTypes,
      matchedPatternKeys,
      detectorFailed: true,
      ...metadata,
      reason: "Detection failed closed; governed content must be blocked"
    };
  }

  if (!detections.some((detection) => detection.isInjection)) {
    return {
      isInjection: false,
      matchedTypes: [],
      matchedPatternKeys: [],
      detectorFailed: false,
      ...metadata,
      reason: "No prompt-injection signals detected"
    };
  }

  return {
    isInjection: true,
    matchedTypes,
    matchedPatternKeys,
    detectorFailed: false,
    ...metadata,
    reason: `Detected ${matchedTypes.join(", ")} across governed text segments`
  };
}

function promptInjectionFailureDetection(patternKey: string): PromptInjectionDetection {
  return {
    isInjection: true,
    matchedTypes: [],
    matchedPatternKeys: [patternKey],
    detectorFailed: true,
    inputHash: sha256Digest(""),
    inputLengthCharacters: 0,
    reason: "Detection failed closed; governed content must be blocked"
  };
}

function promptInjectionCandidateRule(
  rule: PromptInjectionPolicyRule,
  detection: PromptInjectionDetection
): PromptInjectionPolicyRule {
  if (rule.action === "deny" || !detection.matchedTypes.includes("canaryLeak")) {
    return rule;
  }

  return {
    ...rule,
    action: "deny",
    reason: "Prompt-injection canary leakage was blocked"
  };
}

function globMatches(value: string, pattern: string): boolean {
  const escapedPattern = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const expression = escapedPattern.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${expression}$`).test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
