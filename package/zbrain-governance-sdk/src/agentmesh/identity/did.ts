import { createHash } from "node:crypto";

import { requireString } from "../../utils/index.js";
import { generateIdentityKeyPair, type IdentityKeyPair } from "./keys.js";

export interface GeneratedIdentity {
  did: string;
  keyPair: IdentityKeyPair;
}

export interface GenerateIdentityInput {
  agentId?: string;
}

export function assertDid(value: string): string {
  const did = requireString(value, "did");

  if (!/^did:[a-z0-9]+:[A-Za-z0-9._:%-]+(?:[:/][A-Za-z0-9._~!$&'()*+,;=:@%-]+)*$/u.test(did)) {
    throw new Error(`Invalid DID: ${did}`);
  }

  return did;
}

export function generateIdentity(input: GenerateIdentityInput = {}): GeneratedIdentity {
  const keyPair = generateIdentityKeyPair();
  const did = generateAgentDid(input.agentId ?? "agent", keyPair.publicKey);

  return {
    did: assertDid(did),
    keyPair
  };
}

export function generateAgentDid(agentId: string, publicKey: string): string {
  const normalizedAgentId = normalizeAgentId(agentId);
  const fingerprint = createHash("sha256").update(publicKey, "utf-8").digest("hex").slice(0, 16);

  return `did:mesh:${normalizedAgentId}:${fingerprint}`;
}

export function normalizeAgentId(value: string): string {
  return requireString(value, "agentId").replace(/\s+/gu, "-").toLowerCase();
}
