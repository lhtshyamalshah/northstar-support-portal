import type { AgentDefinition } from "../manifest/agent-defination.js";
import type { SolutionManifest } from "../manifest/solution-manifest.js";
import type { ToolDefinition } from "../manifest/tool-defination.js";
import type {
  AgentContext,
  GovernedTextContext,
  GovernedTextSource,
  HandoffContext,
  ModelContext,
  PolicyCheckpoint,
  PolicyContext,
  ToolContext,
  UsageContext
} from "./types.js";

/** Runtime-only details needed to resolve a tool invocation into policy context. */
export interface ToolContextInput {
  toolDid: string;
  arguments?: Readonly<Record<string, unknown>>;
}

export interface AgentContextInput {
  agentDid: string;
  systemPrompt?: string;
  userMessage?: string;
}

/** Runtime text explicitly labeled by its provenance for validation. */
export interface GovernedTextContextInput {
  source: GovernedTextSource;
  content: string;
}

/** Runtime-only handoff target supplied by the host. */
export interface HandoffContextInput {
  targetAgentDid: string;
}

/** SDK-owned execution totals included in an `agent_end` audit event. */
export interface AgentAuditSummary {
  toolCallsCount: number;
  llmCallCount: number;
  totalOutputTokens: number;
  totalInputTokens: number;
  totalTokens: number;
  totalCost?: number;
}

/**
 * Outcome of a completed agent, model, or tool operation.
 *
 * Deliberately two values. Audit consumers group and alert on this field, so a
 * host-invented synonym would be invisible to them rather than merely unusual.
 * The detail of a failure belongs in `statusReason`.
 */
export const BOUNDARY_STATUSES = ["completed", "failed"] as const;

/** Outcome of a completed agent, model, or tool operation. */
export type BoundaryStatus = (typeof BOUNDARY_STATUSES)[number];

/** Facts supplied by a host when it asks the policy engine for a decision. */
export interface PolicyContextInput {
  sessionId: string;
  checkpoint: PolicyCheckpoint;
  timestamp?: string;
  model?: ModelContext;
  /**
   * The acting agent. Required at every checkpoint: manifest authorization
   * rejects an unresolved calling agent before any rule matching, and every
   * audit event is attributed to this DID. The other sections stay optional
   * because different checkpoints genuinely need different facts.
   */
  agent: AgentContextInput;
  /** Untrusted, provenance-preserving text segments at a validation boundary. */
  governedTexts?: readonly GovernedTextContextInput[];
  tool?: ToolContextInput;
  handoff?: HandoffContextInput;
  /** Outcome of a completed agent, model, or tool operation. */
  status?: BoundaryStatus;
  /** Actual operation duration in milliseconds. */
  duration?: number;
  /**
   * Short explanation for a non-successful `status`, recorded on the
   * after-boundary audit event. The SDK trims it, redacts any configured
   * canary token, and truncates it, but it never inspects it further: supply a
   * failure classification, never prompts, user content, tool arguments,
   * credentials, or other governed text.
   */
  statusReason?: string;
}

/**
 * Resolves runtime DIDs against the active solution manifest.
 *
 * Callers cannot provide manifest-derived facts such as risk tier or tool
 * category. Unknown DIDs are represented explicitly as unregistered so policy
 * rules can deny them safely.
 */
export class ManifestContextResolver {
  private readonly agentsByDid: ReadonlyMap<string, AgentDefinition>;
  private readonly toolsByDid: ReadonlyMap<string, ToolDefinition>;

  constructor(manifest: SolutionManifest) {
    this.agentsByDid = new Map(manifest.agents.map((agent) => [agent.agentDid, agent]));
    this.toolsByDid = new Map(manifest.tools.map((tool) => [tool.toolDid, tool]));
  }

  resolveAgent(input: AgentContextInput): AgentContext {
    const agent = this.agentsByDid.get(input.agentDid);

    if (agent === undefined) {
      return { ...input, registered: false };
    }

    const context: AgentContext = {
      ...input,
      registered: true,
      agentKey: agent.agentKey,
      capabilities: agent.capabilities,
      tools: agent.tools,
      name: agent.name,
      riskTier: agent.riskTier,
      riskScore: agent.riskScore
    };

    if (agent.metadata !== undefined) {
      context.metadata = agent.metadata;
    }

    return context;
  }

  resolveHandoff(input: HandoffContextInput): HandoffContext {
    const agent = this.agentsByDid.get(input.targetAgentDid);

    if (agent === undefined) {
      return { targetAgentDid: input.targetAgentDid, registered: false };
    }

    const context: HandoffContext = {
      targetAgentDid: input.targetAgentDid,
      registered: true,
      agentKey: agent.agentKey,
      capabilities: agent.capabilities,
      tools: agent.tools,
      name: agent.name,
      riskTier: agent.riskTier,
      riskScore: agent.riskScore
    };

    if (agent.metadata !== undefined) {
      context.metadata = agent.metadata;
    }

    return context;
  }

