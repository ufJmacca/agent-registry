import {
  resolveUserContextSource,
  satisfiesAccessClauses,
  type AccessRequirementClause,
  type ResolvedPrincipal,
} from "@agent-registry/auth";
import {
  normalizeContextContract,
  normalizeHeaderContract,
  type AgentPublicationPreflightRequest,
  type AgentPublicationPreflightResponse,
  type ContextContractEntry,
  type DiscoveryHealthStatus,
  type HeaderContractEntry,
} from "@agent-registry/contracts";
import {
  AgentEnvironmentPublicationNotFoundError,
  type ActiveApprovedPublicationRecord,
  type AgentDiscoveryRepository,
} from "@agent-registry/db";

export class AgentPublicationPreflightAuthorizationError extends Error {}

function assertTenantMembershipScope(principal: ResolvedPrincipal, tenantId: string): void {
  if (principal.tenantId !== tenantId) {
    throw new AgentPublicationPreflightAuthorizationError(
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
  if (getEffectiveDisabled(record)) {
    return false;
  }

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

export function getUnresolvedRequiredHeaderSources(
  userContext: Record<string, unknown>,
  headerContract: HeaderContractEntry[],
): string[] {
  return headerContract
    .filter((entry) => entry.required)
    .filter((entry) => {
      const value = resolveUserContextSource(userContext, entry.source);
      return value === undefined || value === null;
    })
    .map((entry) => entry.source);
}

export function getMissingRequiredContextKeys(
  contextValues: Record<string, unknown>,
  contextContract: ContextContractEntry[],
): string[] {
  return contextContract
    .filter((entry) => entry.required)
    .filter((entry) => {
      const value = contextValues[entry.key];
      return value === undefined || value === null;
    })
    .map((entry) => entry.key);
}

export class AgentPublicationPreflightService {
  private readonly repository: AgentDiscoveryRepository;

  constructor(repository: AgentDiscoveryRepository) {
    this.repository = repository;
  }

  async preflightPublication(
    principal: ResolvedPrincipal,
    tenantId: string,
    agentId: string,
    environmentKey: string,
    request: AgentPublicationPreflightRequest,
  ): Promise<AgentPublicationPreflightResponse> {
    assertTenantMembershipScope(principal, tenantId);

    const publication = await this.repository.getActiveApprovedPublication(
      tenantId,
      agentId,
      environmentKey,
    );

    if (publication === null) {
      throw new AgentEnvironmentPublicationNotFoundError(tenantId, agentId, environmentKey);
    }

    const headerContract = normalizeHeaderContract(publication.headerContract);
    const contextContract = normalizeContextContract(publication.contextContract);
    const unresolvedRequiredHeaderSources = getUnresolvedRequiredHeaderSources(
      principal.userContext,
      headerContract,
    );
    const missingRequiredContextKeys = getMissingRequiredContextKeys(
      request.context ?? {},
      contextContract,
    );
    const authorized = isAuthorized(publication, principal);

    return {
      activeVersionId: publication.activeVersionId,
      agentId: publication.agentId,
      authorized,
      deprecated: getEffectiveDeprecated(publication),
      environmentKey: publication.environmentKey,
      healthStatus: getHealthStatus(publication),
      missingRequiredContextKeys,
      rawCard: authorized && request.includeRawCard ? publication.rawCard : undefined,
      rawCardAvailable: true,
      ready:
        authorized &&
        unresolvedRequiredHeaderSources.length === 0 &&
        missingRequiredContextKeys.length === 0,
      unresolvedRequiredHeaderSources,
    };
  }
}
