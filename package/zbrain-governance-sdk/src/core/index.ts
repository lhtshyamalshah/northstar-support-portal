import cron, { type ScheduledTask } from "node-cron";
import { createZBrainGovernanceClient, type ZBrainGovernanceClient } from "./client.js";
import { registerDeployment } from "./registration.js";
import { computeJsonSha256Hash, failStartup, requireString } from "../utils/index.js";
import { loadSolutionManifest, type SolutionManifest } from "../manifest/solution-manifest.js";
import type {
  AuditBoundaryStatus,
  AuditLogData,
  AuditViolationDetails,
  CallbackEndpoints,
  RuntimeRegistrationRequest
} from "./types.js";
import type { GovernanceBundle } from "../bundle/governance-bundle.js";
import { validateGovernanceBundle } from "../policy-engine/bundle-validation.js";
import { PolicyEvaluator } from "../policy-engine/evaluator.js";
import {
  BOUNDARY_STATUSES,
  PolicyContextBuilder,
  SessionUsageTracker,
  type AgentAuditSummary,
  type BoundaryStatus,
  type PolicyContextInput
} from "../policy-engine/context.js";
import type {
  CustomPolicyHandler,
  PolicyContext,
  PolicyDecision,
  PromptInjectionRuntimeOptions
} from "../policy-engine/types.js";

const GOVERNANCE_GLOBAL_KEY = Symbol.for("zbrain.governance");
const STATUS_REASON_MAX_CHARACTERS = 500;
const DEFAULT_CRON_TIME = "0 */6 * * *";

/**
 * Runtime governance state stored globally after successful initialization.
 */
export interface ActiveGovernanceHandle {
  /** Always `true` for an initialized active handle. */
  enabled: true;

  /** Authenticated governance microservice client used by the SDK. */
  client: ZBrainGovernanceClient;

  /** Stable solution identifier used by governance microservice requests. */
  solutionId: string;

  /** Deployment identifier associated with audit events from this runtime. */
  deploymentId: string;

  /** Callback placeholder strings submitted during runtime registration. */
  callbacks: CallbackEndpoints;

  /** Currently active governance bundle. Replaced after a successful refresh. */
  bundle: GovernanceBundle;

  /** Locally registered handlers keyed by their custom policy rule name. */
  customPolicyHandlers: Readonly<Record<string, CustomPolicyHandler>>;

  /**
   * Evaluates host inputs through the manifest-backed governance engine.
   *
   * This is intentionally the active SDK entry point instead of exposing the
   * raw evaluator, so callers cannot forge manifest-derived facts such as tool
   * registration, risk tier, or agent authorization.
   */
  policyEngine: GovernancePolicyEngine;

  /** Solution manifest loaded from `GovernanceOptions.manifestPath`. */
  manifest?: SolutionManifest;

  /** Deterministic hash of the loaded solution manifest. */
  manifestHash?: string;

  /** Cron expression used to refresh the governance bundle. */
  cronTime: string;

  /** Scheduled task that re-registers and refreshes the active bundle and engine. */
  scheduledTask: ScheduledTask;

  /**
   * Re-registers the deployment and validates and constructs the next engine
   * before replacing the active bundle and engine.
   *
   * This is used by the scheduled cron job and can also be called manually by
   * integrators that want an immediate refresh after a deployment event.
   */
  refreshBundle(): Promise<GovernanceBundle>;
}

/**
 * The manifest-bound enforcement surface used by an initialized runtime.
 *
 * Hosts provide only runtime inputs such as DIDs, arguments, model facts, and
 * a session ID. Manifest facts and session usage are derived inside this
 * object before the bundle is evaluated.
 */
export class GovernancePolicyEngine {
  constructor(
    private readonly contextBuilder: PolicyContextBuilder,
    private readonly policyEvaluator: PolicyEvaluator,
    /** Trusted local canaries, redacted from a host-supplied `statusReason`. */
    private readonly canaryTokens: readonly string[] = []
  ) {}

