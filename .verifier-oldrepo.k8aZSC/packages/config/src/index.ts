import type { EnvironmentKey, ServiceManifest } from "@agent-registry/contracts";
import { supportedEnvironments } from "@agent-registry/contracts";

export type DeploymentMode = "hosted" | "self-hosted";

export interface HealthProbeConfig {
  allowPrivateTargets: boolean;
  degradedThreshold: number;
  failureWindow: number;
  intervalSeconds: number;
  method: "GET";
  requireHttps: boolean;
  timeoutSeconds: number;
}

export interface BootstrapInputConfig {
  hostedManifestFile?: string;
  selfHostedBootstrapFile?: string;
}

export interface RegistryConfig {
  bootstrap: BootstrapInputConfig;
  databaseUrl: string;
  deploymentMode: DeploymentMode;
  healthProbe: HealthProbeConfig;
  rawCardByteLimit: number;
}

export interface LoadRegistryConfigOptions {
  requireBootstrapFile?: boolean;
}

export const registryServiceDefaults = {
  databaseUrl: "postgres://registry:registry@postgres:5432/agent_registry",
  deploymentMode: "hosted" as DeploymentMode,
  healthProbeDegradedThreshold: 1,
  healthProbeFailureWindow: 3,
  healthProbeIntervalSeconds: 60,
  healthProbeMethod: "GET" as const,
  healthProbeTimeoutSeconds: 5,
  rawCardByteLimit: 256 * 1024,
  supportedEnvironmentCount: supportedEnvironments.length,
  tenantMode: "multi-tenant",
} as const;

export interface ServiceRuntimeConfig extends ServiceManifest {
  environment: EnvironmentKey;
}

export function createServiceRuntimeConfig(
  service: ServiceManifest,
  environment: EnvironmentKey,
): ServiceRuntimeConfig {
  return {
    ...service,
    environment,
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();

  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  throw new Error(`Expected a boolean value but received '${value}'`);
}

function parseInteger(
  fieldName: string,
  value: string | undefined,
  fallback: number,
  minimum = 1,
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);

  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${fieldName} must be an integer greater than or equal to ${minimum}`);
  }

  return parsed;
}

function parseDeploymentMode(value: string | undefined): DeploymentMode {
  if (value === undefined || value.trim() === "") {
    return registryServiceDefaults.deploymentMode;
  }

  if (value === "hosted" || value === "self-hosted") {
    return value;
  }

  throw new Error(`DEPLOYMENT_MODE must be 'hosted' or 'self-hosted'`);
}

function normalizeOptionalPath(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

export function loadRegistryConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadRegistryConfigOptions = {},
): RegistryConfig {
  const deploymentMode = parseDeploymentMode(env.DEPLOYMENT_MODE);
  const hostedManifestFile = normalizeOptionalPath(env.HOSTED_BOOTSTRAP_FILE);
  const selfHostedBootstrapFile = normalizeOptionalPath(env.SELF_HOSTED_BOOTSTRAP_FILE);
  const requireBootstrapFile = options.requireBootstrapFile ?? true;

  if (requireBootstrapFile && deploymentMode === "self-hosted" && selfHostedBootstrapFile === undefined) {
    throw new Error(
      "SELF_HOSTED_BOOTSTRAP_FILE is required when DEPLOYMENT_MODE is set to 'self-hosted'",
    );
  }

  return {
    bootstrap: {
      hostedManifestFile,
      selfHostedBootstrapFile,
    },
    databaseUrl: env.DATABASE_URL?.trim() || registryServiceDefaults.databaseUrl,
    deploymentMode,
    healthProbe: {
      allowPrivateTargets: parseBoolean(env.HEALTH_PROBE_ALLOW_PRIVATE_TARGETS, false),
      degradedThreshold: parseInteger(
        "HEALTH_PROBE_DEGRADED_THRESHOLD",
        env.HEALTH_PROBE_DEGRADED_THRESHOLD,
        registryServiceDefaults.healthProbeDegradedThreshold,
      ),
      failureWindow: parseInteger(
        "HEALTH_PROBE_FAILURE_WINDOW",
        env.HEALTH_PROBE_FAILURE_WINDOW,
        registryServiceDefaults.healthProbeFailureWindow,
      ),
      intervalSeconds: parseInteger(
        "HEALTH_PROBE_INTERVAL_SECONDS",
        env.HEALTH_PROBE_INTERVAL_SECONDS,
        registryServiceDefaults.healthProbeIntervalSeconds,
      ),
      method: registryServiceDefaults.healthProbeMethod,
      requireHttps: parseBoolean(
        env.HEALTH_PROBE_REQUIRE_HTTPS,
        deploymentMode === "hosted",
      ),
      timeoutSeconds: parseInteger(
        "HEALTH_PROBE_TIMEOUT_SECONDS",
        env.HEALTH_PROBE_TIMEOUT_SECONDS,
        registryServiceDefaults.healthProbeTimeoutSeconds,
      ),
    },
    rawCardByteLimit: parseInteger(
      "RAW_CARD_BYTE_LIMIT",
      env.RAW_CARD_BYTE_LIMIT,
      registryServiceDefaults.rawCardByteLimit,
    ),
  };
}
