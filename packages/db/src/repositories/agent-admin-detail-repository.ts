import type { AgentRegistryDb } from "../index.js";
import {
  AgentNotFoundError,
  AgentVersionNotFoundError,
} from "./agent-repository-errors.js";

type ApprovalState = "draft" | "pending_review" | "approved" | "rejected";

export interface PublicationTelemetrySummaryRecord {
  errorCount: number;
  invocationCount: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  recordedAt: string;
  successCount: number;
  windowEndedAt: string;
  windowStartedAt: string;
}

export interface VersionReviewMetadataRecord {
  approvedAt: string | null;
  approvedBy: string | null;
  rejectedAt: string | null;
  rejectedBy: string | null;
  rejectedReason: string | null;
  submittedAt: string | null;
  submittedBy: string | null;
}

export interface AgentAdminDetailRecord {
  activeVersion: {
    approvalState: ApprovalState;
    publications: Array<{
      environmentKey: string;
      healthEndpointUrl: string;
      healthStatus: string | null;
      publicationId: string;
      telemetry: PublicationTelemetrySummaryRecord[];
    }>;
    review: VersionReviewMetadataRecord;
    versionId: string;
    versionSequence: number;
  } | null;
  activeVersionId: string | null;
  agentId: string;
  overlay: {
    agent: {
      deprecated: boolean;
      disabled: boolean;
      requiredRoles: string[];
      requiredScopes: string[];
    };
    environments: Array<{
      deprecated: boolean;
      disabled: boolean;
      environmentKey: string;
      requiredRoles: string[];
      requiredScopes: string[];
    }>;
  };
  versions: Array<{
    approvalState: ApprovalState;
    versionId: string;
    versionSequence: number;
  }>;
}

export interface VersionAdminDetailRecord {
  active: boolean;
  agentId: string;
  approvalState: ApprovalState;
  cardProfileId: string;
  contextContract: unknown[];
  displayName: string;
  headerContract: unknown[];
  publications: Array<{
    environmentKey: string;
    healthEndpointUrl: string;
    healthStatus: string | null;
    invocationEndpoint: string | null;
    normalizedMetadata: unknown;
    publicationId: string;
    rawCard: string;
    telemetry: PublicationTelemetrySummaryRecord[];
  }>;
  requiredRoles: string[];
  requiredScopes: string[];
  review: VersionReviewMetadataRecord;
  summary: string;
  tags: string[];
  versionId: string;
  versionLabel: string;
  versionSequence: number;
}

function mapReviewMetadata(record: {
  approved_at: string | null;
  approved_by: string | null;
  rejected_at: string | null;
  rejected_by: string | null;
  rejected_reason: string | null;
  submitted_at: string | null;
  submitted_by: string | null;
}): VersionReviewMetadataRecord {
  return {
    approvedAt: record.approved_at,
    approvedBy: record.approved_by,
    rejectedAt: record.rejected_at,
    rejectedBy: record.rejected_by,
    rejectedReason: record.rejected_reason,
    submittedAt: record.submitted_at,
    submittedBy: record.submitted_by,
  };
}

export interface AgentAdminDetailRepository {
  getAgentDetail(tenantId: string, agentId: string): Promise<AgentAdminDetailRecord>;
  getVersionDetail(
    tenantId: string,
    agentId: string,
    versionId: string,
  ): Promise<VersionAdminDetailRecord>;
}

export class KyselyAgentAdminDetailRepository implements AgentAdminDetailRepository {
  private readonly db: AgentRegistryDb;

  constructor(db: AgentRegistryDb) {
    this.db = db;
  }