  /** Builds a trusted context from host input and evaluates the active bundle. */
  async evaluate(input: PolicyContextInput): Promise<PolicyDecision> {
    const context = this.contextBuilder.create(input);
    const authorizationFailure = findManifestAuthorizationFailure(context);
    const decision =
      authorizationFailure === undefined
        ? await this.policyEvaluator.evaluate(context)
        : manifestAuthorizationDenied(context, authorizationFailure);

    this.recordModelAuditUsage(context);
    await this.reportViolation(context, decision);
    await this.auditLog(context, decision, input.status, input.duration, input.statusReason);

    return decision;
  }

  private async reportViolation(context: PolicyContext, decision: PolicyDecision): Promise<void> {
    const governance = maybeGetGovernance();
    const { matchedRule, matchedRuleId, matchedRuleLevel } = decision;

    // Reporting uses the client held by the active global governance handle,
    // just like registration and bundle refresh. A manually constructed or
    // superseded engine must not report through another active runtime.
    if (
      governance === undefined ||
      decision.action === "allow" ||
      matchedRule === undefined ||
      matchedRuleLevel === undefined
    ) {
      return;
    }

    const ruleId = matchedRuleId?.trim() || matchedRule;

    try {
      await governance.client.postViolationLog({
        action: decision.action,
        solutionAppId: governance.solutionId,
        timestamp: context.timestamp,
        sessionId: context.sessionId,
        deploymentId: governance.deploymentId,
        checkpoint: context.checkpoint,
        agentDid: context.agent?.agentDid ?? "",
        policyLevel: matchedRuleLevel,
        ruleId,
        // Violation records carry rule diagnostics only; audit events carry
        // any additional evaluator metadata.
        matchedRules: decision.matchedRules,
        resolutionTrace: decision.resolutionTrace
      });
    } catch (error) {
      // A telemetry failure must not turn an already enforced decision into a
      // transport error or relax a denial.
      console.error("Unable to log governance policy violation", error);
    }
  }

  private async auditLog(
    context: PolicyContext,
    decision: PolicyDecision,
    status?: BoundaryStatus,
    duration?: number,
    statusReason?: string
  ): Promise<void> {
    const governance = maybeGetGovernance();
    const agentSummary = this.contextBuilder.getAgentAuditSummary(
      context.sessionId,
      context.agent?.agentDid
    );
    const data = createAuditLogData(
      context,
      decision,
      status,
      duration,
      agentSummary,
      sanitizeStatusReason(statusReason, this.canaryTokens)
    );

    // Reporting uses the client held by the active global governance handle,
    // just like registration and bundle refresh. A manually constructed or
    // superseded engine must not report through another active runtime.
    if (governance === undefined) {
      return;
    }

    try {
      await governance.client.postAuditLog({
        solutionAppId: governance.solutionId,
        sessionId: context.sessionId,
        deploymentId: governance.deploymentId,
        data
      });
    } catch (error) {
      // A telemetry failure must not turn an already enforced decision into a
      // transport error or relax a denial.
      console.error("Unable to log governance audit event", error);
    }
  }

  /**
   * Records an allowed tool dispatch for usage calculations and, when supplied,
   * the calling agent's audit summary.
   */
  recordToolCall(sessionId: string, toolDid: string, agentDid?: string): void {
    this.contextBuilder.recordToolCall(sessionId, toolDid, agentDid);
  }

  /** Records an allowed model call for subsequent SDK-owned usage calculations. */
  recordModelCall(sessionId: string, agentDid: string): void {
    this.contextBuilder.recordModelCall(sessionId, agentDid);
  }

  /** Records an observed agent turn for subsequent SDK-owned usage calculations. */
  recordTurn(sessionId: string): void {
    this.contextBuilder.recordTurn(sessionId);
  }

  private recordModelAuditUsage(context: PolicyContext): void {
    if (
      context.checkpoint !== "model_result" ||
      context.agent === undefined ||
      context.model === undefined
    ) {
      return;
    }

    this.contextBuilder.recordModelUsage(context.sessionId, context.agent.agentDid, context.model);
  }
}

