export const supportedEnvironments = ["dev", "test", "staging", "prod"] as const;
export const tenantEnvironmentKeyPattern = /^[a-z][a-z0-9-]{0,31}$/;
export const tenantEnvironmentKeyValidationMessage =
  "Environment keys must be 1-32 characters of lowercase letters, numbers, or hyphens, and must start with a letter.";

export type EnvironmentKey = (typeof supportedEnvironments)[number];

export interface ServiceManifest {
  name: string;
  port: number;
  summary: string;
}

export interface WorkspaceModule {
  description: string;
  kind: "app" | "package";
  name: string;
}

export interface TenantEnvironment {
  environmentKey: string;
}

export interface ListTenantEnvironmentsResponse {
  environments: TenantEnvironment[];
}

export interface CreateTenantEnvironmentRequest {
  environmentKey: string;
}

export interface CreateTenantEnvironmentResponse {
  environment: TenantEnvironment;
}

export function isValidTenantEnvironmentKey(value: string): boolean {
  return tenantEnvironmentKeyPattern.test(value);
}

export const contextContractTypes = [
  "string",
  "number",
  "boolean",
  "object",
  "array",
] as const;

export type ContextContractType = (typeof contextContractTypes)[number];

export interface HeaderContractEntry {
  description: string;
  name: string;
  required: boolean;
  source: string;
}

export interface ContextContractEntry {
  description: string;
  example?: unknown;
  key: string;
  required: boolean;
  type: ContextContractType;
}