  resolveTool(input: ToolContextInput): ToolContext {
    const tool = this.toolsByDid.get(input.toolDid);

    if (tool === undefined) {
      const context: ToolContext = { toolDid: input.toolDid, registered: false };

      if (input.arguments !== undefined) {
        context.arguments = input.arguments;
      }

      return context;
    }

    const context: ToolContext = {
      toolDid: input.toolDid,
      registered: true,
      key: tool.key,
      capability: tool.capability,
      resources: tool.resources,
      category: tool.category,
      riskTier: tool.riskTier
    };

    if (tool.metadata !== undefined) {
      context.metadata = tool.metadata;
    }
    if (input.arguments !== undefined) {
      context.arguments = input.arguments;
    }

    return context;
  }
}

/**
 * Storage for usage counters.
 *
 * A distributed implementation must increment every supplied key atomically.
 * The in-memory implementation is suitable for a single runtime process.
 */
export interface UsageStore {
  read(keys: readonly string[]): readonly number[];
  increment(keys: readonly string[]): readonly number[];
}

/** In-process `UsageStore` implementation for single-instance runtimes and tests. */
export class InMemoryUsageStore implements UsageStore {
  private readonly counts = new Map<string, number>();

  read(keys: readonly string[]): readonly number[] {
    return keys.map((key) => this.counts.get(key) ?? 0);
  }

  increment(keys: readonly string[]): readonly number[] {
    return keys.map((key) => {
      const next = (this.counts.get(key) ?? 0) + 1;
      this.counts.set(key, next);
      return next;
    });
  }
}

/**
 * Maintains aggregate usage from allowed runtime events.
 *
 * Call `recordToolCall` and `recordModelCall` only after the corresponding
 * action is permitted and immediately before dispatch. Pass the agent DID to
 * `recordToolCall` when the call must be included in that agent's audit
 * summary. Evaluation and recording are separate operations; this tracker
 * does not reserve usage atomically.
 */
export class SessionUsageTracker {
  private readonly agentAuditSummaries = new Map<string, AgentAuditSummaryState>();

  constructor(private readonly store: UsageStore = new InMemoryUsageStore()) {}

  getUsage(sessionId: string, agentDid?: string, toolDid?: string): UsageContext {
    const keys = [
      toolDid === undefined ? undefined : usageKey("tool", sessionId, toolDid),
      usageKey("tool-total", sessionId),
      agentDid === undefined ? undefined : usageKey("model", sessionId, agentDid),
      usageKey("turn", sessionId)
    ];
    const readableKeys = keys.filter((key): key is string => key !== undefined);
    const values = this.store.read(readableKeys);
    let index = 0;

    const perToolCallCount = toolDid === undefined ? 0 : (values[index++] ?? 0);
    const totalToolCallCount = values[index++] ?? 0;
    const modelCallPerAgentCount = agentDid === undefined ? 0 : (values[index++] ?? 0);
    const turnCount = values[index] ?? 0;

    return {
      perToolCallCount,
      totalToolCallCount,
      modelCallPerAgentCount,
      turnCount
    };
  }

  /**
   * Records an allowed tool dispatch. Supply `agentDid` to include it in that
   * agent's `agent_end` audit summary.
   */
  recordToolCall(sessionId: string, toolDid: string, agentDid?: string): UsageContext {
    this.store.increment([usageKey("tool", sessionId, toolDid), usageKey("tool-total", sessionId)]);

    if (agentDid !== undefined) {
      this.getAgentAuditSummaryState(sessionId, agentDid).toolCallsCount += 1;
    }

    return this.getUsage(sessionId, undefined, toolDid);
  }

  recordModelCall(sessionId: string, agentDid: string): UsageContext {
    this.store.increment([usageKey("model", sessionId, agentDid)]);
    return this.getUsage(sessionId, agentDid);
  }

  recordTurn(sessionId: string): UsageContext {
    this.store.increment([usageKey("turn", sessionId)]);
    return this.getUsage(sessionId);
  }

  /** Records actual token and cost totals reported after a model call completes. */
  recordModelUsage(sessionId: string, agentDid: string, model: ModelContext): AgentAuditSummary {
    const summary = this.getAgentAuditSummaryState(sessionId, agentDid);
    const inputTokens = nonNegativeNumber(model.inputTokens) ?? 0;
    const outputTokens = nonNegativeNumber(model.outputTokens) ?? 0;
    const totalTokens = nonNegativeNumber(model.totalTokens) ?? inputTokens + outputTokens;
    const cost = nonNegativeNumber(model.costUsd);

    summary.totalInputTokens += inputTokens;
    summary.totalOutputTokens += outputTokens;
    summary.totalTokens += totalTokens;

    if (cost !== undefined) {
      summary.totalCost = (summary.totalCost ?? 0) + cost;
    }

    return this.getAgentAuditSummary(sessionId, agentDid);
  }

