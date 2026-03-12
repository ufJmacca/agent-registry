import type { EnvironmentKey, ServiceManifest } from "@agent-registry/contracts";
import { supportedEnvironments } from "@agent-registry/contracts";

export const registryServiceDefaults = {
  healthProbeIntervalSeconds: 60,
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
