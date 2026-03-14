import {
  satisfiesAccessClauses,
  type AccessRequirementClause,
  type ResolvedPrincipal,
} from "@agent-registry/auth";
import type {
  AgentPublicationDetailResponse,
  DiscoveryHealthStatus,
  DiscoveryPublication,
} from "@agent-registry/contracts";
import {
  normalizeContextContract,
  normalizeHeaderContract,
} from "@agent-registry/contracts";
import {
  ActiveAgentPublicationNotFoundError,
  AgentEnvironmentPublicationNotFoundError,
  type ActiveApprovedPublicationRecord,
  type AgentDiscoveryRepository,
} from "@agent-registry/db";

export interface AgentPublicationDetailQuery {
  environmentKey: string | null;
  includeRawCard: boolean;
}

export class AgentPublicationDetailAuthorizationError extends Error {}

export class AgentPublicationDetailValidationError extends Error {}

function assertTenantMembershipScope(principal: ResolvedPrincipal, tenantId: string): void {
  if (principal.tenantId !== tenantId) {
    throw new AgentPublicationDetailAuthorizationError(
      `Resolved principal does not belong to tenant '${tenantId}'.`,
    );
  }
}

function getHealthStatus(record: ActiveApprovedPublicationRecord): DiscoveryHealthStatus {
  return record.healthStatus ?? "unknown";
}

function getEffectiveDeprecated(record: ActiveApprovedPublicationRecord): boolean {
  return (
    record.agentDeprecated || record.overlayAgentDeprecated || record.overlayEnvironmentDeprecated
  );
}

function getEffectiveDisabled(record: ActiveApprovedPublicationRecord): boolean {
  return record.agentDisabled || record.overlayAgentDisabled || record.overlayEnvironmentDisabled;
}

function isAuthorized(record: ActiveApprovedPublicationRecord, principal: ResolvedPrincipal): boolean {
  const clauses: AccessRequirementClause[] = [
    {
      requiredRoles: record.requiredRoles,
      requiredScopes: record.requiredScopes,
    },
    {
      requiredRoles: record.overlayAgentRequiredRoles,
      requiredScopes: record.overlayAgentRequiredScopes,
    },
    {
      requiredRoles: record.overlayEnvironmentRequiredRoles,
      requiredScopes: record.overlayEnvironmentRequiredScopes,
    },
  ];

  return satisfiesAccessClauses(principal, clauses);
}

function toDiscoveryPublication(
  record: ActiveApprovedPublicationRecord,
  includeRawCard: boolean,
): DiscoveryPublication {
  return {
    activeVersionId: record.activeVersionId,
    agentId: record.agentId,
    capabilities: record.capabilities,
    contextContract: normalizeContextContract(record.contextContract),
    deprecated: getEffectiveDeprecated(record),
    displayName: record.displayName,
    environmentKey: record.environmentKey,
    headerContract: normalizeHeaderContract(record.headerContract),
    healthStatus: getHealthStatus(record),
    invocationEndpoint: record.invocationEndpoint,
    publisherId: record.publisherId,
    rawCard: includeRawCard ? record.rawCard : undefined,
    rawCardAvailable: true,
    requiredRoles: record.requiredRoles,
    requiredScopes: record.requiredScopes,
    status: "approved_active",
    summary: record.summary,
    tags: record.tags,
  };
}

export class AgentPublicationDetailService {
  private readonly repository: AgentDiscoveryRepository;

  constructor(repository: AgentDiscoveryRepository) {
    this.repository = repository;
  }

  async getPublicationDetail(
    principal: ResolvedPrincipal,
    tenantId: string,
    agentId: string,
    query: AgentPublicationDetailQuery,
  ): Promise<AgentPublicationDetailResponse> {
    assertTenantMembershipScope(principal, tenantId);

    if (query.environmentKey !== null) {
      const publication = await this.repository.getActiveApprovedPublication(
        tenantId,
        agentId,
        query.environmentKey,
      );

      if (
        publication === null ||
        getEffectiveDisabled(publication) ||
        !isAuthorized(publication, principal)
      ) {
        throw new AgentEnvironmentPublicationNotFoundError(tenantId, agentId, query.environmentKey);
      }

      return {
        activeVersionId: publication.activeVersionId,
        agentId: publication.agentId,
        publication: toDiscoveryPublication(publication, query.includeRawCard),
      };
    }

    const publications = (await this.repository.listActiveApprovedPublicationsForAgent(
      tenantId,
      agentId,
    )).filter((publication) => !getEffectiveDisabled(publication) && isAuthorized(publication, principal));

    if (publications.length === 0) {
      throw new ActiveAgentPublicationNotFoundError(tenantId, agentId);
    }

    if (publications.length > 1) {
      throw new AgentPublicationDetailValidationError(
        "environmentKey is required when more than one active approved publication is available.",
      );
    }

    const publication = publications[0] as ActiveApprovedPublicationRecord;

    return {
      activeVersionId: publication.activeVersionId,
      agentId: publication.agentId,
      publication: toDiscoveryPublication(publication, query.includeRawCard),
    };
  }
}
