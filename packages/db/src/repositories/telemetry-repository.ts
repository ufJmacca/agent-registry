import { sql } from "kysely";

import type { AgentRegistryDb } from "../index.js";
import {
  AgentVersionEnvironmentPublicationNotFoundError,
  AgentVersionNotFoundError,
} from "./agent-repository-errors.js";

export interface PublicationTelemetryRecord {
  errorCount: number;
  invocationCount: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  recordedAt: string;
  successCount: number;
  windowEndedAt: string;
  windowStartedAt: string;
}

export interface UpsertPublicationTelemetryInput {
  agentId: string;
  environmentKey: string;
  errorCount: number;
  invocationCount: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  successCount: number;
  tenantId: string;
  versionId: string;
  windowEndedAt: string;
  windowStartedAt: string;
}

export interface PublicationTelemetryRepository {
  upsertPublicationTelemetry(
    input: UpsertPublicationTelemetryInput,
  ): Promise<PublicationTelemetryRecord>;
}

export class KyselyPublicationTelemetryRepository implements PublicationTelemetryRepository {
  private readonly db: AgentRegistryDb;

  constructor(db: AgentRegistryDb) {
    this.db = db;
  }

  async upsertPublicationTelemetry(
    input: UpsertPublicationTelemetryInput,
  ): Promise<PublicationTelemetryRecord> {
    const version = await this.db
      .selectFrom("agent_versions")
      .select("version_id")
      .where("tenant_id", "=", input.tenantId)
      .where("agent_id", "=", input.agentId)
      .where("version_id", "=", input.versionId)
      .executeTakeFirst();

    if (version === undefined) {
      throw new AgentVersionNotFoundError(input.tenantId, input.agentId, input.versionId);
    }

    const publication = await this.db
      .selectFrom("environment_publications")
      .select("publication_id")
      .where("tenant_id", "=", input.tenantId)
      .where("agent_id", "=", input.agentId)
      .where("version_id", "=", input.versionId)
      .where("environment_key", "=", input.environmentKey)
      .executeTakeFirst();

    if (publication === undefined) {
      throw new AgentVersionEnvironmentPublicationNotFoundError(
        input.tenantId,
        input.agentId,
        input.versionId,
        input.environmentKey,
      );
    }

    const record = await this.db
      .insertInto("publication_telemetry")
      .values({
        error_count: input.errorCount,
        invocation_count: input.invocationCount,
        p50_latency_ms: input.p50LatencyMs,
        p95_latency_ms: input.p95LatencyMs,
        publication_id: publication.publication_id,
        success_count: input.successCount,
        tenant_id: input.tenantId,
        window_ended_at: input.windowEndedAt,
        window_started_at: input.windowStartedAt,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["tenant_id", "publication_id", "window_started_at", "window_ended_at"])
          .doUpdateSet({
            error_count: input.errorCount,
            invocation_count: input.invocationCount,
            p50_latency_ms: input.p50LatencyMs,
            p95_latency_ms: input.p95LatencyMs,
            recorded_at: sql<string>`now()`,
            success_count: input.successCount,
          }),
      )
      .returning([
        "error_count",
        "invocation_count",
        "p50_latency_ms",
        "p95_latency_ms",
        "recorded_at",
        "success_count",
        "window_ended_at",
        "window_started_at",
      ])
      .executeTakeFirstOrThrow();

    return {
      errorCount: record.error_count,
      invocationCount: record.invocation_count,
      p50LatencyMs: record.p50_latency_ms,
      p95LatencyMs: record.p95_latency_ms,
      recordedAt: record.recorded_at,
      successCount: record.success_count,
      windowEndedAt: record.window_ended_at,
      windowStartedAt: record.window_started_at,
    };
  }
}
