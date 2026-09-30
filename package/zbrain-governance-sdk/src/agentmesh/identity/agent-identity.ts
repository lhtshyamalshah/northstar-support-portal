import {
  createPrivateKey,
  createPublicKey,
  sign as signBuffer,
  verify as verifyBuffer
} from "node:crypto";

import { requireString, stableJsonStringify } from "../../utils/index.js";
import { assertDid, generateAgentDid, generateIdentity, normalizeAgentId } from "./did.js";
import type { IdentityKeyPair } from "./keys.js";
import {
  type AgentIdentityJSON,
  type AgentKeyMaterial,
  type DelegateAgentIdentityOptions,
  type GenerateAgentIdentityOptions,
  type IdentityStatus
} from "./types.js";

export type {
  AgentIdentityJSON,
  AgentKeyMaterial,
  DelegateAgentIdentityOptions,
  GenerateAgentIdentityOptions,
  IdentityStatus
} from "./types.js";

export class AgentIdentity {
  readonly agentDid: string;
  readonly identity: AgentKeyMaterial;
  readonly name: string;
  readonly description: string;
  readonly organization: string | undefined;
  readonly createdAt: number;
  readonly expiresAt: number | undefined;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
  readonly capabilities: readonly string[];
  status: IdentityStatus;

  private delegatedParentDid: string | undefined;
  private delegatedDepth: number;

  private constructor(input: {
    agentDid: string;
    identity: AgentKeyMaterial;
    capabilities: readonly string[];
    name: string;
    description?: string;
    organization?: string;
    status?: IdentityStatus;
    parentDid?: string;
    delegationDepth?: number;
    createdAt?: number;
    expiresAt?: number;
    metadata?: Readonly<Record<string, unknown>>;
  }) {
    this.agentDid = assertDid(input.agentDid);
    this.identity = normalizeIdentity(input.identity);
    this.capabilities = input.capabilities.map((capability) =>
      requireString(capability, "capability")
    );
    this.name = requireString(input.name, "name");
    this.description = input.description?.trim() ?? "";
    this.organization = input.organization?.trim() || undefined;
    this.status = input.status ?? "active";
    this.delegatedParentDid = input.parentDid ? assertDid(input.parentDid) : undefined;
    this.delegatedDepth = input.delegationDepth ?? 0;
    this.createdAt = normalizeTimestamp(input.createdAt, "createdAt");
    this.expiresAt =
      input.expiresAt !== undefined ? normalizeTimestamp(input.expiresAt, "expiresAt") : undefined;
    this.metadata = input.metadata;
  }

  static generate(
    agentId: string,
    capabilities: readonly string[] = [],
    options: GenerateAgentIdentityOptions = {}
  ): AgentIdentity {
    const generated = generateIdentity({ agentId });

    return AgentIdentity.fromKeyPair(agentId, generated.keyPair, capabilities, {
      ...options,
      agentDid: options.agentDid ?? generated.did
    });
  }

  static fromKeyPair(
    agentId: string,
    keyPair: IdentityKeyPair,
    capabilities: readonly string[] = [],
    options: GenerateAgentIdentityOptions = {}
  ): AgentIdentity {
    const normalizedAgentId = normalizeAgentId(agentId);

    return new AgentIdentity({
      agentDid: options.agentDid ?? generateAgentDid(normalizedAgentId, keyPair.publicKey),
      identity: {
        publicKey: keyPair.publicKey,
        privateKey: keyPair.privateKey
      },
      capabilities,
      name: options.name ?? normalizedAgentId,
      createdAt: Date.now(),
      ...(options.description ? { description: options.description } : {}),
      ...(options.organization ? { organization: options.organization } : {}),
      ...(options.expiresAt !== undefined
        ? { expiresAt: normalizeDateLike(options.expiresAt, "expiresAt") }
        : {}),
      ...(options.metadata ? { metadata: options.metadata } : {})
    });
  }

  static fromJSON(json: AgentIdentityJSON): AgentIdentity {
    return new AgentIdentity({
      agentDid: json.agentDid,
      identity: json.identity,
      capabilities: json.capabilities ?? [],
      name: json.name ?? fallbackNameFromDid(json.agentDid),
      ...(json.description ? { description: json.description } : {}),
      ...(json.organization ? { organization: json.organization } : {}),
      ...(json.status ? { status: json.status } : {}),
      ...(json.parentDid ? { parentDid: json.parentDid } : {}),
      delegationDepth: json.delegationDepth ?? 0,
      ...(json.createdAt !== undefined ? { createdAt: json.createdAt } : {}),
      ...(json.expiresAt !== undefined ? { expiresAt: json.expiresAt } : {}),
      ...(json.metadata ? { metadata: json.metadata } : {})
    });
  }

  get did(): string {
    return this.agentDid;
  }

  get publicKey(): string {
    return this.identity.publicKey;
  }

  get privateKey(): string | undefined {
    return this.identity.privateKey;
  }

  get parentDid(): string | undefined {
    return this.delegatedParentDid;
  }

  get delegationDepth(): number {
    return this.delegatedDepth;
  }