  /** Returns a snapshot of the audit totals for one agent in one session. */
  getAgentAuditSummary(sessionId: string, agentDid?: string): AgentAuditSummary {
    const summary =
      agentDid === undefined
        ? undefined
        : this.agentAuditSummaries.get(agentAuditSummaryKey(sessionId, agentDid));
    const llmCallCount =
      agentDid === undefined ? 0 : this.getUsage(sessionId, agentDid).modelCallPerAgentCount;

    return {
      toolCallsCount: summary?.toolCallsCount ?? 0,
      llmCallCount,
      totalOutputTokens: summary?.totalOutputTokens ?? 0,
      totalInputTokens: summary?.totalInputTokens ?? 0,
      totalTokens: summary?.totalTokens ?? 0,
      ...(summary?.totalCost === undefined ? {} : { totalCost: summary.totalCost })
    };
  }

  private getAgentAuditSummaryState(sessionId: string, agentDid: string): AgentAuditSummaryState {
    const key = agentAuditSummaryKey(sessionId, agentDid);
    const existing = this.agentAuditSummaries.get(key);

    if (existing !== undefined) {
      return existing;
    }

    const created: AgentAuditSummaryState = {
      toolCallsCount: 0,
      totalOutputTokens: 0,
      totalInputTokens: 0,
      totalTokens: 0
    };
    this.agentAuditSummaries.set(key, created);
    return created;
  }
}

interface AgentAuditSummaryState {
  toolCallsCount: number;
  totalOutputTokens: number;
  totalInputTokens: number;
  totalTokens: number;
  totalCost?: number;
}

/** Builds a policy context from host facts, manifest data, and SDK-owned usage. */
export class PolicyContextBuilder {
  private readonly resolver: ManifestContextResolver;

  constructor(
    manifest: SolutionManifest,
    private readonly usageTracker: SessionUsageTracker = new SessionUsageTracker()
  ) {
    this.resolver = new ManifestContextResolver(manifest);
  }

  create(input: PolicyContextInput): PolicyContext {
    const context: PolicyContext = {
      sessionId: input.sessionId,
      timestamp: input.timestamp ?? new Date().toISOString(),
      checkpoint: input.checkpoint,
      usage: this.usageTracker.getUsage(input.sessionId, input.agent?.agentDid, input.tool?.toolDid)
    };

    if (input.model !== undefined) {
      context.model = input.model;
    }
    const resolvedAgent =
      input.agent === undefined ? undefined : this.resolver.resolveAgent(input.agent);

    if (resolvedAgent !== undefined) {
      context.agent = resolvedAgent;
    }
    const governedTexts = resolveGovernedTexts(input);
    if (governedTexts !== undefined) {
      context.governedTexts = governedTexts;
    }
    if (input.tool !== undefined) {
      context.tool = this.resolver.resolveTool(input.tool);
    }
    if (input.handoff !== undefined) {
      context.handoff = this.resolver.resolveHandoff(input.handoff);
    }

    return context;
  }

  recordToolCall(sessionId: string, toolDid: string, agentDid?: string): UsageContext {
    return this.usageTracker.recordToolCall(sessionId, toolDid, agentDid);
  }

  recordModelCall(sessionId: string, agentDid: string): UsageContext {
    return this.usageTracker.recordModelCall(sessionId, agentDid);
  }

  recordTurn(sessionId: string): UsageContext {
    return this.usageTracker.recordTurn(sessionId);
  }

  recordModelUsage(sessionId: string, agentDid: string, model: ModelContext): AgentAuditSummary {
    return this.usageTracker.recordModelUsage(sessionId, agentDid, model);
  }

  getAgentAuditSummary(sessionId: string, agentDid?: string): AgentAuditSummary {
    return this.usageTracker.getAgentAuditSummary(sessionId, agentDid);
  }
}

function resolveGovernedTexts(
  input: PolicyContextInput
): readonly GovernedTextContext[] | undefined {
  if (input.checkpoint === "agent_start") {
    return input.agent?.userMessage === undefined
      ? undefined
      : [{ source: "user_message", content: input.agent.userMessage }];
  }

  if (
    input.checkpoint !== "model_call" &&
    input.checkpoint !== "tool_result" &&
    input.checkpoint !== "model_result"
  ) {
    return undefined;
  }

  if (input.governedTexts === undefined) {
    return undefined;
  }

  return input.governedTexts.map((item) => ({ ...item }));
}

function usageKey(scope: string, sessionId: string, subjectDid?: string): string {
  return JSON.stringify(
    subjectDid === undefined ? [scope, sessionId] : [scope, sessionId, subjectDid]
  );
}

function agentAuditSummaryKey(sessionId: string, agentDid: string): string {
  return `${sessionId}\u0000${agentDid}`;
}

function nonNegativeNumber(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined;
}
