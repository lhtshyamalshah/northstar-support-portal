import { createHash } from "node:crypto";

/**
 * Returns a trimmed string or throws a field-specific error.
 *
 * Use this at SDK boundaries where empty strings would produce invalid control
 * plane requests, for example API keys, base URLs, solution IDs, and deployment
 * IDs.
 *
 * @param value - Candidate value.
 * @param field - Human-readable field name used in the error message.
 * @returns The trimmed non-empty string.
 */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} is required`);
  }

  return value.trim();
}

/**
 * Computes a deterministic SHA-256 hash for JSON-like data.
 *
 * Object keys are sorted before hashing so the same manifest content produces
 * the same `sha256:<hex>` value even if object properties were authored in a
 * different order.
 *
 * @param value - Parsed JSON-compatible value.
 * @returns A content hash with the `sha256:` prefix expected by the governance microservice.
 */
export function computeJsonSha256Hash(value: unknown): string {
  return sha256Digest(stableJsonStringify(value));
}

export function sha256Digest(value: string): string {
  const hash = createHash("sha256");
  hash.update(value);

  return `sha256:${hash.digest("hex")}`;
}

/**
 * Stringifies JSON-like data with stable object key ordering.
 *
 * @param value - Parsed JSON-compatible value.
 * @returns A deterministic JSON string.
 */
export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonValue(value[key])])
    );
  }

  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function failStartup(message: string, cause?: unknown): never {
  console.error(message);

  if (cause !== undefined) {
    console.error(cause);
  }

  process.exit(1);
}
