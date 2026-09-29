export {
  AgentIdentity,
  type AgentIdentityJSON,
  type AgentKeyMaterial,
  type DelegateAgentIdentityOptions,
  type GenerateAgentIdentityOptions,
  type IdentityStatus
} from "./agent-identity.js";
export {
  assertDid,
  generateAgentDid,
  generateIdentity,
  type GenerateIdentityInput,
  type GeneratedIdentity
} from "./did.js";
export {
  issueCredential,
  revokeCredential,
  rotateCredential,
  validateCredential,
  type CapabilityCredential,
  type CredentialStatus,
  type IssueCredentialInput,
  type RotateCredentialInput,
  type ValidateCredentialInput,
  type ValidateCredentialResult
} from "./credentials.js";
export { generateIdentityKeyPair, sign, verifySignature, type IdentityKeyPair } from "./keys.js";
export {
  RiskScore,
  RiskSignal,
  RiskScorer,
  type RiskLevel,
  type RiskScoreUpdateInput,
  type RiskSignalInput,
  type RiskSignalSeverity,
  type RiskScorerOptions,
  type TrustRing
} from "./risk.js";
