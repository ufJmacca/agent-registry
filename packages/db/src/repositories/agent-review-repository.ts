import { sql } from "kysely";

import type { AgentRegistryDb } from "../index.js";
import { AgentVersionNotFoundError } from "./agent-repository-errors.js";

export type ApprovalState = "draft" | "pending_review" | "approved" | "rejected";

export interface ReviewPublicationRecord {
  environmentKey: string;
  healthEndpointUrl: string;
  publicationId: string;
}

export interface VersionLifecycleRecord {
  activeVersionId: string | null;
  agentId: string;
  approvalState: ApprovalState;
  versionId: string;
}

export interface VersionReviewRecord {
  agentId: string;
  approvalState: ApprovalState;
  publications: ReviewPublicationRecord[];
  versionId: string;
  versionSequence: number;
}

export interface ApproveVersionInput {
  agentId: string;
  approvedBy: string;
  tenantId: string;
  versionId: string;
}

export interface RejectVersionInput {
  agentId: string;
  rejectedBy: string;
  rejectedReason: string;
  tenantId: string;
  versionId: string;
}

export interface SubmitVersionInput {
  agentId: string;
  submittedBy: string;
  tenantId: string;
  versionId: string;
}

export interface AgentReviewRepository {
  approveVersion(input: ApproveVersionInput): Promise<VersionLifecycleRecord>;
  getVersionForReview(
    tenantId: string,
    agentId: string,
    versionId: string,
  ): Promise<VersionReviewRecord>;
  rejectVersion(input: RejectVersionInput): Promise<VersionLifecycleRecord>;
  submitVersion(input: SubmitVersionInput): Promise<VersionLifecycleRecord>;
}

export class InvalidVersionTransitionError extends Error {}

async function loadVersion(
  db: AgentRegistryDb,
  tenantId: string,
  agentId: string,
  versionId: string,
): Promise<{
  approval_state: string;
  version_id: string;
  version_sequence: number;
}> {
  const version = await db
    .selectFrom("agent_versions")
    .select(["approval_state", "version_id", "version_sequence"])
    .where("tenant_id", "=", tenantId)
    .where("agent_id", "=", agentId)
    .where("version_id", "=", versionId)
    .executeTakeFirst();

  if (version === undefined) {
    throw new AgentVersionNotFoundError(tenantId, agentId, versionId);
  }

  return version;
}

async function loadVersionPublications(
  db: AgentRegistryDb,
  tenantId: string,
  agentId: string,
  versionId: string,
): Promise<ReviewPublicationRecord[]> {
  const publications = await db
    .selectFrom("environment_publications")
    .select(["environment_key", "health_endpoint_url", "publication_id"])
    .where("tenant_id", "=", tenantId)
    .where("agent_id", "=", agentId)
    .where("version_id", "=", versionId)
    .orderBy("environment_key")
    .execute();

  return publications.map((publication) => ({
    environmentKey: publication.environment_key,
    healthEndpointUrl: publication.health_endpoint_url,
    publicationId: publication.publication_id,
  }));
}

export class KyselyAgentReviewRepository implements AgentReviewRepository {
  private readonly db: AgentRegistryDb;

  constructor(db: AgentRegistryDb) {
    this.db = db;
  }

  async getVersionForReview(
    tenantId: string,
    agentId: string,
    versionId: string,
  ): Promise<VersionReviewRecord> {
    const version = await loadVersion(this.db, tenantId, agentId, versionId);
    const publications = await loadVersionPublications(this.db, tenantId, agentId, versionId);

    return {
      agentId,
      approvalState: version.approval_state as ApprovalState,
      publications,
      versionId: version.version_id,
      versionSequence: version.version_sequence,
    };
  }

  async submitVersion(input: SubmitVersionInput): Promise<VersionLifecycleRecord> {
    return this.db.transaction().execute(async (transaction) => {
      const version = await transaction
        .selectFrom("agent_versions")
        .select(["approval_state", "version_id"])
        .where("tenant_id", "=", input.tenantId)
        .where("agent_id", "=", input.agentId)
        .where("version_id", "=", input.versionId)
        .forUpdate()
        .executeTakeFirst();

      if (version === undefined) {
        throw new AgentVersionNotFoundError(input.tenantId, input.agentId, input.versionId);
      }

      if (version.approval_state !== "draft") {
        throw new InvalidVersionTransitionError("Only draft versions can be submitted.");
      }

      await transaction
        .updateTable("agent_versions")
        .set({
          approval_state: "pending_review",
          submitted_at: new Date().toISOString(),
          submitted_by: input.submittedBy,
        })
        .where("tenant_id", "=", input.tenantId)
        .where("agent_id", "=", input.agentId)
        .where("version_id", "=", input.versionId)
        .execute();

      const agent = await transaction
        .selectFrom("agents")
        .select("active_version_id")
        .where("tenant_id", "=", input.tenantId)
        .where("agent_id", "=", input.agentId)
        .executeTakeFirstOrThrow();

      return {
        activeVersionId: agent.active_version_id,
        agentId: input.agentId,
        approvalState: "pending_review",
        versionId: input.versionId,
      };
    });
  }