  private async getTelemetryByPublicationIds(
    tenantId: string,
    publicationIds: string[],
  ): Promise<Map<string, PublicationTelemetrySummaryRecord[]>> {
    if (publicationIds.length === 0) {
      return new Map();
    }

    const telemetryRows = await this.db
      .selectFrom("publication_telemetry")
      .select([
        "error_count",
        "invocation_count",
        "p50_latency_ms",
        "p95_latency_ms",
        "publication_id",
        "recorded_at",
        "success_count",
        "window_ended_at",
        "window_started_at",
      ])
      .where("tenant_id", "=", tenantId)
      .where("publication_id", "in", publicationIds)
      .orderBy("publication_id")
      .orderBy("window_started_at", "desc")
      .execute();

    const telemetryByPublication = new Map<string, PublicationTelemetrySummaryRecord[]>();

    for (const row of telemetryRows) {
      const publicationTelemetry = telemetryByPublication.get(row.publication_id) ?? [];
      publicationTelemetry.push({
        errorCount: row.error_count,
        invocationCount: row.invocation_count,
        p50LatencyMs: row.p50_latency_ms,
        p95LatencyMs: row.p95_latency_ms,
        recordedAt: row.recorded_at,
        successCount: row.success_count,
        windowEndedAt: row.window_ended_at,
        windowStartedAt: row.window_started_at,
      });
      telemetryByPublication.set(row.publication_id, publicationTelemetry);
    }

    return telemetryByPublication;
  }

  async getAgentDetail(tenantId: string, agentId: string): Promise<AgentAdminDetailRecord> {
    const agent = await this.db
      .selectFrom("agents")
      .select(["active_version_id", "agent_id"])
      .where("tenant_id", "=", tenantId)
      .where("agent_id", "=", agentId)
      .executeTakeFirst();

    if (agent === undefined) {
      throw new AgentNotFoundError(tenantId, agentId);
    }

    const versions = await this.db
      .selectFrom("agent_versions")
      .select(["approval_state", "version_id", "version_sequence"])
      .where("tenant_id", "=", tenantId)
      .where("agent_id", "=", agentId)
      .orderBy("version_sequence")
      .execute();

    const overlays = await this.db
      .selectFrom("tenant_policy_overlays")
      .select([
        "deprecated",
        "disabled",
        "environment_key",
        "required_roles",
        "required_scopes",
      ])
      .where("tenant_id", "=", tenantId)
      .where("agent_id", "=", agentId)
      .orderBy("environment_key")
      .execute();

    const agentOverlay = overlays.find((overlay) => overlay.environment_key === null);
    const environmentOverlays = overlays
      .filter((overlay) => overlay.environment_key !== null)
      .map((overlay) => ({
        deprecated: overlay.deprecated,
        disabled: overlay.disabled,
        environmentKey: overlay.environment_key as string,
        requiredRoles: overlay.required_roles,
        requiredScopes: overlay.required_scopes,
      }));

    let activeVersion: AgentAdminDetailRecord["activeVersion"] = null;

    if (agent.active_version_id !== null) {
      const activeVersionRecord = await this.db
        .selectFrom("agent_versions")
        .select([
          "approval_state",
          "approved_at",
          "approved_by",
          "rejected_at",
          "rejected_by",
          "rejected_reason",
          "submitted_at",
          "submitted_by",
          "version_id",
          "version_sequence",
        ])
        .where("tenant_id", "=", tenantId)
        .where("agent_id", "=", agentId)
        .where("version_id", "=", agent.active_version_id)
        .executeTakeFirst();

      if (activeVersionRecord !== undefined) {
        const publications = await this.db
          .selectFrom("environment_publications")
          .leftJoin(
            "publication_health",
            "publication_health.publication_id",
            "environment_publications.publication_id",
          )
          .select([
            "environment_publications.environment_key",
            "environment_publications.health_endpoint_url",
            "environment_publications.publication_id",
            "publication_health.health_status",
          ])
          .where("environment_publications.tenant_id", "=", tenantId)
          .where("environment_publications.agent_id", "=", agentId)
          .where("environment_publications.version_id", "=", agent.active_version_id)
          .orderBy("environment_publications.environment_key")
          .execute();
        const telemetryByPublication = await this.getTelemetryByPublicationIds(
          tenantId,
          publications.map((publication) => publication.publication_id),
        );

        activeVersion = {
          approvalState: activeVersionRecord.approval_state as ApprovalState,
          publications: publications.map((publication) => ({
            environmentKey: publication.environment_key,
            healthEndpointUrl: publication.health_endpoint_url,
            healthStatus: publication.health_status,
            publicationId: publication.publication_id,
            telemetry: telemetryByPublication.get(publication.publication_id) ?? [],
          })),
          review: mapReviewMetadata(activeVersionRecord),
          versionId: activeVersionRecord.version_id,
          versionSequence: activeVersionRecord.version_sequence,
        };
      }
    }

    return {
      activeVersion,
      activeVersionId: agent.active_version_id,
      agentId: agent.agent_id,
      overlay: {
        agent: {
          deprecated: agentOverlay?.deprecated ?? false,
          disabled: agentOverlay?.disabled ?? false,
          requiredRoles: agentOverlay?.required_roles ?? [],
          requiredScopes: agentOverlay?.required_scopes ?? [],
        },
        environments: environmentOverlays,
      },
      versions: versions.map((version) => ({
        approvalState: version.approval_state as ApprovalState,
        versionId: version.version_id,
        versionSequence: version.version_sequence,
      })),
    };
  }

