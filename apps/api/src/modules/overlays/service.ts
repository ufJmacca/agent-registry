import { hasAnyRole, type ResolvedPrincipal } from "@agent-registry/auth";
import type { TenantPolicyOverlayResponse } from "@agent-registry/contracts";
import type { TenantPolicyOverlayRepository } from "@agent-registry/db";

export class TenantPolicyOverlayAuthorizationError extends Error {}

function assertTenantMembershipScope(principal: ResolvedPrincipal, tenantId: string): void {
  if (principal.tenantId !== tenantId) {
    throw new TenantPolicyOverlayAuthorizationError(
      `Resolved principal does not belong to tenant '${tenantId}'.`,
    );
  }
}

function assertTenantAdminAccess(principal: ResolvedPrincipal): void {
  if (!hasAnyRole(principal.roles, ["tenant-admin"])) {
    throw new TenantPolicyOverlayAuthorizationError(
      "Tenant admin role is required to manage policy overlays.",
    );
  }
}

export class TenantPolicyOverlayService {
  private readonly repository: TenantPolicyOverlayRepository;

  constructor(repository: TenantPolicyOverlayRepository) {
    this.repository = repository;
  }

  async disableAgent(
    principal: ResolvedPrincipal,
    tenantId: string,
    agentId: string,
  ): Promise<TenantPolicyOverlayResponse> {
    assertTenantMembershipScope(principal, tenantId);
    assertTenantAdminAccess(principal);

    return {
      overlay: await this.repository.upsertNarrowingOverlay({
        agentId,
        disabled: true,
        environmentKey: null,
        tenantId,
      }),
    };
  }

  async deprecateAgent(
    principal: ResolvedPrincipal,
    tenantId: string,
    agentId: string,
  ): Promise<TenantPolicyOverlayResponse> {
    assertTenantMembershipScope(principal, tenantId);
    assertTenantAdminAccess(principal);

    return {
      overlay: await this.repository.upsertNarrowingOverlay({
        agentId,
        deprecated: true,
        environmentKey: null,
        tenantId,
      }),
    };
  }

  async disableEnvironment(
    principal: ResolvedPrincipal,
    tenantId: string,
    agentId: string,
    environmentKey: string,
  ): Promise<TenantPolicyOverlayResponse> {
    assertTenantMembershipScope(principal, tenantId);
    assertTenantAdminAccess(principal);

    return {
      overlay: await this.repository.upsertNarrowingOverlay({
        agentId,
        disabled: true,
        environmentKey,
        tenantId,
      }),
    };
  }

  async deprecateEnvironment(
    principal: ResolvedPrincipal,
    tenantId: string,
    agentId: string,
    environmentKey: string,
  ): Promise<TenantPolicyOverlayResponse> {
    assertTenantMembershipScope(principal, tenantId);
    assertTenantAdminAccess(principal);

    return {
      overlay: await this.repository.upsertNarrowingOverlay({
        agentId,
        deprecated: true,
        environmentKey,
        tenantId,
      }),
    };
  }
}