/**
 * Process-wide governance handle returned by the SDK.
 *
 * Governance is fail-closed. If runtime governance cannot start, the SDK calls
 * `process.exit(1)` instead of returning a disabled handle.
 */
export type GovernanceHandle = ActiveGovernanceHandle;

/**
 * Environment configuration used by `initializeGovernanceSDK`.
 */
export interface GovernanceEnv {
  /** governance microservice base URL. */
  baseUrl: string;

  /** governance microservice API key. */
  apiKey: string;

  /** Stable solution identifier for this runtime. */
  solutionId: string;

  /** Deployment identifier for this runtime. */
  deploymentId: string;

  /** Cron expression used to refresh the bundle by re-registering the runtime. */
  cronTime: string;
}

const getGovernanceEnv = (): GovernanceEnv => {
  const baseUrl = process.env.ZBRAIN_GOVERNANCE_BASE_URL;
  const apiKey = process.env.ZBRAIN_GOVERNANCE_API_KEY;
  const solutionId = process.env.ZBRAIN_GOVERNANCE_SOLUTION_ID;
  const deploymentId = process.env.ZBRAIN_GOVERNANCE_DEPLOYMENT_ID;
  const cronTime = process.env.CRON_TIME?.trim() || DEFAULT_CRON_TIME;

  return {
    baseUrl: requireStartupString(baseUrl, "ZBRAIN_GOVERNANCE_BASE_URL"),
    apiKey: requireStartupString(apiKey, "ZBRAIN_GOVERNANCE_API_KEY"),
    solutionId: requireStartupString(solutionId, "ZBRAIN_GOVERNANCE_SOLUTION_ID"),
    deploymentId: requireStartupString(deploymentId, "ZBRAIN_GOVERNANCE_DEPLOYMENT_ID"),
    cronTime: requireCronTime(cronTime)
  };
};

/**
 * Inputs required to initialize governance in a running solution.
 */
export interface GovernanceOptions {
  /** Required callback placeholders submitted during runtime registration. */
  callbacks: CallbackEndpoints;

  /** Path to the solution manifest JSON file. */
  manifestPath: string;

  /** Trusted local handlers keyed by custom solution policy rule name. */
  customPolicyHandlers?: Readonly<Record<string, CustomPolicyHandler>>;

  /** Trusted local prompt-injection secrets that are never loaded from a policy bundle. */
  promptInjection?: PromptInjectionRuntimeOptions;
}

/**
 * Registers the running deployment, loads its bundle, and stores the handle globally.
 *
 * @param options - Manifest path, callback placeholders, and optional trusted local handlers.
 * @returns The active governance handle.
 */
export async function initializeGovernanceSDK(
  options: GovernanceOptions
): Promise<ActiveGovernanceHandle> {
  const env = getGovernanceEnv();

  const client = createZBrainGovernanceClient({
    baseUrl: env.baseUrl,
    apiKey: env.apiKey
  });

  const solutionManifest = await loadSolutionManifest(options.manifestPath);
  const manifestHash = computeJsonSha256Hash(solutionManifest);
  const customPolicyHandlers = options.customPolicyHandlers ?? {};
  const promptInjection = copyPromptInjectionRuntimeOptions(options.promptInjection);
  const usageTracker = new SessionUsageTracker();

  const registrationInput: RuntimeRegistrationRequest = {
    solutionId: env.solutionId,
    deploymentId: env.deploymentId,
    callbacks: options.callbacks,
    solutionManifest,
    manifestHash
  };

  const registration = await registerDeployment(client, registrationInput).catch((error: unknown) =>
    failStartup("Unable to register governance runtime", error)
  );
  await validateInitialBundle(registration.bundle, customPolicyHandlers);
  const initialPolicyEngine = createInitialPolicyEngine(
    solutionManifest,
    registration.bundle,
    customPolicyHandlers,
    usageTracker,
    promptInjection
  );

  const handle = {} as ActiveGovernanceHandle;

  handle.enabled = true;
  handle.client = client;
  handle.solutionId = env.solutionId;
  handle.deploymentId = env.deploymentId;
  handle.callbacks = options.callbacks;
  handle.bundle = registration.bundle;
  handle.customPolicyHandlers = customPolicyHandlers;
  handle.policyEngine = initialPolicyEngine;
  handle.manifest = solutionManifest;
  handle.manifestHash = manifestHash;
  handle.cronTime = env.cronTime;
  handle.refreshBundle = async () => {
    const nextRegistration = await registerDeployment(client, registrationInput);

    await validateGovernanceBundle(nextRegistration.bundle, customPolicyHandlers);
    const nextPolicyEngine = createPolicyEngine(
      solutionManifest,
      nextRegistration.bundle,
      customPolicyHandlers,
      usageTracker,
      promptInjection
    );
    handle.bundle = nextRegistration.bundle;
    handle.policyEngine = nextPolicyEngine;
    return handle.bundle;
  };
  handle.scheduledTask = scheduleBundleRefresh(handle);

  setGovernance(handle);

  return handle;
}

