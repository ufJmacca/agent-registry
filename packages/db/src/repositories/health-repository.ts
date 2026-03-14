import {
  reducePublicationHealth,
  type PublicationProbeCheck,
} from "@agent-registry/config";
import type { PublicationHealthDetailResponse } from "@agent-registry/contracts";
import { sql } from "kysely";

import type { AgentRegistryDb } from "../index.js";

export interface ApprovedPublicationRecord {
  agentId: string;
  environmentKey: string;
  healthEndpointUrl: string;
  publicationId: string;
  tenantId: string;
  versionId: string;
}

export interface RecordPublicationProbeInput extends PublicationProbeCheck {
  degradedThreshold?: number;
  failureWindow?: number;
  publicationId: string;
}

export interface HealthRepository {
  getApprovedPublicationForProbing(publicationId: string): Promise<ApprovedPublicationRecord | null>;
  getPublicationHealth(
    tenantId: string,
    agentId: string,
    versionId: string,
    environmentKey: string,
  ): Promise<PublicationHealthDetailResponse>;
  listApprovedPublicationsForProbing(): Promise<ApprovedPublicationRecord[]>;
  recordPublicationProbe(input: RecordPublicationProbeInput): Promise<void>;
}

export class PublicationHealthNotFoundError extends Error {
  constructor(
    tenantId: string,
    agentId: string,
    versionId: string,
    environmentKey: string,
  ) {
    super(
      `Approved publication health was not found for tenant '${tenantId}', agent '${agentId}', version '${versionId}', environment '${environmentKey}'.`,
    );
  }
}

function mapProbeHistoryRow(row: {
  checked_at: Date | string;
  error: string | null;
  ok: boolean;
  status_code: number | null;
}): PublicationProbeCheck {
  const checkedAt =
    row.checked_at instanceof Date ? row.checked_at.toISOString() : row.checked_at;

  return {
    checkedAt,
    error: row.error,
    ok: row.ok,
    statusCode: row.status_code,
  };
}

export class KyselyHealthRepository implements HealthRepository {
  private readonly db: AgentRegistryDb;

  constructor(db: AgentRegistryDb) {
    this.db = db;
  }

  async listApprovedPublicationsForProbing(): Promise<ApprovedPublicationRecord[]> {
    const publications = await this.db
      .selectFrom("environment_publications")
      .innerJoin("agent_versions", (join) =>
        join
          .onRef("agent_versions.tenant_id", "=", "environment_publications.tenant_id")
          .onRef("agent_versions.agent_id", "=", "environment_publications.agent_id")
          .onRef("agent_versions.version_id", "=", "environment_publications.version_id"),
      )
      .select([
        "environment_publications.agent_id",
        "environment_publications.environment_key",
        "environment_publications.health_endpoint_url",
        "environment_publications.publication_id",
        "environment_publications.tenant_id",
        "environment_publications.version_id",
      ])
      .where("agent_versions.approval_state", "=", "approved")
      .orderBy("environment_publications.publication_id")
      .execute();

    return publications.map((publication) => ({
      agentId: publication.agent_id,
      environmentKey: publication.environment_key,
      healthEndpointUrl: publication.health_endpoint_url,
      publicationId: publication.publication_id,
      tenantId: publication.tenant_id,
      versionId: publication.version_id,
    }));
  }

  async getApprovedPublicationForProbing(
    publicationId: string,
  ): Promise<ApprovedPublicationRecord | null> {
    const publication = await this.db
      .selectFrom("environment_publications")
      .innerJoin("agent_versions", (join) =>
        join
          .onRef("agent_versions.tenant_id", "=", "environment_publications.tenant_id")
          .onRef("agent_versions.agent_id", "=", "environment_publications.agent_id")
          .onRef("agent_versions.version_id", "=", "environment_publications.version_id"),
      )
      .select([
        "environment_publications.agent_id",
        "environment_publications.environment_key",
        "environment_publications.health_endpoint_url",
        "environment_publications.publication_id",
        "environment_publications.tenant_id",
        "environment_publications.version_id",
      ])
      .where("environment_publications.publication_id", "=", publicationId)
      .where("agent_versions.approval_state", "=", "approved")
      .executeTakeFirst();

    if (publication === undefined) {
      return null;
    }

    return {
      agentId: publication.agent_id,
      environmentKey: publication.environment_key,
      healthEndpointUrl: publication.health_endpoint_url,
      publicationId: publication.publication_id,
      tenantId: publication.tenant_id,
      versionId: publication.version_id,
    };
  }