  async approveVersion(input: ApproveVersionInput): Promise<VersionLifecycleRecord> {
    return this.db.transaction().execute(async (transaction) => {
      const version = await transaction
        .selectFrom("agent_versions")
        .select(["approval_state", "version_id", "version_sequence"])
        .where("tenant_id", "=", input.tenantId)
        .where("agent_id", "=", input.agentId)
        .where("version_id", "=", input.versionId)
        .forUpdate()
        .executeTakeFirst();

      if (version === undefined) {
        throw new AgentVersionNotFoundError(input.tenantId, input.agentId, input.versionId);
      }

      if (version.approval_state !== "pending_review") {
        throw new InvalidVersionTransitionError("Only pending_review versions can be approved.");
      }

      const publications = await transaction
        .selectFrom("environment_publications")
        .select(["publication_id"])
        .where("tenant_id", "=", input.tenantId)
        .where("agent_id", "=", input.agentId)
        .where("version_id", "=", input.versionId)
        .execute();

      await transaction
        .updateTable("agent_versions")
        .set({
          approval_state: "approved",
          approved_at: new Date().toISOString(),
          approved_by: input.approvedBy,
        })
        .where("tenant_id", "=", input.tenantId)
        .where("agent_id", "=", input.agentId)
        .where("version_id", "=", input.versionId)
        .execute();

      const highestOtherApproved = await transaction
        .selectFrom("agent_versions")
        .select((expressionBuilder) =>
          expressionBuilder.fn.max<number>("version_sequence").as("max_version_sequence"),
        )
        .where("tenant_id", "=", input.tenantId)
        .where("agent_id", "=", input.agentId)
        .where("approval_state", "=", "approved")
        .where("version_id", "!=", input.versionId)
        .executeTakeFirst();

      let activeVersionId: string | null = null;

      if (Number(highestOtherApproved?.max_version_sequence ?? 0) < version.version_sequence) {
        await transaction
          .updateTable("agents")
          .set({
            active_version_id: input.versionId,
            updated_at: sql<string>`now()`,
          })
          .where("tenant_id", "=", input.tenantId)
          .where("agent_id", "=", input.agentId)
          .execute();
        activeVersionId = input.versionId;
      } else {
        const agent = await transaction
          .selectFrom("agents")
          .select("active_version_id")
          .where("tenant_id", "=", input.tenantId)
          .where("agent_id", "=", input.agentId)
          .executeTakeFirstOrThrow();
        activeVersionId = agent.active_version_id;
      }

      if (publications.length > 0) {
        await transaction
          .insertInto("publication_health")
          .values(
            publications.map((publication) => ({
              health_status: "unknown" as const,
              publication_id: publication.publication_id,
            })),
          )
          .onConflict((conflict) => conflict.column("publication_id").doNothing())
          .execute();
      }

      return {
        activeVersionId,
        agentId: input.agentId,
        approvalState: "approved",
        versionId: input.versionId,
      };
    });
  }

  async rejectVersion(input: RejectVersionInput): Promise<VersionLifecycleRecord> {
    return this.db.transaction().execute(async (transaction) => {
      const version = await transaction
        .selectFrom("agent_versions")
        .select(["approval_state", "version_id"])
        .where("tenant_id", "=", input.tenantId)
        .where("agent_id", "=", input.agentId)
        .where("version_id", "=", input.versionId)
        .forUpdate()
        .executeTakeFirst();

      if (version === undefined) {
        throw new AgentVersionNotFoundError(input.tenantId, input.agentId, input.versionId);
      }

      if (version.approval_state !== "pending_review") {
        throw new InvalidVersionTransitionError("Only pending_review versions can be rejected.");
      }

      await transaction
        .updateTable("agent_versions")
        .set({
          approval_state: "rejected",
          rejected_at: new Date().toISOString(),
          rejected_by: input.rejectedBy,
          rejected_reason: input.rejectedReason,
        })
        .where("tenant_id", "=", input.tenantId)
        .where("agent_id", "=", input.agentId)
        .where("version_id", "=", input.versionId)
        .execute();

      const agent = await transaction
        .selectFrom("agents")
        .select("active_version_id")
        .where("tenant_id", "=", input.tenantId)
        .where("agent_id", "=", input.agentId)
        .executeTakeFirstOrThrow();

      return {
        activeVersionId: agent.active_version_id,
        agentId: input.agentId,
        approvalState: "rejected",
        versionId: input.versionId,
      };
    });
  }
}