/**
 * Reads the initialized governance handle.
 *
 * @returns The active governance handle.
 * @throws When `initializeGovernanceSDK` has not been called yet.
 */
export function getGovernance(): GovernanceHandle {
  const handle = maybeGetGovernance();

  if (handle === undefined) {
    throw new Error("Governance has not been initialized");
  }

  return handle;
}

/**
 * Returns the process-wide governance handle if initialization has already run.
 *
 * @returns The current governance handle, or `undefined` before initialization.
 */
export function maybeGetGovernance(): GovernanceHandle | undefined {
  return globalStore()[GOVERNANCE_GLOBAL_KEY];
}

/**
 * Clears the process-wide governance handle.
 *
 * This is mainly useful in tests or controlled application shutdown flows.
 */
export function clearGovernance(): void {
  const handle = maybeGetGovernance();

  if (handle !== undefined) {
    destroyScheduledTask(handle.scheduledTask);
  }

  delete globalStore()[GOVERNANCE_GLOBAL_KEY];
}

function setGovernance(handle: GovernanceHandle): void {
  globalStore()[GOVERNANCE_GLOBAL_KEY] = handle;
}

function globalStore(): Record<PropertyKey, GovernanceHandle | undefined> {
  return globalThis as unknown as Record<PropertyKey, GovernanceHandle | undefined>;
}

function requireStartupString(value: unknown, field: string): string {
  try {
    return requireString(value, field);
  } catch (error) {
    return failStartup(error instanceof Error ? error.message : `${field} is required`);
  }
}

function requireCronTime(value: string): string {
  if (!cron.validate(value)) {
    return failStartup(`CRON_TIME must be a valid cron expression. Received: ${value}`);
  }

  return value;
}

function scheduleBundleRefresh(handle: ActiveGovernanceHandle): ScheduledTask {
  return cron.schedule(
    handle.cronTime,
    async () => {
      try {
        await handle.refreshBundle();
      } catch (error) {
        console.error("Unable to refresh governance bundle; keeping the active bundle", error);
      }
    },
    {
      name: "zbrain-governance-bundle-refresh",
      noOverlap: true,
      unref: true
    }
  );
}

function destroyScheduledTask(task: ScheduledTask): void {
  void Promise.resolve(task.destroy()).catch((error: unknown) => {
    console.error("Unable to destroy governance cron task", error);
  });
}

async function validateInitialBundle(
  bundle: GovernanceBundle,
  customPolicyHandlers: Readonly<Record<string, CustomPolicyHandler>>
): Promise<void> {
  try {
    await validateGovernanceBundle(bundle, customPolicyHandlers);
  } catch (error) {
    failStartup("Unable to load governance policy bundle", error);
  }
}

function createPolicyEngine(
  manifest: SolutionManifest,
  bundle: GovernanceBundle,
  customPolicyHandlers: Readonly<Record<string, CustomPolicyHandler>>,
  usageTracker: SessionUsageTracker,
  promptInjection: PromptInjectionRuntimeOptions | undefined
): GovernancePolicyEngine {
  return new GovernancePolicyEngine(
    new PolicyContextBuilder(manifest, usageTracker),
    new PolicyEvaluator({
      rules: bundle.rules,
      customPolicyHandlers,
      ...(promptInjection === undefined ? {} : { promptInjection })
    }),
    promptInjection?.canaryTokens ?? []
  );
}

