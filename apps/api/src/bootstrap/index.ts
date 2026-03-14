import { readFile } from "node:fs/promises";

import { defaultCardProfileId } from "@agent-registry/agent-card";
import type { DeploymentMode, RegistryConfig } from "@agent-registry/config";
import type {
  BootstrapMembershipRecord,
  BootstrapTenantRecord,
} from "@agent-registry/db";
import YAML from "yaml";

export interface BootstrapMembershipManifest {
  registryCapabilities?: string[];
  roles?: string[];
  scopes?: string[];
  subjectId: string;
  userContext?: Record<string, unknown>;
}

export interface BootstrapTenantManifest {
  defaultCardProfileId: string;
  displayName: string;
  environments: string[];
  memberships?: BootstrapMembershipManifest[];
  tenantId: string;
}

export interface BootstrapManifest {
  tenants: BootstrapTenantManifest[];
}

export interface BootstrapSummary {
  membershipCount: number;
  tenantCount: number;
}

export interface OperatorBootstrapRepository {
  replaceEnvironments(tenantId: string, environments: string[]): Promise<void>;
  upsertMembership(tenantId: string, membership: BootstrapMembershipRecord): Promise<void>;
  upsertTenant(tenant: BootstrapTenantRecord): Promise<void>;
}

export interface OperatorBootstrapOptions {
  deploymentMode: DeploymentMode;
  manifestPath: string;
}

function expectObject(value: unknown, errorMessage: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(errorMessage);
  }

  return value as Record<string, unknown>;
}

function expectString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${fieldName} must be a non-empty string`);
  }

  return value.trim();
}

function readStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array of strings`);
  }

  const normalizedValues = value.map((entry) => expectString(entry, fieldName));
  const uniqueValues = new Set(normalizedValues);

  if (uniqueValues.size !== normalizedValues.length) {
    throw new Error(`${fieldName} contains duplicate values`);
  }

  return normalizedValues;
}

function readMemberships(value: unknown): BootstrapMembershipManifest[] {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new Error("tenants[].memberships must be an array");
  }

  return value.map((entry, index) => {
    const membership = expectObject(entry, `tenants[].memberships[${index}] must be an object`);
    const userContext = membership.userContext ?? {};

    return {
      registryCapabilities: readStringArray(
        membership.registryCapabilities,
        `tenants[].memberships[${index}].registryCapabilities`,
      ),
      roles: readStringArray(membership.roles, `tenants[].memberships[${index}].roles`),
      scopes: readStringArray(membership.scopes, `tenants[].memberships[${index}].scopes`),
      subjectId: expectString(membership.subjectId, `tenants[].memberships[${index}].subjectId`),
      userContext: expectObject(
        userContext,
        `tenants[].memberships[${index}].userContext must be an object`,
      ),
    };
  });
}

export async function loadBootstrapManifest(manifestPath: string): Promise<BootstrapManifest> {
  const source = await readFile(manifestPath, "utf8");
  const parsed = YAML.parse(source);
  const manifest = expectObject(parsed, "Bootstrap manifest must be an object");

  if (!Array.isArray(manifest.tenants)) {
    throw new Error("Bootstrap manifest must define a tenants array");
  }

  const tenants = manifest.tenants.map((entry, index) => {
    const tenant = expectObject(entry, `tenants[${index}] must be an object`);
    const environments = readStringArray(tenant.environments, `tenants[${index}].environments`);

    if (environments.length === 0) {
      throw new Error(`tenants[${index}].environments must include at least one environment`);
    }

    return {
      defaultCardProfileId: tenant.defaultCardProfileId === undefined
        ? defaultCardProfileId
        : expectString(tenant.defaultCardProfileId, `tenants[${index}].defaultCardProfileId`),
      displayName: expectString(tenant.displayName, `tenants[${index}].displayName`),
      environments,
      memberships: readMemberships(tenant.memberships),
      tenantId: expectString(tenant.tenantId, `tenants[${index}].tenantId`),
    };
  });

  return { tenants };
}

export class OperatorBootstrapService {
  private readonly repository: OperatorBootstrapRepository;

  constructor(repository: OperatorBootstrapRepository) {
    this.repository = repository;
  }

  async bootstrap(options: OperatorBootstrapOptions): Promise<BootstrapSummary> {
    const manifest = await loadBootstrapManifest(options.manifestPath);

    if (options.deploymentMode === "self-hosted" && manifest.tenants.length !== 1) {
      throw new Error("self-hosted mode supports exactly one tenant manifest entry");
    }

    let membershipCount = 0;

    for (const tenant of manifest.tenants) {
      await this.repository.upsertTenant({
        defaultCardProfileId: tenant.defaultCardProfileId,
        deploymentMode: options.deploymentMode,
        displayName: tenant.displayName,
        tenantId: tenant.tenantId,
      });
      await this.repository.replaceEnvironments(tenant.tenantId, tenant.environments);

      for (const membership of tenant.memberships ?? []) {
        await this.repository.upsertMembership(tenant.tenantId, {
          registryCapabilities: membership.registryCapabilities ?? [],
          roles: membership.roles ?? [],
          scopes: membership.scopes ?? [],
          subjectId: membership.subjectId,
          userContext: membership.userContext ?? {},
        });
        membershipCount += 1;
      }
    }

    return {
      membershipCount,
      tenantCount: manifest.tenants.length,
    };
  }
}

export async function bootstrapFromConfig(
  config: RegistryConfig,
  repository: OperatorBootstrapRepository,
): Promise<BootstrapSummary | null> {
  const manifestPath =
    config.deploymentMode === "self-hosted"
      ? config.bootstrap.selfHostedBootstrapFile
      : config.bootstrap.hostedManifestFile;

  if (manifestPath === undefined) {
    return null;
  }

  return new OperatorBootstrapService(repository).bootstrap({
    deploymentMode: config.deploymentMode,
    manifestPath,
  });
}
