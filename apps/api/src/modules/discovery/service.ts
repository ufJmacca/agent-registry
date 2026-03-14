import type { ResolvedPrincipal } from "@agent-registry/auth";
import type {
  ContextContractEntry,
  DiscoveryHealthStatus,
  DiscoveryPublication,
  DiscoveryPublicationListResponse,
  DiscoveryPublicationStatus,
  HeaderContractEntry,
} from "@agent-registry/contracts";
import type {
  ActiveApprovedPublicationRecord,
  AgentDiscoveryRepository,
} from "@agent-registry/db";

import type { DiscoveryListQuery } from "./query.js";

const defaultPageSize = 20;
const maxPageSize = 100;
const maxRawCardPageSize = 5;

export class AgentDiscoveryAuthorizationError extends Error {}

export class AgentDiscoveryValidationError extends Error {}

export class AgentDiscoveryRawCardPayloadTooLargeError extends Error {}

function assertTenantMembershipScope(principal: ResolvedPrincipal, tenantId: string): void {
  if (principal.tenantId !== tenantId) {
    throw new AgentDiscoveryAuthorizationError(
      `Resolved principal does not belong to tenant '${tenantId}'.`,
    );
  }
}

function sortUniqueStrings(...values: string[][]): string[] {
  return [...new Set(values.flat())].sort();
}

function hasAnyRole(callerRoles: string[], requiredRoles: string[]): boolean {
  return requiredRoles.length === 0 || requiredRoles.some((role) => callerRoles.includes(role));
}

function hasAllScopes(callerScopes: string[], requiredScopes: string[]): boolean {
  return requiredScopes.every((scope) => callerScopes.includes(scope));
}

function normalizeHeaderContract(contract: unknown[]): HeaderContractEntry[] {
  return contract
    .filter((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    .map((entry) => entry as Record<string, unknown>)
    .filter(
      (entry) =>
        typeof entry.description === "string" &&
        typeof entry.name === "string" &&
        typeof entry.required === "boolean" &&
        typeof entry.source === "string",
    )
    .map((entry) => ({
      description: entry.description as string,
      name: entry.name as string,
      required: entry.required as boolean,
      source: entry.source as string,
    }));
}

function normalizeContextContract(contract: unknown[]): ContextContractEntry[] {
  return contract
    .filter((entry) => typeof entry === "object" && entry !== null && !Array.isArray(entry))
    .map((entry) => entry as Record<string, unknown>)
    .filter(
      (entry) =>
        typeof entry.description === "string" &&
        typeof entry.key === "string" &&
        typeof entry.required === "boolean" &&
        typeof entry.type === "string",
    )
    .map((entry) => ({
      description: entry.description as string,
      example: entry.example,
      key: entry.key as string,
      required: entry.required as boolean,
      type: entry.type as ContextContractEntry["type"],
    }));
}

function getHealthStatus(record: ActiveApprovedPublicationRecord): DiscoveryHealthStatus {
  return record.healthStatus ?? "unknown";
}

function getStatus(): DiscoveryPublicationStatus {
  return "approved_active";
}

function getEffectiveDeprecated(record: ActiveApprovedPublicationRecord): boolean {
  return (
    record.agentDeprecated || record.overlayAgentDeprecated || record.overlayEnvironmentDeprecated
  );
}

function getEffectiveDisabled(record: ActiveApprovedPublicationRecord): boolean {
  return record.agentDisabled || record.overlayAgentDisabled || record.overlayEnvironmentDisabled;
}

function getOverlayRequiredScopes(record: ActiveApprovedPublicationRecord): string[] {
  return sortUniqueStrings(
    record.overlayAgentRequiredScopes,
    record.overlayEnvironmentRequiredScopes,
  );
}

function isAuthorized(record: ActiveApprovedPublicationRecord, principal: ResolvedPrincipal): boolean {
  const publisherRolePass = hasAnyRole(principal.roles, record.requiredRoles);
  const overlayAgentRolePass = hasAnyRole(principal.roles, record.overlayAgentRequiredRoles);
  const overlayEnvironmentRolePass = hasAnyRole(
    principal.roles,
    record.overlayEnvironmentRequiredRoles,
  );
  const publisherScopePass = hasAllScopes(principal.scopes, record.requiredScopes);
  const overlayScopePass = hasAllScopes(principal.scopes, getOverlayRequiredScopes(record));

  return (
    publisherRolePass &&
    overlayAgentRolePass &&
    overlayEnvironmentRolePass &&
    publisherScopePass &&
    overlayScopePass
  );
}

function hasRequiredScopes(
  record: ActiveApprovedPublicationRecord,
  requiredScopes: string[],
): boolean {
  const effectiveScopes = sortUniqueStrings(
    record.requiredScopes,
    record.overlayAgentRequiredScopes,
    record.overlayEnvironmentRequiredScopes,
  );

  return requiredScopes.every((scope) => effectiveScopes.includes(scope));
}

function hasRequiredHeaders(record: ActiveApprovedPublicationRecord, headerNames: string[]): boolean {
  const requiredHeaderNames = normalizeHeaderContract(record.headerContract)
    .filter((entry) => entry.required)
    .map((entry) => entry.name.toLowerCase());

  return headerNames.every((headerName) => requiredHeaderNames.includes(headerName.toLowerCase()));
}

function hasRequiredContextKeys(
  record: ActiveApprovedPublicationRecord,
  contextKeys: string[],
): boolean {
  const requiredContextKeys = normalizeContextContract(record.contextContract)
    .filter((entry) => entry.required)
    .map((entry) => entry.key);

  return contextKeys.every((contextKey) => requiredContextKeys.includes(contextKey));
}

function calculateRelevance(record: DiscoveryPublication, query: string | null): number {
  if (query === null) {
    return 0;
  }

  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term !== "");

  if (terms.length === 0) {
    return 0;
  }

  let score = 0;

  for (const term of terms) {
    if (record.displayName.toLowerCase().includes(term)) {
      score += 8;
    }

    if (record.summary.toLowerCase().includes(term)) {
      score += 4;
    }

    score += record.capabilities.filter((capability) => capability.toLowerCase().includes(term)).length * 2;
    score += record.tags.filter((tag) => tag.toLowerCase().includes(term)).length;
  }

  return score;
}

function getHealthRank(status: DiscoveryHealthStatus): number {
  switch (status) {
    case "healthy":
      return 0;
    case "unknown":
      return 1;
    case "degraded":
      return 2;
    case "unreachable":
      return 3;
  }
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
    status: getStatus(),
    summary: record.summary,
    tags: record.tags,
  };
}