  async getVersionDetail(
    tenantId: string,
    agentId: string,
    versionId: string,
  ): Promise<VersionAdminDetailRecord> {
    const agent = await this.db
      .selectFrom("agents")
      .select(["active_version_id", "agent_id"])
      .where("tenant_id", "=", tenantId)
      .where("agent_id", "=", agentId)
      .executeTakeFirst();

    if (agent === undefined) {
      throw new AgentNotFoundError(tenantId, agentId);
    }

    const version = await this.db
      .selectFrom("agent_versions")
      .select([
        "approval_state",
        "approved_at",
        "approved_by",
        "card_profile_id",
        "context_contract",
        "display_name",
        "header_contract",
        "rejected_at",
        "rejected_by",
        "rejected_reason",
        "required_roles",
        "required_scopes",
        "submitted_at",
        "submitted_by",
        "summary",
        "tags",
        "version_id",
        "version_label",
        "version_sequence",
      ])
      .where("tenant_id", "=", tenantId)
      .where("agent_id", "=", agentId)
      .where("version_id", "=", versionId)
      .executeTakeFirst();

    if (version === undefined) {
      throw new AgentVersionNotFoundError(tenantId, agentId, versionId);
    }

    const publications = await this.db
      .selectFrom("environment_publications")
      .leftJoin(
        "publication_health",
        "publication_health.publication_id",
        "environment_publications.publication_id",
      )
      .select([
        "environment_publications.environment_key",
        "environment_publications.health_endpoint_url",
        "publication_health.health_status",
        "environment_publications.invocation_endpoint",
        "environment_publications.normalized_metadata",
        "environment_publications.publication_id",
        "environment_publications.raw_card",
      ])
      .where("environment_publications.tenant_id", "=", tenantId)
      .where("environment_publications.agent_id", "=", agentId)
      .where("environment_publications.version_id", "=", versionId)
      .orderBy("environment_publications.environment_key")
      .execute();
    const telemetryByPublication = await this.getTelemetryByPublicationIds(
      tenantId,
      publications.map((publication) => publication.publication_id),
    );

    return {
      active: agent.active_version_id === versionId,
      agentId: agent.agent_id,
      approvalState: version.approval_state as ApprovalState,
      cardProfileId: version.card_profile_id,
      contextContract: version.context_contract,
      displayName: version.display_name,
      headerContract: version.header_contract,
      publications: publications.map((publication) => ({
        environmentKey: publication.environment_key,
        healthEndpointUrl: publication.health_endpoint_url,
        healthStatus: publication.health_status,
        invocationEndpoint: publication.invocation_endpoint,
        normalizedMetadata: publication.normalized_metadata,
        publicationId: publication.publication_id,
        rawCard: publication.raw_card,
        telemetry: telemetryByPublication.get(publication.publication_id) ?? [],
      })),
      requiredRoles: version.required_roles,
      requiredScopes: version.required_scopes,
      review: mapReviewMetadata(version),
      summary: version.summary,
      tags: version.tags,
      versionId: version.version_id,
      versionLabel: version.version_label,
      versionSequence: version.version_sequence,
    };
  }
}