function createInitialPolicyEngine(
  manifest: SolutionManifest,
  bundle: GovernanceBundle,
  customPolicyHandlers: Readonly<Record<string, CustomPolicyHandler>>,
  usageTracker: SessionUsageTracker,
  promptInjection: PromptInjectionRuntimeOptions | undefined
): GovernancePolicyEngine {
  try {
    return createPolicyEngine(
      manifest,
      bundle,
      customPolicyHandlers,
      usageTracker,
      promptInjection
    );
  } catch (error) {
    return failStartup("Unable to construct governance policy engine", error);
  }
}

function copyPromptInjectionRuntimeOptions(
  options: PromptInjectionRuntimeOptions | undefined
): PromptInjectionRuntimeOptions | undefined {
  if (options === undefined) {
    return undefined;
  }

  return {
    ...(options.canaryTokens === undefined ? {} : { canaryTokens: [...options.canaryTokens] })
  };
}

/**
 * Enforces manifest integrity before policy matching.
 *
 * Registration and the agent-to-tool relationship are deployment facts, not
 * policy-controlled permissions. A permissive solution rule can therefore
 * never authorize an unknown agent/tool or a tool outside an agent's declared
 * allowlist.
 */
function findManifestAuthorizationFailure(context: PolicyContext): string | undefined {
  if (context.agent?.registered !== true) {
    return "The calling agent is not registered in the solution manifest";
  }

  if (context.checkpoint === "tool_call") {
    if (context.tool?.registered !== true) {
      return "The requested tool is not registered in the solution manifest";
    }

    if (context.agent.tools?.includes(context.tool.toolDid) !== true) {
      return "The calling agent is not authorized for the requested tool";
    }
  }

  if (context.checkpoint === "handoff" && context.handoff?.registered !== true) {
    return "The handoff target is not registered in the solution manifest";
  }

  return undefined;
}

function manifestAuthorizationDenied(context: PolicyContext, reason: string): PolicyDecision {
  return {
    allowed: false,
    action: "deny",
    checkpoint: context.checkpoint,
    matchedRules: [],
    conflictDetected: false,
    resolutionTrace: [`Manifest authorization denied: ${reason}`],
    reason
  };
}

function createAuditViolationDetails(decision: PolicyDecision): AuditViolationDetails | undefined {
  if (decision.action === "allow") {
    return undefined;
  }

  // Unexpected exceptions can include governed content in their messages.
  // Preserve the local decision while excluding that text from telemetry.
  const reason = decision.reason.startsWith("Policy evaluation error:")
    ? "Policy evaluation failed closed"
    : decision.reason;

  return {
    action: decision.action,
    reason,
    ...(decision.matchedRule === undefined ? {} : { matchedRule: decision.matchedRule }),
    ...(decision.matchedRuleId === undefined ? {} : { matchedRuleId: decision.matchedRuleId }),
    ...(decision.matchedRuleLevel === undefined
      ? {}
      : { matchedRuleLevel: decision.matchedRuleLevel }),
    matchedRules: decision.matchedRules,
    conflictDetected: decision.conflictDetected,
    resolutionTrace: decision.resolutionTrace.map((step) =>
      step === `Fail closed: ${decision.reason}` ? `Fail closed: ${reason}` : step
    ),
    ...(decision.auditData === undefined ? {} : { auditData: decision.auditData })
  };
}

/**
 * Prepares a host-supplied failure explanation for telemetry.
 *
 * A provider or tool error can quote the request that produced it, so the
 * configured canaries are redacted here rather than trusting every host to do
 * it, and the text is bounded so one exception cannot dominate an audit event.
 */
function sanitizeStatusReason(
  value: string | undefined,
  canaryTokens: readonly string[]
): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const redacted = canaryTokens.reduce(
    (text, token) => (token === "" ? text : text.split(token).join("[redacted]")),
    value.trim()
  );

  return redacted === "" ? undefined : redacted.slice(0, STATUS_REASON_MAX_CHARACTERS);
}

