import RE2 from "re2";

import {
  countPromptInjectionCharacters,
  normalizePromptInjectionText
} from "./prompt-injection-normalization.js";
import {
  PROMPT_INJECTION_TYPES,
  type PromptInjectionPolicyConfig,
  type PromptInjectionType
} from "./types.js";

export const MAX_PROMPT_INJECTION_PATTERN_CHARACTERS = 1_000;
export const PROMPT_INJECTION_REGEX_TIMEOUT_MILLISECONDS = 200;

const ALLOWED_CONFIG_KEYS = new Set(["blocklist", "allowlist", "additionalPatterns"]);

/** Validates static prompt-injection configuration before bundle activation. */
export function validatePromptInjectionPolicyConfig(
  config: unknown
): asserts config is PromptInjectionPolicyConfig {
  if (!isRecord(config)) {
    throw new Error("Prompt-injection policy config must be an object");
  }

  for (const key of Object.keys(config)) {
    if (!ALLOWED_CONFIG_KEYS.has(key)) {
      throw new Error("Prompt-injection policy config has unsupported field '" + key + "'");
    }
  }

  validateLiteralList(config.blocklist, "blocklist");
  validateLiteralList(config.allowlist, "allowlist");
  validateAdditionalPatterns(config.additionalPatterns);
}

/** Validates trusted host-only canaries before detector construction. */
export function validatePromptInjectionCanaryTokens(tokens: readonly string[]): void {
  const seen = new Set<string>();
  for (const token of tokens) {
    if (typeof token !== "string") {
      throw new Error("Prompt-injection runtime canaryTokens entries must be strings");
    }
    const nonWhitespaceCharacters = Array.from(token).filter(
      (character) => !/\s/u.test(character)
    ).length;
    if (nonWhitespaceCharacters < 3) {
      throw new Error(
        "Prompt-injection runtime canaryTokens entries must contain at least 3 non-whitespace characters"
      );
    }
    if (seen.has(token)) {
      throw new Error("Prompt-injection runtime canaryTokens cannot contain duplicate entries");
    }
    seen.add(token);
  }
}

function validateAdditionalPatterns(value: unknown): void {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new Error("Prompt-injection policy additionalPatterns must be an object");
  }

  for (const [type, patterns] of Object.entries(value)) {
    if (!PROMPT_INJECTION_TYPES.includes(type as PromptInjectionType)) {
      throw new Error("Prompt-injection policy has unsupported pattern category '" + type + "'");
    }
    if (!Array.isArray(patterns) || patterns.length === 0) {
      throw new Error(
        "Prompt-injection policy pattern category '" + type + "' must contain at least 1 string"
      );
    }
    const seen = new Set<string>();
    for (const pattern of patterns) {
      if (typeof pattern !== "string" || pattern.trim().length === 0) {
        throw new Error(
          "Prompt-injection policy pattern in '" + type + "' must be a non-empty string"
        );
      }
      if (countPromptInjectionCharacters(pattern) > MAX_PROMPT_INJECTION_PATTERN_CHARACTERS) {
        throw new Error(
          `Prompt-injection policy pattern in '${type}' cannot exceed ${MAX_PROMPT_INJECTION_PATTERN_CHARACTERS} characters`
        );
      }
      if (seen.has(pattern)) {
        throw new Error(
          "Prompt-injection policy pattern category '" + type + "' cannot contain duplicates"
        );
      }
      seen.add(pattern);

      try {
        const expression = new RE2(pattern, "imu");
        if (expression.test("")) {
          throw new Error("empty match");
        }
      } catch {
        throw new Error(
          "Prompt-injection policy has an invalid or unsupported regex in category '" + type + "'"
        );
      }

      const nonWhitespaceCharacters = Array.from(pattern).filter(
        (character) => !/\s/u.test(character)
      ).length;
      if (nonWhitespaceCharacters < 3) {
        throw new Error(
          "Prompt-injection policy pattern in '" +
            type +
            "' must contain at least 3 non-whitespace characters"
        );
      }
    }
  }
}

function validateLiteralList(value: unknown, name: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value)) {
    throw new Error("Prompt-injection policy " + name + " must be an array");
  }
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(`Prompt-injection policy ${name} entries must be strings`);
    }

    const normalized = normalizePromptInjectionText(entry);
    const normalizedLength = Array.from(normalized).filter(
      (character) => !/\s/u.test(character)
    ).length;
    if (normalizedLength < 3) {
      throw new Error(
        `Prompt-injection policy ${name} entries must contain at least 3 normalized non-whitespace characters`
      );
    }
    if (seen.has(normalized)) {
      throw new Error(`Prompt-injection policy ${name} cannot contain duplicate entries`);
    }
    seen.add(normalized);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