  isActive(at: Date | string | number = Date.now()): boolean {
    if (this.status !== "active") {
      return false;
    }

    if (this.expiresAt === undefined) {
      return true;
    }

    return this.expiresAt > normalizeDate(at, "at").getTime();
  }

  suspend(reason?: string): void {
    void reason;

    if (this.status === "revoked") {
      throw new Error("Cannot suspend a revoked identity");
    }

    this.status = "suspended";
  }

  revoke(reason?: string): void {
    void reason;
    this.status = "revoked";
  }

  reactivate(): void {
    if (this.status === "revoked") {
      throw new Error("Cannot reactivate a revoked identity");
    }

    this.status = "active";
  }

  hasCapability(capability: string): boolean {
    const normalizedCapability = requireString(capability, "capability");

    for (const grantedCapability of this.capabilities) {
      if (grantedCapability === "*" || grantedCapability === normalizedCapability) {
        return true;
      }

      if (grantedCapability.endsWith(":*")) {
        const prefix = grantedCapability.slice(0, -2);

        if (normalizedCapability.startsWith(`${prefix}:`)) {
          return true;
        }
      }
    }

    return false;
  }

  assertCanDelegate(capabilities: readonly string[]): void {
    for (const capability of capabilities) {
      if (!this.hasCapability(capability)) {
        throw new Error(
          `Cannot delegate capability '${capability}' — not in parent's capabilities`
        );
      }
    }
  }

  delegate(
    name: string,
    capabilities: readonly string[],
    options: DelegateAgentIdentityOptions = {}
  ): AgentIdentity {
    const normalizedName = requireString(name, "name");
    const organization = options.organization ?? this.organization;

    this.assertCanDelegate(capabilities);
    const generated = generateIdentity({ agentId: normalizedName });

    return new AgentIdentity({
      agentDid: generated.did,
      identity: {
        publicKey: generated.keyPair.publicKey,
        privateKey: generated.keyPair.privateKey
      },
      capabilities,
      name: normalizedName,
      ...(options.description ? { description: options.description } : {}),
      ...(organization ? { organization } : {}),
      parentDid: this.did,
      delegationDepth: this.delegatedDepth + 1,
      ...(options.expiresAt !== undefined
        ? { expiresAt: normalizeDateLike(options.expiresAt, "expiresAt") }
        : {}),
      ...(options.metadata ? { metadata: options.metadata } : {}),
      createdAt: Date.now()
    });
  }

  sign(payload: unknown): Uint8Array {
    if (!this.privateKey) {
      throw new Error(`Private key is not available for ${this.did}`);
    }

    const key = createPrivateKey(this.privateKey);

    return new Uint8Array(signBuffer(null, normalizePayload(payload), key));
  }

  verify(payload: unknown, signature: Uint8Array): boolean {
    try {
      const key = createPublicKey(this.publicKey);

      return verifyBuffer(null, normalizePayload(payload), key, Buffer.from(signature));
    } catch {
      return false;
    }
  }

  toJSON(): AgentIdentityJSON {
    return {
      agentDid: this.agentDid,
      identity: {
        publicKey: this.identity.publicKey
      },
      capabilities: [...this.capabilities],
      ...(this.name ? { name: this.name } : {}),
      ...(this.description ? { description: this.description } : {}),
      ...(this.organization ? { organization: this.organization } : {}),
      ...(this.status !== "active" ? { status: this.status } : {}),
      ...(this.delegatedParentDid ? { parentDid: this.delegatedParentDid } : {}),
      ...(this.delegatedDepth > 0 ? { delegationDepth: this.delegatedDepth } : {}),
      createdAt: this.createdAt,
      ...(this.expiresAt !== undefined ? { expiresAt: this.expiresAt } : {}),
      ...(this.metadata ? { metadata: this.metadata } : {})
    };
  }

  exportJSON(): AgentIdentityJSON {
    return {
      ...this.toJSON(),
      identity: this.identity.privateKey
        ? {
            publicKey: this.identity.publicKey,
            privateKey: this.identity.privateKey
          }
        : {
            publicKey: this.identity.publicKey
          }
    };
  }
}

function fallbackNameFromDid(did: string): string {
  const segments = assertDid(did).split(":");

  return segments.at(-2) ?? did;
}

function normalizeDateLike(value: Date | string | number, field: string): number {
  return normalizeDate(value, field).getTime();
}

function normalizeTimestamp(value: number | undefined, field: string): number {
  return normalizeDate(value ?? Date.now(), field).getTime();
}

function normalizeIdentity(identity: AgentKeyMaterial): AgentKeyMaterial {
  return {
    publicKey: requireString(identity.publicKey, "identity.publicKey"),
    ...(identity.privateKey
      ? { privateKey: requireString(identity.privateKey, "identity.privateKey") }
      : {})
  };
}

function normalizeDate(value: Date | string | number, field: string): Date {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(`${field} must be a valid timestamp`);
  }

  return date;
}

function normalizePayload(payload: unknown): Buffer {
  if (payload instanceof Uint8Array) {
    return Buffer.from(payload);
  }

  if (typeof payload === "string") {
    return Buffer.from(payload, "utf-8");
  }

  return Buffer.from(stableJsonStringify(payload), "utf-8");
}
