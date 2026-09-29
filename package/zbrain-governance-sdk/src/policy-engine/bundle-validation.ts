import { validatePromptInjectionPolicyConfig } from "./prompt-injection.js";
import {
  ENTERPRISE_POLICY_CONDITION_FIELDS,
  POLICY_CHECKPOINTS,
  POLICY_OPERATORS,
  PROMPT_INJECTION_TYPES,
  VALIDATION_LIFECYCLE_CHECKPOINT,
  normalizePolicyLevel,
  type CustomPolicyHandler,
  type PolicyConfig,
  type PolicyConfigValue,
  type PolicyValue
} from "./types.js";

/** Validates an untrusted governance microservice bundle before it becomes active. */
export async function validateGovernanceBundle(
  bundle: unknown,
  customPolicyHandlers: Readonly<Record<string, CustomPolicyHandler>> = {}
): Promise<void> {
  if (!isRecord(bundle)) {
    throw new Error("Governance bundle must be an object");
  }
  requireString(bundle.version, "Governance bundle version");
  requireString(bundle.hash, "Governance bundle hash");
  if (!Array.isArray(bundle.rules)) {
    throw new Error("Governance bundle rules must be an array");
  }

  const ruleNames = new Set<string>();
  for (const rule of bundle.rules) {
    const name = await validatePolicyRule(rule, customPolicyHandlers);

    if (ruleNames.has(name)) {
      throw new Error(`Governance bundle contains duplicate policy rule name '${name}'`);
    }

    ruleNames.add(name);
  }
}

async function validatePolicyRule(
  rule: unknown,
  customPolicyHandlers: Readonly<Record<string, CustomPolicyHandler>>
): Promise<string> {
  if (!isRecord(rule)) {
    throw new Error("Policy rule must be an object");
  }

  const name = requireString(rule.name, "Policy rule name");
  if (rule._id !== undefined && typeof rule._id !== "string") {
    throw new Error(`Policy rule '${name}' _id must be a string`);
  }
  const kind = rule.kind ?? "context";
  if (
    kind !== "validation" &&
    !POLICY_CHECKPOINTS.includes(rule.checkpoint as (typeof POLICY_CHECKPOINTS)[number])
  ) {
    throw new Error(`Policy rule '${name}' has an unsupported checkpoint`);
  }
  const level = normalizePolicyLevel(rule.level);
  if (level === undefined) {
    throw new Error(`Policy rule '${name}' has an unsupported level`);
  }
  if (typeof rule.priority !== "number" || !Number.isFinite(rule.priority)) {
    throw new Error(`Policy rule '${name}' priority must be a finite number`);
  }
  if (typeof rule.enabled !== "boolean") {
    throw new Error(`Policy rule '${name}' enabled must be a boolean`);
  }
  if (
    rule.action !== "allow" &&
    rule.action !== "audit" &&
    rule.action !== "warn" &&
    rule.action !== "deny"
  ) {
    throw new Error(`Policy rule '${name}' has an unsupported action`);
  }
  requireString(rule.reason, `Policy rule '${name}' reason`);

  if (kind === "custom") {
    await validateCustomPolicyRule(rule, name, level, customPolicyHandlers);
    return name;
  }

  if (kind === "validation") {
    validatePromptInjectionPolicyRule(rule, name);
    return name;
  }

  if (kind !== "context") {
    throw new Error(`Policy rule '${name}' has an unsupported kind`);
  }
  if (!isRecord(rule.condition)) {
    throw new Error(`Policy rule '${name}' condition must be an object`);
  }

  validateCondition(rule.condition, level, name);
  return name;
}

function validatePromptInjectionPolicyRule(rule: Record<string, unknown>, name: string): void {
  if (rule.checkpoint !== VALIDATION_LIFECYCLE_CHECKPOINT) {
    throw new Error(
      `Prompt-injection policy rule '${name}' must use the '${VALIDATION_LIFECYCLE_CHECKPOINT}' checkpoint`
    );
  }
  if (rule.action === "allow") {
    throw new Error(`Prompt-injection policy rule '${name}' cannot use the 'allow' action`);
  }

  validatePromptInjectionValidationCondition(rule.condition, name);

  if (rule.config !== undefined) {
    validatePromptInjectionPolicyConfig(rule.config);
  }
}