  async recordPublicationProbe(input: RecordPublicationProbeInput): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("publication_probe_history")
        .values({
          checked_at: input.checkedAt,
          error: input.error,
          ok: input.ok,
          publication_id: input.publicationId,
          status_code: input.statusCode,
        })
        .execute();

      const recentChecks = await transaction
        .selectFrom("publication_probe_history")
        .select(["checked_at", "error", "ok", "status_code"])
        .where("publication_id", "=", input.publicationId)
        .orderBy("checked_at", "desc")
        .orderBy("probe_id", "desc")
        .limit(input.failureWindow ?? 3)
        .execute();

      const currentHealth = await transaction
        .selectFrom("publication_health")
        .select("last_success_at")
        .where("publication_id", "=", input.publicationId)
        .executeTakeFirst();

      const reduced = reducePublicationHealth(
        recentChecks.map(mapProbeHistoryRow),
        {
          degradedThreshold: input.degradedThreshold,
          failureWindow: input.failureWindow,
        },
      );

      await transaction
        .insertInto("publication_health")
        .values({
          consecutive_failures: reduced.consecutiveFailures,
          health_status: reduced.healthStatus,
          last_checked_at: input.checkedAt,
          last_error: input.ok ? null : input.error,
          last_success_at: input.ok ? input.checkedAt : (currentHealth?.last_success_at ?? null),
          publication_id: input.publicationId,
          recent_failures: reduced.recentFailures,
          updated_at: sql<string>`now()`,
        })
        .onConflict((conflict) =>
          conflict.column("publication_id").doUpdateSet({
            consecutive_failures: reduced.consecutiveFailures,
            health_status: reduced.healthStatus,
            last_checked_at: input.checkedAt,
            last_error: input.ok ? null : input.error,
            last_success_at: input.ok ? input.checkedAt : (currentHealth?.last_success_at ?? null),
            recent_failures: reduced.recentFailures,
            updated_at: sql<string>`now()`,
          }),
        )
        .execute();
    });
  }

  async getPublicationHealth(
    tenantId: string,
    agentId: string,
    versionId: string,
    environmentKey: string,
  ): Promise<PublicationHealthDetailResponse> {
    const publication = await this.db
      .selectFrom("environment_publications")
      .innerJoin("agent_versions", (join) =>
        join
          .onRef("agent_versions.tenant_id", "=", "environment_publications.tenant_id")
          .onRef("agent_versions.agent_id", "=", "environment_publications.agent_id")
          .onRef("agent_versions.version_id", "=", "environment_publications.version_id"),
      )
      .leftJoin(
        "publication_health",
        "publication_health.publication_id",
        "environment_publications.publication_id",
      )
      .select([
        "environment_publications.environment_key",
        "environment_publications.publication_id",
        "publication_health.consecutive_failures",
        "publication_health.health_status",
        "publication_health.last_checked_at",
        "publication_health.last_error",
        "publication_health.last_success_at",
        "publication_health.recent_failures",
      ])
      .where("environment_publications.tenant_id", "=", tenantId)
      .where("environment_publications.agent_id", "=", agentId)
      .where("environment_publications.version_id", "=", versionId)
      .where("environment_publications.environment_key", "=", environmentKey)
      .where("agent_versions.approval_state", "=", "approved")
      .executeTakeFirst();

    if (publication === undefined) {
      throw new PublicationHealthNotFoundError(tenantId, agentId, versionId, environmentKey);
    }

    const history = await this.db
      .selectFrom("publication_probe_history")
      .select(["checked_at", "error", "ok", "status_code"])
      .where("publication_id", "=", publication.publication_id)
      .orderBy("checked_at", "desc")
      .orderBy("probe_id", "desc")
      .limit(3)
      .execute();

    return {
      current: {
        consecutiveFailures: publication.consecutive_failures ?? 0,
        healthStatus: publication.health_status ?? "unknown",
        lastCheckedAt: publication.last_checked_at,
        lastError: publication.last_error,
        lastSuccessAt: publication.last_success_at,
        recentFailures: publication.recent_failures ?? 0,
      },
      environmentKey: publication.environment_key,
      history: history.map(mapProbeHistoryRow),
      publicationId: publication.publication_id,
    };
  }
}
