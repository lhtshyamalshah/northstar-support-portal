const CONTROL_CHARACTER = /\p{Cc}/u;
const COMBINING_MARK = /\p{M}/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;

/**
 * Common single-code-point homoglyphs used to disguise ASCII instructions.
 *
 * This intentionally stays small and auditable. It is not a general-purpose
 * transliterator and does not turn arbitrary non-Latin text into English.
 */
const ASCII_CONFUSABLES: Readonly<Record<string, string>> = {
  // Cyrillic
  а: "a",
  в: "b",
  е: "e",
  ё: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ј: "j",
  ѕ: "s",
  ӏ: "l",
  // Greek
  α: "a",
  β: "b",
  ε: "e",
  ι: "i",
  κ: "k",
  ν: "v",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "y",
  χ: "x"
};

const LEET_SUBSTITUTIONS_WITH_I: Readonly<Record<string, string>> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "l"
};

const LEET_SUBSTITUTIONS_WITH_L: Readonly<Record<string, string>> = {
  ...LEET_SUBSTITUTIONS_WITH_I,
  "1": "l"
};

const LEET_SUBSTITUTIONS_WITH_AMBIGUOUS_ONE: Readonly<Record<string, string>> = {
  "0": "o",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "@": "a",
  $: "s",
  "!": "i",
  "|": "l"
};

/** Applies the AGT normalization baseline plus bounded diacritic/confusable folding. */
export function normalizePromptInjectionText(text: string): string {
  let normalized = "";
  let pendingSpace = false;

  for (const inputCharacter of text) {
    const widthNormalized = normalizeWidthCharacter(inputCharacter);

    if (shouldStripFromDetection(widthNormalized)) {
      continue;
    }

    for (const decomposedCharacter of widthNormalized.normalize("NFKD").toLowerCase()) {
      if (COMBINING_MARK.test(decomposedCharacter)) {
        continue;
      }
      const character = ASCII_CONFUSABLES[decomposedCharacter] ?? decomposedCharacter;
      if (shouldStripFromDetection(character)) {
        continue;
      }
      if (/\s/u.test(character)) {
        pendingSpace = true;
        continue;
      }
      if (pendingSpace && normalized.length > 0) {
        normalized += " ";
      }
      normalized += character;
      pendingSpace = false;
    }
  }

  return normalized;
}

/**
 * Builds compact views for high-specificity signatures in visibly obfuscated
 * text. Two views are needed because the common leetspeak digit `1` can mean
 * either `i` or `l`.
 */
export function normalizePromptInjectionCompactViews(text: string): readonly string[] {
  const normalized = normalizePromptInjectionText(text);
  return [
    compactWithSubstitutions(normalized, LEET_SUBSTITUTIONS_WITH_I),
    compactWithSubstitutions(normalized, LEET_SUBSTITUTIONS_WITH_L),
    compactWithSubstitutions(normalized, LEET_SUBSTITUTIONS_WITH_AMBIGUOUS_ONE)
  ].filter((value, index, values) => value.length > 0 && values.indexOf(value) === index);
}

/** Returns whether aggressive compact matching is justified for this input. */
export function looksLikePromptInjectionObfuscation(text: string): boolean {
  const normalized = normalizePromptInjectionText(text);
  const characters = Array.from(normalized);
  const letterCount = characters.filter((character) => /\p{L}/u.test(character)).length;
  const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const leetCount = tokens
    .filter((token) => /\p{L}/u.test(token) && Array.from(token).length <= 16)
    .reduce(
      (count, token) =>
        count + Array.from(token).filter((character) => /[013457]/u.test(character)).length,
      0
    );
  const singleCharacterTokens = tokens.filter((token) => Array.from(token).length === 1).length;
  const hasWhitespace = /\s/u.test(normalized);

  return (
    (letterCount >= 24 && !hasWhitespace) ||
    (letterCount >= 12 && leetCount >= 3) ||
    (letterCount >= 12 && singleCharacterTokens >= 8)
  );
}

/** Counts Unicode scalar values rather than UTF-16 code units. */
export function countPromptInjectionCharacters(text: string): number {
  return Array.from(text).length;
}

/** Returns whether a character is alphanumeric for blocklist token boundaries. */
export function isPromptInjectionTokenCharacter(character: string | undefined): boolean {
  return character !== undefined && LETTER_OR_NUMBER.test(character);
}

function normalizeWidthCharacter(character: string): string {
  const codePoint = character.codePointAt(0);

  if (codePoint === 0x3000) {
    return " ";
  }
  if (codePoint !== undefined && codePoint >= 0xff01 && codePoint <= 0xff5e) {
    return String.fromCodePoint(codePoint - 0xfee0);
  }

  return character;
}

function compactWithSubstitutions(
  text: string,
  substitutions: Readonly<Record<string, string>>
): string {
  let compact = "";

  for (const character of text) {
    const substituted = substitutions[character] ?? character;
    if (LETTER_OR_NUMBER.test(substituted)) {
      compact += substituted;
    }
  }

  return compact;
}

function shouldStripFromDetection(character: string): boolean {
  const codePoint = character.codePointAt(0);

  if (codePoint === undefined) {
    return false;
  }

  const ignoredFormattingCharacter =
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x206f) ||
    codePoint === 0xfeff;

  return (
    ignoredFormattingCharacter || (CONTROL_CHARACTER.test(character) && !/\s/u.test(character))
  );
}
