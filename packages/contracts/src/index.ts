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

export interface DraftAgentRegistrationResponse {
  agentId: string;
  approvalState: "draft";
  cardProfileId: string;
  publications: DraftEnvironmentPublicationResponse[];
  versionId: string;
  versionSequence: number;
}
