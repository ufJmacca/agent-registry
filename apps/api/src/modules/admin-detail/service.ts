import { hasAnyRole, type ResolvedPrincipal } from "@agent-registry/auth";
import type {
  AgentAdminDetailResponse,
  VersionAdminDetailResponse,
} from "@agent-registry/contracts";
import type { AgentAdminDetailRepository } from "@agent-registry/db";

export class AgentAdminDetailAuthorizationError extends Error {}

function assertTenantMembershipScope(principal: ResolvedPrincipal, tenantId: string): void {
  if (principal.tenantId !== tenantId) {
    throw new AgentAdminDetailAuthorizationError(
      `Resolved principal does not belong to tenant '${tenantId}'.`,
    );
  }
}

function assertTenantAdminAccess(principal: ResolvedPrincipal): void {
  if (!hasAnyRole(principal.roles, ["tenant-admin"])) {
    throw new AgentAdminDetailAuthorizationError(
      "Tenant admin role is required to view admin detail endpoints.",
    );
  }
}

export class AgentAdminDetailService {
  private readonly repository: AgentAdminDetailRepository;

  constructor(repository: AgentAdminDetailRepository) {
    this.repository = repository;
  }

  async getAgentDetail(
    principal: ResolvedPrincipal,
    tenantId: string,
    agentId: string,
  ): Promise<AgentAdminDetailResponse> {
    assertTenantMembershipScope(principal, tenantId);
    assertTenantAdminAccess(principal);

    return this.repository.getAgentDetail(tenantId, agentId);
  }

  async getVersionDetail(
    principal: ResolvedPrincipal,
    tenantId: string,
    agentId: string,
    versionId: string,
  ): Promise<VersionAdminDetailResponse> {
    assertTenantMembershipScope(principal, tenantId);
    assertTenantAdminAccess(principal);

    return this.repository.getVersionDetail(tenantId, agentId, versionId);
  }
}
