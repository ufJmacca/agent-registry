import type { AgentRegistryDb, HealthStatus } from "../index.js";

export interface ActiveApprovedPublicationRecord {
  activeVersionId: string;
  agentDeprecated: boolean;
  agentDisabled: boolean;
  agentId: string;
  capabilities: string[];
  contextContract: unknown[];
  displayName: string;
  environmentKey: string;
  headerContract: unknown[];
  healthStatus: HealthStatus | null;
  invocationEndpoint: string | null;
  overlayAgentDeprecated: boolean;
  overlayAgentDisabled: boolean;
  overlayAgentRequiredRoles: string[];
  overlayAgentRequiredScopes: string[];
  overlayEnvironmentDeprecated: boolean;
  overlayEnvironmentDisabled: boolean;
  overlayEnvironmentRequiredRoles: string[];
  overlayEnvironmentRequiredScopes: string[];
  publicationId: string;
  publisherId: string;
  rawCard: string;
  requiredRoles: string[];
  requiredScopes: string[];
  summary: string;
  tags: string[];
  versionSequence: number;
}

export interface AgentDiscoveryRepository {
  getActiveApprovedPublication(
    tenantId: string,
    agentId: string,
    environmentKey: string,
  ): Promise<ActiveApprovedPublicationRecord | null>;
  listActiveApprovedPublications(tenantId: string): Promise<ActiveApprovedPublicationRecord[]>;
  listActiveApprovedPublicationsForAgent(
    tenantId: string,
    agentId: string,
  ): Promise<ActiveApprovedPublicationRecord[]>;
}

interface OverlayRow {
  agent_id: string;
  deprecated: boolean;
  disabled: boolean;
  environment_key: string | null;
  required_roles: string[];
  required_scopes: string[];
}

function createOverlayMap(
  overlays: OverlayRow[],
): Map<string, OverlayRow> {
  return new Map(
    overlays.map((overlay) => [
      `${overlay.agent_id}::${overlay.environment_key ?? ""}`,
      overlay,
    ]),
  );
}

export class KyselyAgentDiscoveryRepository implements AgentDiscoveryRepository {
  private readonly db: AgentRegistryDb;

  constructor(db: AgentRegistryDb) {
    this.db = db;
  }

  async getActiveApprovedPublication(
    tenantId: string,
    agentId: string,
    environmentKey: string,
  ): Promise<ActiveApprovedPublicationRecord | null> {
    const records = await this.loadActiveApprovedPublications(tenantId, {
      agentId,
      environmentKey,
    });

    return records[0] ?? null;
  }

  async listActiveApprovedPublications(
    tenantId: string,
  ): Promise<ActiveApprovedPublicationRecord[]> {
    return this.loadActiveApprovedPublications(tenantId);
  }

  async listActiveApprovedPublicationsForAgent(
    tenantId: string,
    agentId: string,
  ): Promise<ActiveApprovedPublicationRecord[]> {
    return this.loadActiveApprovedPublications(tenantId, { agentId });
  }

  private async loadActiveApprovedPublications(
    tenantId: string,
    filter: {
      agentId?: string;
      environmentKey?: string;
    } = {},
  ): Promise<ActiveApprovedPublicationRecord[]> {
    let query = this.db
      .selectFrom("agents")
      .innerJoin("agent_versions", (join) =>
        join
          .onRef("agent_versions.tenant_id", "=", "agents.tenant_id")
          .onRef("agent_versions.agent_id", "=", "agents.agent_id")
          .onRef("agent_versions.version_id", "=", "agents.active_version_id"),
      )
      .innerJoin("environment_publications", (join) =>
        join
          .onRef("environment_publications.tenant_id", "=", "agent_versions.tenant_id")
          .onRef("environment_publications.agent_id", "=", "agent_versions.agent_id")
          .onRef("environment_publications.version_id", "=", "agent_versions.version_id"),
      )
      .leftJoin(
        "publication_health",
        "publication_health.publication_id",
        "environment_publications.publication_id",
      )
      .select([
        "agents.active_version_id",
        "agents.agent_id",
        "agents.deprecated as agent_deprecated",
        "agents.disabled as agent_disabled",
        "agent_versions.context_contract",
        "agent_versions.display_name",
        "agent_versions.header_contract",
        "agent_versions.publisher_id",
        "agent_versions.required_roles",
        "agent_versions.required_scopes",
        "agent_versions.summary",
        "agent_versions.tags",
        "agent_versions.version_sequence",
        "environment_publications.environment_key",
        "environment_publications.invocation_endpoint",
        "environment_publications.normalized_metadata",
        "environment_publications.publication_id",
        "environment_publications.raw_card",
        "publication_health.health_status",
      ])
      .where("agents.tenant_id", "=", tenantId)
      .where("agent_versions.approval_state", "=", "approved");

    if (filter.agentId !== undefined) {
      query = query.where("agents.agent_id", "=", filter.agentId);
    }

    if (filter.environmentKey !== undefined) {
      query = query.where("environment_publications.environment_key", "=", filter.environmentKey);
    }

    const publications = await query.execute();

    const overlays = await this.db
      .selectFrom("tenant_policy_overlays")
      .select([
        "agent_id",
        "deprecated",
        "disabled",
        "environment_key",
        "required_roles",
        "required_scopes",
      ])
      .where("tenant_id", "=", tenantId)
      .execute();
    const overlayMap = createOverlayMap(overlays);

    return publications.map((publication) => {
      const agentOverlay =
        overlayMap.get(`${publication.agent_id}::`) ?? null;
      const environmentOverlay =
        overlayMap.get(`${publication.agent_id}::${publication.environment_key}`) ?? null;
      const normalizedMetadata = publication.normalized_metadata as Record<string, unknown>;

      return {
        activeVersionId: publication.active_version_id as string,
        agentDeprecated: publication.agent_deprecated,
        agentDisabled: publication.agent_disabled,
        agentId: publication.agent_id,
        capabilities: Array.isArray(normalizedMetadata.capabilities)
          ? (normalizedMetadata.capabilities as string[])
          : [],
        contextContract: publication.context_contract as unknown[],
        displayName:
          typeof normalizedMetadata.displayName === "string"
            ? normalizedMetadata.displayName
            : publication.display_name,
        environmentKey: publication.environment_key,
        headerContract: publication.header_contract as unknown[],
        healthStatus: publication.health_status,
        invocationEndpoint: publication.invocation_endpoint,
        overlayAgentDeprecated: agentOverlay?.deprecated ?? false,
        overlayAgentDisabled: agentOverlay?.disabled ?? false,
        overlayAgentRequiredRoles: agentOverlay?.required_roles ?? [],
        overlayAgentRequiredScopes: agentOverlay?.required_scopes ?? [],
        overlayEnvironmentDeprecated: environmentOverlay?.deprecated ?? false,
        overlayEnvironmentDisabled: environmentOverlay?.disabled ?? false,
        overlayEnvironmentRequiredRoles: environmentOverlay?.required_roles ?? [],
        overlayEnvironmentRequiredScopes: environmentOverlay?.required_scopes ?? [],
        publicationId: publication.publication_id,
        publisherId: publication.publisher_id,
        rawCard: publication.raw_card,
        requiredRoles: publication.required_roles,
        requiredScopes: publication.required_scopes,
        summary:
          typeof normalizedMetadata.summary === "string"
            ? normalizedMetadata.summary
            : publication.summary,
        tags: Array.isArray(normalizedMetadata.tags)
          ? (normalizedMetadata.tags as string[])
          : publication.tags,
        versionSequence: publication.version_sequence,
      };
    });
  }
}