export interface AgentDiscoveryServiceOptions {
  rawCardByteLimit?: number;
}

export class AgentDiscoveryService {
  private readonly rawCardByteLimit: number;

  private readonly repository: AgentDiscoveryRepository;

  constructor(
    repository: AgentDiscoveryRepository,
    options: AgentDiscoveryServiceOptions = {},
  ) {
    this.rawCardByteLimit = options.rawCardByteLimit ?? 256 * 1024;
    this.repository = repository;
  }

  async listAvailable(
    principal: ResolvedPrincipal,
    tenantId: string,
    query: DiscoveryListQuery,
  ): Promise<DiscoveryPublicationListResponse> {
    return this.listPublications(principal, tenantId, query);
  }

  async search(
    principal: ResolvedPrincipal,
    tenantId: string,
    query: DiscoveryListQuery,
  ): Promise<DiscoveryPublicationListResponse> {
    return this.listPublications(principal, tenantId, query);
  }

  private async listPublications(
    principal: ResolvedPrincipal,
    tenantId: string,
    query: DiscoveryListQuery,
  ): Promise<DiscoveryPublicationListResponse> {
    assertTenantMembershipScope(principal, tenantId);

    const requestedPageSize = Math.min(query.pageSize, maxPageSize);
    const pageSize = query.includeRawCard
      ? Math.min(requestedPageSize, maxRawCardPageSize)
      : requestedPageSize;
    const page = query.page;
    const rawRecords = await this.repository.listActiveApprovedPublications(tenantId);
    const requestedStatuses = query.statuses;

    let records = rawRecords
      .filter((record) => !getEffectiveDisabled(record))
      .filter((record) => isAuthorized(record, principal));

    if (requestedStatuses.length > 0 && !requestedStatuses.includes("approved_active")) {
      records = [];
    }

    if (query.environmentKeys.length > 0) {
      records = records.filter((record) => query.environmentKeys.includes(record.environmentKey));
    }

    if (query.publisherIds.length > 0) {
      records = records.filter((record) => query.publisherIds.includes(record.publisherId));
    }

    if (query.healthStatuses.length > 0) {
      records = records.filter((record) => query.healthStatuses.includes(getHealthStatus(record)));
    }

    if (query.deprecated !== null) {
      records = records.filter((record) => getEffectiveDeprecated(record) === query.deprecated);
    }

    if (query.requiredScopes.length > 0) {
      records = records.filter((record) => hasRequiredScopes(record, query.requiredScopes));
    }

    if (query.requiredHeaders.length > 0) {
      records = records.filter((record) => hasRequiredHeaders(record, query.requiredHeaders));
    }

    if (query.requiredContextKeys.length > 0) {
      records = records.filter((record) => hasRequiredContextKeys(record, query.requiredContextKeys));
    }

    const publications = records.map((record) => ({
      publication: toDiscoveryPublication(record, query.includeRawCard),
      publicationId: record.publicationId,
      relevance: 0,
      versionSequence: record.versionSequence,
    }));

    for (const publication of publications) {
      publication.relevance = calculateRelevance(publication.publication, query.q);
    }

    let filteredPublications = publications;

    if (query.q !== null) {
      filteredPublications = publications.filter((publication) => publication.relevance > 0);
    }

    filteredPublications.sort((left, right) => {
      if (right.relevance !== left.relevance) {
        return right.relevance - left.relevance;
      }

      const leftHealthRank = getHealthRank(left.publication.healthStatus);
      const rightHealthRank = getHealthRank(right.publication.healthStatus);

      if (leftHealthRank !== rightHealthRank) {
        return leftHealthRank - rightHealthRank;
      }

      if (right.versionSequence !== left.versionSequence) {
        return right.versionSequence - left.versionSequence;
      }

      if (left.publication.agentId !== right.publication.agentId) {
        return left.publication.agentId.localeCompare(right.publication.agentId);
      }

      if (left.publication.environmentKey !== right.publication.environmentKey) {
        return left.publication.environmentKey.localeCompare(right.publication.environmentKey);
      }

      return left.publicationId.localeCompare(right.publicationId);
    });

    const total = filteredPublications.length;
    const startIndex = (page - 1) * pageSize;
    const items = filteredPublications
      .slice(startIndex, startIndex + pageSize)
      .map((publication) => publication.publication);

    if (query.includeRawCard) {
      const rawCardBytes = items.reduce(
        (totalBytes, item) => totalBytes + Buffer.byteLength(item.rawCard ?? "", "utf8"),
        0,
      );

      if (rawCardBytes > this.rawCardByteLimit) {
        throw new AgentDiscoveryRawCardPayloadTooLargeError(
          "The requested rawCard payload exceeds the configured byte limit.",
        );
      }
    }

    return {
      items,
      page,
      pageSize: query.includeRawCard ? Math.min(pageSize, maxRawCardPageSize) : pageSize || defaultPageSize,
      total,
    };
  }
}
