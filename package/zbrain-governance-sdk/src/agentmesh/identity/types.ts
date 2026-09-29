export type IdentityStatus = "active" | "suspended" | "revoked";

export type TrustRing = 0 | 1 | 2 | 3;
export type TrustLevel = "verified_partner" | "trusted" | "standard" | "untrusted";

export interface RingAssignment {
  ring: TrustRing;
  trustLevel: TrustLevel;
  minimumScore: number;
}

export interface AgentKeyMaterial {
  publicKey: string;
  privateKey?: string;
}

export interface AgentIdentityJSON {
  agentDid: string;
  identity: AgentKeyMaterial;
  capabilities?: string[];
  name?: string;
  description?: string;
  organization?: string;
  status?: IdentityStatus;
  parentDid?: string;
  delegationDepth?: number;
  createdAt?: number;
  expiresAt?: number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface GenerateAgentIdentityOptions {
  agentDid?: string;
  capabilities?: readonly string[];
  name?: string;
  description?: string;
  organization?: string;
  expiresAt?: Date | string | number;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface DelegateAgentIdentityOptions {
  description?: string;
  organization?: string;
  expiresAt?: Date | string | number;
  metadata?: Readonly<Record<string, unknown>>;
}

export type CredentialStatus = "active" | "rotated" | "revoked" | "expired";

export interface CapabilityCredential {
  credentialId: string;
  agentDid: string;
  scopes: readonly string[];
  resources: readonly string[];
  status: CredentialStatus;
  issuedAt: number;
  expiresAt: number;
  rotatedToCredentialId?: string;
  revokedAt?: number;
  revocationReason?: string;
}

export interface IssueCredentialInput {
  agentDid: string;
  scopes: readonly string[];
  resources: readonly string[];
  issuedAt?: Date | string | number;
  expiresAt?: Date | string | number;
  ttlMinutes?: number;
}

export interface ValidateCredentialInput {
  credentialId: string;
  agentDid?: string;
  scope?: string;
  resource?: string;
  at?: Date | string | number;
}

export interface ValidateCredentialResult {
  valid: boolean;
  credential?: CapabilityCredential;
  reason?:
    | "credential_not_found"
    | "agent_mismatch"
    | "credential_inactive"
    | "credential_expired"
    | "scope_denied"
    | "resource_denied";
}

export interface RotateCredentialInput {
  credentialId: string;
  scopes?: readonly string[];
  resources?: readonly string[];
  issuedAt?: Date | string | number;
  expiresAt?: Date | string | number;
  ttlMinutes?: number;
}
