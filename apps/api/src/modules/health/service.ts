import { hasAnyRole, type ResolvedPrincipal } from "@agent-registry/auth";
import type { PublicationHealthDetailResponse } from "@agent-registry/contracts";
import type { HealthRepository } from "@agent-registry/db";

export class AgentPublicationHealthAuthorizationError extends Error {}

function assertTenantMembershipScope(principal: ResolvedPrincipal, tenantId: string): void {
  if (principal.tenantId !== tenantId) {
    throw new AgentPublicationHealthAuthorizationError(
      `Resolved principal does not belong to tenant '${tenantId}'.`,
    );
  }
}

function assertTenantAdminAccess(principal: ResolvedPrincipal): void {
  if (!hasAnyRole(principal.roles, ["tenant-admin"])) {
    throw new AgentPublicationHealthAuthorizationError(
      "Tenant admin role is required to view publication health endpoints.",
    );
  }
}

export class AgentPublicationHealthService {
  private readonly repository: HealthRepository;

  constructor(repository: HealthRepository) {
    this.repository = repository;
  }

  async getPublicationHealth(
    principal: ResolvedPrincipal,
    tenantId: string,
    agentId: string,
    versionId: string,
    environmentKey: string,
  ): Promise<PublicationHealthDetailResponse> {
    assertTenantMembershipScope(principal, tenantId);
    assertTenantAdminAccess(principal);

    return this.repository.getPublicationHealth(tenantId, agentId, versionId, environmentKey);
  }
}