function validatePromptInjectionValidationCondition(value: unknown, ruleName: string): void {
  if (!isRecord(value)) {
    throw new Error(`Prompt-injection policy rule '${ruleName}' condition must be an object`);
  }

  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "checks") {
    throw new Error(
      `Prompt-injection policy rule '${ruleName}' condition must contain only 'checks'`
    );
  }

  const checksOperator = value.checks;
  if (!isRecord(checksOperator)) {
    throw new Error(
      `Prompt-injection policy rule '${ruleName}' condition checks must be an object`
    );
  }
  const operatorKeys = Object.keys(checksOperator);
  if (operatorKeys.length !== 1 || operatorKeys[0] !== "in") {
    throw new Error(
      `Prompt-injection policy rule '${ruleName}' condition checks must contain only 'in'`
    );
  }

  const selectedChecks = checksOperator.in;
  if (!Array.isArray(selectedChecks) || selectedChecks.length === 0) {
    throw new Error(
      `Prompt-injection policy rule '${ruleName}' condition checks.in must be a non-empty array`
    );
  }
  const uniqueChecks = new Set<string>();
  for (const inputValidation of selectedChecks) {
    if (
      typeof inputValidation !== "string" ||
      !PROMPT_INJECTION_TYPES.includes(inputValidation as (typeof PROMPT_INJECTION_TYPES)[number])
    ) {
      throw new Error(
        `Prompt-injection policy rule '${ruleName}' has an unsupported input validation '${String(inputValidation)}'`
      );
    }
    if (uniqueChecks.has(inputValidation)) {
      throw new Error(
        `Prompt-injection policy rule '${ruleName}' condition checks.in cannot contain duplicates`
      );
    }
    uniqueChecks.add(inputValidation);
  }
}

async function validateCustomPolicyRule(
  rule: Record<string, unknown>,
  name: string,
  level: "enterprise" | "solution",
  customPolicyHandlers: Readonly<Record<string, CustomPolicyHandler>>
): Promise<void> {
  if (level !== "solution") {
    throw new Error(`Custom policy rule '${name}' must have solution level`);
  }
  if (!isPolicyConfig(rule.config)) {
    throw new Error(`Custom policy rule '${name}' config must be a JSON object`);
  }
  const handler = customPolicyHandlers[name];
  if (handler === undefined) {
    throw new Error(`Custom policy handler is not registered for rule '${name}'`);
  }
  if (typeof handler.validateConfig !== "function" || typeof handler.evaluate !== "function") {
    throw new Error(`Custom policy handler for rule '${name}' is invalid`);
  }

  await handler.validateConfig(rule.config);
}

function validateCondition(
  condition: Record<string, unknown>,
  level: unknown,
  ruleName: string
): void {
  for (const [path, operators] of Object.entries(condition)) {
    validatePath(path, level, ruleName);
    if (!isRecord(operators)) {
      throw new Error(`Policy rule '${ruleName}' condition '${path}' must be an object`);
    }
    validateOperators(operators, ruleName, path);
  }
}

function validatePath(path: string, level: unknown, ruleName: string): void {
  if (path.length === 0 || path.split(".").some(isUnsafePathSegment)) {
    throw new Error(`Policy rule '${ruleName}' has an unsafe condition path '${path}'`);
  }
  if (level === "enterprise" && !ENTERPRISE_POLICY_CONDITION_FIELDS.includes(path as never)) {
    throw new Error(`Enterprise policy rule '${ruleName}' cannot use condition path '${path}'`);
  }
}

function validateOperators(
  operators: Record<string, unknown>,
  ruleName: string,
  path: string
): void {
  const entries = Object.entries(operators);
  if (entries.length === 0) {
    throw new Error(`Policy rule '${ruleName}' condition '${path}' must include an operator`);
  }

  for (const [operator, value] of entries) {
    if (!POLICY_OPERATORS.includes(operator as (typeof POLICY_OPERATORS)[number])) {
      throw new Error(`Policy rule '${ruleName}' uses unsupported operator '${operator}'`);
    }
    if (!isOperatorValueValid(operator, value)) {
      throw new Error(`Policy rule '${ruleName}' has invalid '${operator}' value for '${path}'`);
    }
    if (operator === "regex-match") {
      try {
        new RegExp(String(value));
      } catch {
        throw new Error(`Policy rule '${ruleName}' has an invalid regex for '${path}'`);
      }
    }
  }
}

function isOperatorValueValid(operator: string, value: unknown): boolean {
  if (operator === "gt" || operator === "lt" || operator === "gte" || operator === "lte") {
    return typeof value === "number" && Number.isFinite(value);
  }
  if (operator === "in") {
    return Array.isArray(value) && value.every(isPolicyValue);
  }
  if (operator === "regex-match" || operator === "glob-match") {
    return typeof value === "string";
  }
  return isPolicyValue(value);
}

function isPolicyConfig(value: unknown): value is PolicyConfig {
  return isRecord(value) && Object.values(value).every(isPolicyConfigValue);
}

function isPolicyConfigValue(value: unknown): value is PolicyConfigValue {
  return (
    isPolicyValue(value) ||
    (Array.isArray(value) && value.every(isPolicyConfigValue)) ||
    (isRecord(value) && Object.values(value).every(isPolicyConfigValue))
  );
}

function isPolicyValue(value: unknown): value is PolicyValue {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isUnsafePathSegment(segment: string): boolean {
  return (
    segment.length === 0 ||
    segment === "__proto__" ||
    segment === "constructor" ||
    segment === "prototype"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}