/**
 * Resolves the host-reported outcome of an after-boundary.
 *
 * Every after-boundary is recorded. A JavaScript host is not held to
 * `BoundaryStatus`, and any host can omit the fields entirely, so an unusable
 * outcome becomes `unknown` with a note rather than a dropped event: losing
 * the event would hide the very integration bug that produced it. The SDK
 * still never invents a duration — an unusable one is simply absent.
 */
function executionAudit(
  status: BoundaryStatus | undefined,
  duration: number | undefined,
  statusReason: string | undefined
): { status: AuditBoundaryStatus; duration?: number; statusReason?: string } {
  const knownStatus = BOUNDARY_STATUSES.includes(status as BoundaryStatus);
  let note: string | undefined;

  if (!knownStatus) {
    note =
      status === undefined
        ? "Host reported no status for this boundary"
        : `Host reported an unsupported status: ${String(status)}`;
    console.error(`Governance audit event recorded as 'unknown': ${note}`);
  }

  const reason = [note, statusReason].filter((part) => part !== undefined).join("; ");

  return {
    status: knownStatus ? (status as BoundaryStatus) : "unknown",
    ...(typeof duration === "number" && Number.isFinite(duration) && duration >= 0
      ? { duration }
      : {}),
    ...(reason === "" ? {} : { statusReason: reason })
  };
}

function createAuditLogData(
  context: PolicyContext,
  decision: PolicyDecision,
  status: BoundaryStatus | undefined,
  duration: number | undefined,
  agentSummary: AgentAuditSummary,
  statusReason?: string
): AuditLogData {
  const metadata = decision.auditData;
  const violationDetails = createAuditViolationDetails(decision);
  const base = {
    timestamp: context.timestamp,
    // Every audit event carries the acting agent: an event that cannot be
    // attributed to one cannot be audited. `name` is manifest-resolved, so it is
    // empty only when the DID does not resolve — which is itself a denial.
    agentDid: context.agent?.agentDid ?? "",
    agentName: context.agent?.name ?? "",
    policyViolation: decision.action !== "allow",
    ...(violationDetails === undefined ? {} : { violationDetails }),
    ...(metadata === undefined ? {} : { metadata })
  };

  switch (context.checkpoint) {
    case "agent_start":
      return {
        ...base,
        checkpoint: "agent_start",
        tools: context.agent?.tools ?? []
      };
    case "agent_end":
      return {
        ...base,
        checkpoint: "agent_end",
        ...executionAudit(status, duration, statusReason),
        summary: agentSummary
      };
    case "model_call":
      return {
        ...base,
        checkpoint: "model_call",
        modelName: context.model?.name ?? "",
        modelProvider: context.model?.provider ?? "",
        estimatedInputTokens: context.model?.inputTokens ?? 0
      };
    case "model_result": {
      const cost = context.model?.costUsd;

      return {
        ...base,
        checkpoint: "model_result",
        modelName: context.model?.name ?? "",
        ...executionAudit(status, duration, statusReason),
        outputTokens: context.model?.outputTokens ?? 0,
        totalTokens: context.model?.totalTokens ?? 0,
        inputTokens: context.model?.inputTokens ?? 0,
        ...(cost === undefined ? {} : { cost })
      };
    }
    case "tool_call":
      return {
        ...base,
        checkpoint: "tool_call",
        toolName: context.tool?.key ?? context.tool?.toolDid ?? ""
      };
    case "tool_result":
      return {
        ...base,
        checkpoint: "tool_result",
        toolName: context.tool?.key ?? context.tool?.toolDid ?? "",
        ...executionAudit(status, duration, statusReason)
      };
    case "handoff":
      return {
        ...base,
        checkpoint: "handoff",
        targetAgentDid: context.handoff?.targetAgentDid ?? "",
        targetAgentName: context.handoff?.name ?? context.handoff?.targetAgentDid ?? ""
      };
  }
}