function isContractObjectEntry(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeHeaderContract(contract: unknown): HeaderContractEntry[] {
  if (!Array.isArray(contract)) {
    return [];
  }

  return contract
    .filter(isContractObjectEntry)
    .filter(
      (entry) =>
        typeof entry.description === "string" &&
        typeof entry.name === "string" &&
        typeof entry.required === "boolean" &&
        typeof entry.source === "string",
    )
    .map((entry) => ({
      description: entry.description as string,
      name: entry.name as string,
      required: entry.required as boolean,
      source: entry.source as string,
    }));
}

export function normalizeContextContract(contract: unknown): ContextContractEntry[] {
  if (!Array.isArray(contract)) {
    return [];
  }

  return contract
    .filter(isContractObjectEntry)
    .filter(
      (entry) =>
        typeof entry.description === "string" &&
        typeof entry.key === "string" &&
        typeof entry.required === "boolean" &&
        typeof entry.type === "string",
    )
    .map((entry) => ({
      description: entry.description as string,
      example: entry.example,
      key: entry.key as string,
      required: entry.required as boolean,
      type: entry.type as ContextContractType,
    }));
}

export interface DraftEnvironmentPublicationRequest {
  environmentKey: string;
  healthEndpointUrl: string;
  invocationEndpoint?: string;
  rawCard: string;
}

export interface CreateDraftAgentRequest {
  capabilities: string[];
  cardProfileId?: string;
  contextContract: ContextContractEntry[];
  displayName: string;
  headerContract: HeaderContractEntry[];
  publications: DraftEnvironmentPublicationRequest[];
  requiredRoles: string[];
  requiredScopes: string[];
  summary: string;
  tags: string[];
  versionLabel: string;
}

export interface CreateDraftVersionRequest extends CreateDraftAgentRequest {}

export interface DraftEnvironmentPublicationResponse {
  environmentKey: string;
  publicationId: string;
}

export type ApprovalState = "draft" | "pending_review" | "approved" | "rejected";

export interface DraftAgentRegistrationResponse {
  agentId: string;
  approvalState: "draft";
  cardProfileId: string;
  publications: DraftEnvironmentPublicationResponse[];
  versionId: string;
  versionSequence: number;
}

export interface RejectAgentVersionRequest {
  reason: string;
}

export interface VersionReviewMetadata {
  approvedAt: string | null;
  approvedBy: string | null;
  rejectedAt: string | null;
  rejectedBy: string | null;
  rejectedReason: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
}

export interface VersionLifecycleResponse {
  activeVersionId: string | null;
  agentId: string;
  approvalState: ApprovalState;
  versionId: string;
}

export interface TenantPolicyOverlay {
  agentId: string;
  deprecated: boolean;
  disabled: boolean;
  environmentKey: string | null;
  requiredRoles: string[];
  requiredScopes: string[];
}

export interface TenantPolicyOverlayResponse {
  overlay: TenantPolicyOverlay;
}

export interface PublicationTelemetrySummary {
  errorCount: number;
  invocationCount: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  recordedAt: string;
  successCount: number;
  windowEndedAt: string;
  windowStartedAt: string;
}

export interface UpsertPublicationTelemetryRequest {
  errorCount: number;
  invocationCount: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  successCount: number;
  windowEndedAt: string;
  windowStartedAt: string;
}

export interface UpsertPublicationTelemetryResponse {
  telemetry: PublicationTelemetrySummary;
}

export interface AdminDetailPublicationSummary {
  environmentKey: string;
  healthEndpointUrl: string;
  healthStatus: string | null;
  publicationId: string;
  telemetry: PublicationTelemetrySummary[];
}

export interface AgentAdminVersionSummary {
  approvalState: ApprovalState;
  versionId: string;
  versionSequence: number;
}

export interface AgentAdminActiveVersion {
  approvalState: ApprovalState;
  publications: AdminDetailPublicationSummary[];
  review: VersionReviewMetadata;
  versionId: string;
  versionSequence: number;
}

export interface AgentAdminDetailResponse {
  activeVersion: AgentAdminActiveVersion | null;
  activeVersionId: string | null;
  agentId: string;
  overlay: {
    agent: {
      deprecated: boolean;
      disabled: boolean;
      requiredRoles: string[];
      requiredScopes: string[];
    };
    environments: Array<{
      deprecated: boolean;
      disabled: boolean;
      environmentKey: string;
      requiredRoles: string[];
      requiredScopes: string[];
    }>;
  };
  versions: AgentAdminVersionSummary[];
}

export interface VersionAdminDetailPublication {
  environmentKey: string;
  healthEndpointUrl: string;
  healthStatus: string | null;
  invocationEndpoint: string | null;
  normalizedMetadata: unknown;
  publicationId: string;
  rawCard: string;
  telemetry: PublicationTelemetrySummary[];
}

export interface VersionAdminDetailResponse {
  active: boolean;
  agentId: string;
  approvalState: ApprovalState;
  cardProfileId: string;
  contextContract: unknown[];
  displayName: string;
  headerContract: unknown[];
  publications: VersionAdminDetailPublication[];
  requiredRoles: string[];
  requiredScopes: string[];
  review: VersionReviewMetadata;
  summary: string;
  tags: string[];
  versionId: string;
  versionLabel: string;
  versionSequence: number;
}

export type HealthStatus = "unknown" | "healthy" | "degraded" | "unreachable";

export type DiscoveryPublicationStatus =
  | "approved_active"
  | "approved_inactive"
  | "draft"
  | "pending_review"
  | "rejected";

export type DiscoveryHealthStatus = HealthStatus;

export interface DiscoveryPublication {
  activeVersionId: string;
  agentId: string;
  capabilities: string[];
  contextContract: ContextContractEntry[];
  deprecated: boolean;
  displayName: string;
  environmentKey: string;
  headerContract: HeaderContractEntry[];
  healthStatus: DiscoveryHealthStatus;
  invocationEndpoint: string | null;
  publisherId: string;
  rawCard?: string;
  rawCardAvailable: boolean;
  requiredRoles: string[];
  requiredScopes: string[];
  status: DiscoveryPublicationStatus;
  summary: string;
  tags: string[];
}

export interface DiscoveryPublicationListResponse {
  items: DiscoveryPublication[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AgentPublicationDetailResponse {
  activeVersionId: string;
  agentId: string;
  publication: DiscoveryPublication;
}

export interface AgentPublicationPreflightRequest {
  context?: Record<string, unknown>;
  includeRawCard?: boolean;
}

export interface AgentPublicationPreflightResponse {
  activeVersionId: string;
  agentId: string;
  authorized: boolean;
  deprecated: boolean;
  environmentKey: string;
  healthStatus: DiscoveryHealthStatus;
  missingRequiredContextKeys: string[];
  rawCard?: string;
  rawCardAvailable: boolean;
  ready: boolean;
  unresolvedRequiredHeaderSources: string[];
}

export interface PublicationHealthHistoryEntry {
  checkedAt: string;
  error: string | null;
  ok: boolean;
  statusCode: number | null;
}

export interface PublicationHealthDetailResponse {
  current: {
    consecutiveFailures: number;
    healthStatus: HealthStatus;
    lastCheckedAt: string | null;
    lastError: string | null;
    lastSuccessAt: string | null;
    recentFailures: number;
  };
  environmentKey: string;
  history: PublicationHealthHistoryEntry[];
  publicationId: string;
}
