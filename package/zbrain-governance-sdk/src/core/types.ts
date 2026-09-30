import type { GovernanceBundle } from "../bundle/governance-bundle.js";
import type { SolutionManifest } from "../manifest/solution-manifest.js";
import type { AgentAuditSummary, BoundaryStatus } from "../policy-engine/context.js";

/**
 * Outcome recorded on an after-boundary audit event.
 *
 * `unknown` is SDK-set and means the host reported no usable outcome. It is
 * not a `BoundaryStatus`, so a host cannot send it; the event is still
 * recorded, because a missing audit event hides the integration bug that
 * caused it.
 */
export type AuditBoundaryStatus = BoundaryStatus | "unknown";
import type {
  PolicyAction,
  PolicyCheckpoint,
  PolicyDecision,
  PolicyLevel
} from "../policy-engine/types.js";

/**
 * Configuration required to call the ZBrain governance microservice.
 */
export interface ZBrainGovernanceClientOptions {
  /** Base URL for the governance microservice, for example `https://cp.example.com`. */
  baseUrl: string;

  /** API key sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
}

/**
 * Required registration placeholders reserved for future runtime callbacks.
 *
 * The current SDK submits these strings during runtime registration but does
 * not create routes, authenticate callbacks, or implement kill-switch state.
 */
export interface CallbackEndpoints {
  /** Placeholder reserved for a future bundle-update callback contract. */
  bundleUpdateUrl: string;

  /** Placeholder reserved for a future kill-switch callback contract. */
  killSwitchUrl: string;
}

/**
 * Payload sent by the SDK when a runtime instance starts.
 *
 */
export interface RuntimeRegistrationRequest {
  /** Stable solution identifier configured for this deployment. */
  solutionId: string;

  /** Deployed runtime or deployment identifier. */
  deploymentId: string;

  /** Required placeholder strings reserved for future callback contracts. */
  callbacks: CallbackEndpoints;

  /** Deterministic hash of `solutionManifest`, formatted as `sha256:<hex>`. */
  manifestHash?: string;

  /** Solution manifest content loaded by the SDK at startup. */
  solutionManifest: SolutionManifest;
}

/**
 * Response returned by runtime registration.
 */
export interface RuntimeRegistrationResponse {
  /** Deployment identifier acknowledged by the governance microservice. */
  deploymentId: string;

  /** Initial governance bundle for local enforcement. */
  bundle: GovernanceBundle;
}

/** Decision diagnostics attached whenever an audit event reports a violation. */
export interface AuditViolationDetails extends Pick<
  PolicyDecision,
  | "reason"
  | "matchedRule"
  | "matchedRuleId"
  | "matchedRuleLevel"
  | "matchedRules"
  | "conflictDetected"
  | "resolutionTrace"
  | "auditData"
> {
  action: Exclude<PolicyAction, "allow">;
}

/** Fields shared by all supported governance audit events. */
export interface AuditLogBase<TCheckpoint extends PolicyCheckpoint = PolicyCheckpoint> {
  /** Lifecycle checkpoint at which the policy outcome occurred. */
  checkpoint: TCheckpoint;

  /** ISO-8601 timestamp captured while building the policy context. */
  timestamp: string;

  /**
   * Calling agent DID, or an empty string when the boundary has no agent.
   *
   * Present on every audit event: an event that cannot be attributed to an
   * agent cannot be audited. Every checkpoint requires a registered calling
   * agent, so this is empty only for a manifest-authorization denial.
   */
  agentDid: string;

  /**
   * Human-readable agent name resolved from the manifest, or an empty string
   * when the DID does not resolve. Never host-supplied.
   */
  agentName: string;

  /** Caller-safe facts supplied by a matching policy evaluator, when present. */
  metadata?: Readonly<Record<string, unknown>>;

  /** Whether a non-allow policy outcome was selected for this checkpoint. */
  policyViolation: boolean;

