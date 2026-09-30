import axios, { type AxiosRequestConfig } from "axios";
import type {
  PolicyViolationLogRequest,
  RuntimeRegistrationRequest,
  RuntimeRegistrationResponse,
  ZBrainGovernanceClientOptions,
  TrustScoreUpdateRequest,
  AuditLogRequest
} from "./types.js";
import { requireString } from "../utils/index.js";
import type { FetchGovernanceBundleInput, GovernanceBundle } from "../bundle/governance-bundle.js";

/**
 * Framework-neutral HTTP client for the governance microservice.
 *
 * The client is intentionally small at this stage: it centralizes URL
 * construction, bearer authentication, JSON headers, and non-2xx error handling.
 */
export class ZBrainGovernanceClient {
  /** Normalized base URL with a trailing slash. */
  readonly baseUrl: string;

  /** Bearer token used for governance microservice API calls. */
  readonly apiKey: string;

  constructor(options: ZBrainGovernanceClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = requireString(options.apiKey, "apiKey");
  }

  /**
   * Registers the current runtime deployment and returns the initial bundle.
   *
   * @param request - Runtime registration payload.
   * @returns Registration response from the governance microservice.
   */
  async registerRuntime(request: RuntimeRegistrationRequest): Promise<RuntimeRegistrationResponse> {
    return await this.requestJson<RuntimeRegistrationResponse>("v1/api/runtime/register", {
      method: "POST",
      data: {
        ...request,
        deploymentId: `${request.deploymentId}-${request.solutionId}`,
        solutionAppId: request.solutionId
      }
    });
  }

  /**
   * Fetches the current governance bundle for a solution and environment.
   *
   * @param input - Bundle lookup parameters and optional current bundle hash.
   * @returns The bundle returned by the governance microservice.
   */
  async fetchGovernanceBundle(input: FetchGovernanceBundleInput): Promise<GovernanceBundle> {
    const url = new URL(
      `v1/api/solutions/${encodeURIComponent(input.solutionId)}/bundle`,
      this.baseUrl
    );

    url.searchParams.set("environment", input.environment);

    if (input.currentHash !== undefined) {
      url.searchParams.set("currentHash", input.currentHash);
    }

    return await this.requestJson<GovernanceBundle>(url.toString(), {
      method: "GET"
    });
  }

  /**
   * Records the audit log events with the governance microservice.
   *
   * @param request - Audit details for the checkpoint.
   */
  async postAuditLog(request: AuditLogRequest): Promise<void> {
    await this.requestJson<unknown>("v1/api/audit-logs", {
      method: "POST",
      data: request
    });
  }

  /**
   * Records a matched non-allow policy outcome with the governance microservice.
   *
   * @param request - Violation details derived from the trusted policy context.
   */
  async postViolationLog(request: PolicyViolationLogRequest): Promise<void> {
    await this.requestJson<unknown>("v1/api/violation-logs", {
      method: "POST",
      data: request
    });
  }

  async updateAgentTrustScore(request: TrustScoreUpdateRequest): Promise<void> {
    await this.requestJson<void>("v1/api/solutions/agents/trust-score", {
      method: "POST",
      data: request
    });
  }

  private async requestJson<TResponse>(
    pathOrUrl: string,
    init: AxiosRequestConfig
  ): Promise<TResponse> {
    // Keep auth, JSON headers, and error handling in one place so every control
    // plane endpoint behaves consistently.
    const url = pathOrUrl.startsWith("http")
      ? pathOrUrl
      : new URL(pathOrUrl, this.baseUrl).toString();

    const response = await axios(url, {
      ...init,
      validateStatus: () => true,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json"
      }
    });

    const envelope = parseGovernanceMicroserviceResponse(response.data);

    if (response.status < 200 || response.status >= 300 || !envelope.success) {
      throw new Error(
        `governance microservice request failed (${envelope.responseCode}): ${envelope.message}`
      );
    }

    return envelope.responseData as TResponse;
  }
}

/**
 * Creates a governance microservice client.
 *
 * @param options - Base URL and API key used for governance microservice calls.
 * @returns A configured `ZBrainGovernanceClient` instance.
 */
export function createZBrainGovernanceClient(
  options: ZBrainGovernanceClientOptions
): ZBrainGovernanceClient {
  return new ZBrainGovernanceClient(options);
}

function normalizeBaseUrl(value: string): string {
  const trimmed = requireString(value, "baseUrl");

  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

interface GovernanceMicroserviceResponse<TResponse> {
  responseData: TResponse;
  message: string;
  success: boolean;
  responseCode: number;
}

function parseGovernanceMicroserviceResponse(
  value: unknown
): GovernanceMicroserviceResponse<unknown> {
  if (
    !isRecord(value) ||
    !Object.hasOwn(value, "responseData") ||
    typeof value.message !== "string" ||
    typeof value.success !== "boolean" ||
    typeof value.responseCode !== "number" ||
    !Number.isFinite(value.responseCode)
  ) {
    throw new Error("Governance microservice response has an invalid envelope");
  }

  return {
    responseData: value.responseData,
    message: value.message,
    success: value.success,
    responseCode: value.responseCode
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
