import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { requireString, stableJsonStringify } from "../../utils/index.js";
import { assertDid } from "./did.js";
import type {
  CapabilityCredential,
  IssueCredentialInput,
  RotateCredentialInput,
  ValidateCredentialInput,
  ValidateCredentialResult
} from "./types.js";

export type {
  CapabilityCredential,
  CredentialStatus,
  IssueCredentialInput,
  RotateCredentialInput,
  ValidateCredentialInput,
  ValidateCredentialResult
} from "./types.js";

interface CredentialVaultState {
  credentials: CapabilityCredential[];
}

const DEFAULT_STATE: CredentialVaultState = {
  credentials: []
};

export async function issueCredential(
  vaultPath: string,
  input: IssueCredentialInput
): Promise<CapabilityCredential> {
  const state = await loadJsonFile(vaultPath, DEFAULT_STATE);
  const issuedAt = normalizeTimestamp(input.issuedAt ?? Date.now(), "issuedAt");
  const expiresAt = normalizeExpiry(issuedAt, input.expiresAt, input.ttlMinutes);
  const credential: CapabilityCredential = {
    credentialId: randomUUID(),
    agentDid: assertDid(input.agentDid),
    scopes: normalizeItems(input.scopes, "scope"),
    resources: normalizeItems(input.resources, "resource"),
    status: "active",
    issuedAt,
    expiresAt
  };

  state.credentials.push(credential);
  await saveJsonFile(vaultPath, state);

  return credential;
}

export async function validateCredential(
  vaultPath: string,
  input: ValidateCredentialInput
): Promise<ValidateCredentialResult> {
  const state = await loadJsonFile(vaultPath, DEFAULT_STATE);
  const credential = state.credentials.find(
    (candidate) => candidate.credentialId === requireString(input.credentialId, "credentialId")
  );

  if (credential === undefined) {
    return { valid: false, reason: "credential_not_found" };
  }

  if (input.agentDid && credential.agentDid !== assertDid(input.agentDid)) {
    return { valid: false, credential, reason: "agent_mismatch" };
  }

  if (credential.status !== "active") {
    return { valid: false, credential, reason: "credential_inactive" };
  }

  const at = normalizeDate(input.at).getTime();

  if (credential.expiresAt <= at) {
    const expiredCredential: CapabilityCredential = { ...credential, status: "expired" };
    state.credentials = state.credentials.map((candidate) =>
      candidate.credentialId === credential.credentialId ? expiredCredential : candidate
    );
    await saveJsonFile(vaultPath, state);

    return { valid: false, credential: expiredCredential, reason: "credential_expired" };
  }

  if (input.scope && !credential.scopes.includes(requireString(input.scope, "scope"))) {
    return { valid: false, credential, reason: "scope_denied" };
  }

  const resource = input.resource ? requireString(input.resource, "resource") : undefined;

  if (resource && !credential.resources.some((pattern) => matchesResource(pattern, resource))) {
    return { valid: false, credential, reason: "resource_denied" };
  }

  return { valid: true, credential };
}

export async function rotateCredential(
  vaultPath: string,
  input: RotateCredentialInput
): Promise<CapabilityCredential> {
  const state = await loadJsonFile(vaultPath, DEFAULT_STATE);
  const existingCredential = findCredential(state, input.credentialId);

  if (existingCredential.status !== "active") {
    throw new Error(`Credential ${existingCredential.credentialId} is not active`);
  }

  const replacementInput: IssueCredentialInput = {
    agentDid: existingCredential.agentDid,
    scopes: input.scopes ?? existingCredential.scopes,
    resources: input.resources ?? existingCredential.resources,
    ...(input.issuedAt !== undefined ? { issuedAt: input.issuedAt } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.ttlMinutes ? { ttlMinutes: input.ttlMinutes } : {})
  };
  const replacement = await issueCredential(vaultPath, replacementInput);
  const refreshedState = await loadJsonFile(vaultPath, DEFAULT_STATE);

  refreshedState.credentials = refreshedState.credentials.map((candidate) =>
    candidate.credentialId === existingCredential.credentialId
      ? {
          ...candidate,
          status: "rotated",
          rotatedToCredentialId: replacement.credentialId
        }
      : candidate
  );
  await saveJsonFile(vaultPath, refreshedState);

  return replacement;
}

export async function revokeCredential(
  vaultPath: string,
  credentialId: string,
  reason?: string
): Promise<CapabilityCredential> {
  const state = await loadJsonFile(vaultPath, DEFAULT_STATE);
  const existingCredential = findCredential(state, credentialId);
  const revokedCredential: CapabilityCredential = {
    ...existingCredential,
    status: "revoked",
    revokedAt: Date.now(),
    ...(reason ? { revocationReason: reason } : {})
  };

  state.credentials = state.credentials.map((candidate) =>
    candidate.credentialId === existingCredential.credentialId ? revokedCredential : candidate
  );
  await saveJsonFile(vaultPath, state);

  return revokedCredential;
}

function findCredential(state: CredentialVaultState, credentialId: string): CapabilityCredential {
  const normalizedCredentialId = requireString(credentialId, "credentialId");
  const credential = state.credentials.find(
    (candidate) => candidate.credentialId === normalizedCredentialId
  );

  if (credential === undefined) {
    throw new Error(`Credential ${normalizedCredentialId} was not found`);
  }

  return credential;
}

function normalizeItems(values: readonly string[], field: string): readonly string[] {
  if (values.length === 0) {
    throw new Error(`At least one ${field} is required`);
  }

  return values.map((value) => requireString(value, field));
}

function normalizeExpiry(
  issuedAt: number,
  expiresAt: Date | string | number | undefined,
  ttlMinutes: number | undefined
): number {
  if (expiresAt !== undefined) {
    return normalizeTimestamp(expiresAt, "expiresAt");
  }

  const ttl = ttlMinutes ?? 15;

  if (!Number.isFinite(ttl) || ttl <= 0) {
    throw new Error("ttlMinutes must be a positive number");
  }

  return issuedAt + ttl * 60_000;
}

function normalizeTimestamp(value: Date | string | number, field: string): number {
  const timestamp = normalizeDate(value);

  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`${field} must be a valid timestamp`);
  }

  return timestamp.getTime();
}

function normalizeDate(value: Date | string | number | undefined): Date {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());

  if (Number.isNaN(date.getTime())) {
    throw new Error("at must be a valid timestamp");
  }

  return date;
}

function matchesResource(pattern: string, resource: string): boolean {
  const normalizedPattern = requireString(pattern, "resource");
  const normalizedResource = requireString(resource, "resource");
  const expression = new RegExp(`^${escapeRegex(normalizedPattern).replaceAll("*", ".*")}$`, "u");

  return expression.test(normalizedResource);
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

async function loadJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const content = await readFile(filePath, "utf-8");

    return JSON.parse(content) as T;
  } catch (error) {
    if (isMissingFile(error)) {
      return structuredClone(fallback);
    }

    throw error;
  }
}

async function saveJsonFile(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${stableJsonStringify(value)}\n`, "utf-8");
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
