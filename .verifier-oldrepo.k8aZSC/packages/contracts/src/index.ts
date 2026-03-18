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
