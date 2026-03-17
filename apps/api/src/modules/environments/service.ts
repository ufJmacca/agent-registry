import { hasAnyRole, type ResolvedPrincipal } from "@agent-registry/auth";
import {
  isValidTenantEnvironmentKey,
  tenantEnvironmentKeyValidationMessage,
  type CreateTenantEnvironmentRequest,
  type CreateTenantEnvironmentResponse,
  type ListTenantEnvironmentsResponse,
} from "@agent-registry/contracts";
import {
  DuplicateTenantEnvironmentError,
  type TenantEnvironmentCatalogRepository,
} from "@agent-registry/db";

export class EnvironmentCatalogAuthorizationError extends Error {}

export class EnvironmentCatalogDuplicateError extends Error {}

export class EnvironmentCatalogValidationError extends Error {}

function assertTenantMembershipScope(principal: ResolvedPrincipal, tenantId: string): void {
  if (principal.tenantId !== tenantId) {
    throw new EnvironmentCatalogAuthorizationError(
      `Resolved principal does not belong to tenant '${tenantId}'.`,
    );
  }
}

export class TenantEnvironmentCatalogService {
  private readonly repository: TenantEnvironmentCatalogRepository;

  constructor(repository: TenantEnvironmentCatalogRepository) {
    this.repository = repository;
  }

  async listEnvironments(
    principal: ResolvedPrincipal,
    tenantId: string,
  ): Promise<ListTenantEnvironmentsResponse> {
    assertTenantMembershipScope(principal, tenantId);

    return {
      environments: await this.repository.listForTenant(tenantId),
    };
  }

  async createEnvironment(
    principal: ResolvedPrincipal,
    tenantId: string,
    request: CreateTenantEnvironmentRequest,
  ): Promise<CreateTenantEnvironmentResponse> {
    assertTenantMembershipScope(principal, tenantId);

    if (!hasAnyRole(principal.roles, ["tenant-admin"])) {
      throw new EnvironmentCatalogAuthorizationError(
        "Tenant admin role is required to create tenant environments.",
      );
    }

    const environmentKey = request.environmentKey.trim();

    if (!isValidTenantEnvironmentKey(environmentKey)) {
      throw new EnvironmentCatalogValidationError(tenantEnvironmentKeyValidationMessage);
    }

    try {
      return {
        environment: await this.repository.create(tenantId, environmentKey),
      };
    } catch (error) {
      if (error instanceof DuplicateTenantEnvironmentError) {
        throw new EnvironmentCatalogDuplicateError(error.message);
      }

      throw error;
    }
  }
}