  /** Present on SDK-emitted non-allow events; omitted for allow decisions. */
  violationDetails?: AuditViolationDetails;
}

/** Audit event emitted before an agent turn begins. */
export interface BeforeAgentLog extends AuditLogBase<"agent_start"> {
  tools: readonly string[];
}

/** Audit event emitted when an agent turn ends. */
export interface AfterAgentLog extends AuditLogBase<"agent_end"> {
  /** Outcome of the completed agent operation, or `unknown` if unreported. */
  status: AuditBoundaryStatus;
  /** Host-measured agent-operation duration in ms; absent if unreported. */
  duration?: number;
  /** Redacted, truncated host explanation for a non-successful `status`. */
  statusReason?: string;
  /** SDK-owned execution totals for this agent in the current session. */
  summary: AgentAuditSummary;
}

/** Audit event emitted before dispatching a model call. */
export interface BeforeModelLog extends AuditLogBase<"model_call"> {
  modelName: string;
  modelProvider: string;
  estimatedInputTokens: number;
}

/** Audit event emitted after evaluating a model result. */
export interface AfterModelLog extends AuditLogBase<"model_result"> {
  modelName: string;
  /** Outcome of the completed model operation, or `unknown` if unreported. */
  status: AuditBoundaryStatus;
  /** Host-measured model-operation duration in ms; absent if unreported. */
  duration?: number;
  /** Redacted, truncated host explanation for a non-successful `status`. */
  statusReason?: string;
  outputTokens: number;
  totalTokens: number;
  inputTokens: number;
  cost?: number;
}

/** Audit event emitted before dispatching a tool call. */
export interface BeforeToolLog extends AuditLogBase<"tool_call"> {
  toolName: string;
}

/** Audit event emitted after evaluating a tool result. */
export interface AfterToolLog extends AuditLogBase<"tool_result"> {
  toolName: string;
  /** Outcome of the completed tool operation, or `unknown` if unreported. */
  status: AuditBoundaryStatus;
  /** Host-measured tool-operation duration in ms; absent if unreported. */
  duration?: number;
  /** Redacted, truncated host explanation for a non-successful `status`. */
  statusReason?: string;
}

/** Audit event emitted before transferring control to another agent. */
export interface HandoffLog extends AuditLogBase<"handoff"> {
  targetAgentName: string;
  targetAgentDid: string;
}

/** A lifecycle event currently accepted by the governance audit-log endpoint. */
export type AuditLogData =
  | BeforeAgentLog
  | AfterAgentLog
  | BeforeModelLog
  | AfterModelLog
  | BeforeToolLog
  | AfterToolLog
  | HandoffLog;

/** Payload sent to the governance microservice audit-log endpoint. */
export interface AuditLogRequest {
  /** Stable identifier for the active solution. */
  solutionAppId: string;

  /** Deployed runtime or deployment identifier. */
  deploymentId: string;

  /** Host run/session identifier for the governed boundary. */
  sessionId: string;

  data: AuditLogData;
}

/** A policy outcome recorded by the governance microservice for audit and monitoring. */
export interface PolicyViolationLogRequest {
  /** Effective action selected by the matched policy rule. */
  action: PolicyAction;

  /** Stable identifier for the active solution. */
  solutionAppId: string;

  /** Deployed runtime or deployment identifier. */
  deploymentId: string;

  /** ISO-8601 timestamp captured while building the policy context. */
  timestamp: string;

  /** Host run/session identifier for the governed boundary. */
  sessionId: string;

  /** Lifecycle checkpoint at which the policy outcome occurred. */
  checkpoint: PolicyCheckpoint;

  /** Calling agent DID, or an empty string when the boundary has no agent. */
  agentDid: string;

  /** Authority level of the winning rule. */
  policyLevel: PolicyLevel;

  /** Governance-microservice `_id` of the winning policy rule. */
  ruleId: string;

  /**
   * Every matching candidate in resolution order, winner first.
   *
   * Shows what else applied at this boundary, so a violation can be diagnosed
   * without replaying the governed content that triggered it.
   */
  matchedRules: readonly string[];

  /** Deterministic diagnostic steps for the decision. Contains no governed text. */
  resolutionTrace: readonly string[];
}

export interface TrustScoreUpdateRequest {
  agentDid: string;
  trustScore: {
    score: number;
    ring: number | string;
    dimensions: {
      policyCompliance: number;
      resourceEfficiency: number;
      outputQuality: number;
      securityPosture: number;
      collaborationHealth: number;
    };
    calculatedAt: number;
  };
}
