import { sql } from "kysely";

import type { AgentRegistryDb } from "../index.js";
import {
  AgentEnvironmentPublicationNotFoundError,
  AgentNotFoundError,
} from "./agent-repository-errors.js";

export interface TenantPolicyOverlayRecord {
  agentId: string;
  deprecated: boolean;
  disabled: boolean;
  environmentKey: string | null;
  requiredRoles: string[];
  requiredScopes: string[];
}

export interface UpsertTenantPolicyOverlayInput {
  agentId: string;
  deprecated?: boolean;
  disabled?: boolean;
  environmentKey: string | null;
  requiredRoles?: string[];
  requiredScopes?: string[];
  tenantId: string;
}

export interface TenantPolicyOverlayRepository {
  listForAgent(tenantId: string, agentId: string): Promise<TenantPolicyOverlayRecord[]>;
  upsertNarrowingOverlay(
    input: UpsertTenantPolicyOverlayInput,
  ): Promise<TenantPolicyOverlayRecord>;
}

function sortUniqueStrings(values: string[]): string[] {
  return [...new Set(values)].sort();
}

export class KyselyTenantPolicyOverlayRepository implements TenantPolicyOverlayRepository {
  private readonly db: AgentRegistryDb;

  constructor(db: AgentRegistryDb) {
    this.db = db;
  }

  async listForAgent(tenantId: string, agentId: string): Promise<TenantPolicyOverlayRecord[]> {
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
      .where("agent_id", "=", agentId)
      .orderBy("environment_key")
      .execute();

    return overlays.map((overlay) => ({
      agentId: overlay.agent_id,
      deprecated: overlay.deprecated,
      disabled: overlay.disabled,
      environmentKey: overlay.environment_key,
      requiredRoles: overlay.required_roles,
      requiredScopes: overlay.required_scopes,
    }));
  }

  async upsertNarrowingOverlay(
    input: UpsertTenantPolicyOverlayInput,
  ): Promise<TenantPolicyOverlayRecord> {
    return this.db.transaction().execute(async (transaction) => {
      const agent = await transaction
        .selectFrom("agents")
        .select(["active_version_id", "agent_id"])
        .where("tenant_id", "=", input.tenantId)
        .where("agent_id", "=", input.agentId)
        .forUpdate()
        .executeTakeFirst();

      if (agent === undefined) {
        throw new AgentNotFoundError(input.tenantId, input.agentId);
      }

      if (input.environmentKey !== null) {
        if (agent.active_version_id === null) {
          throw new AgentEnvironmentPublicationNotFoundError(
            input.tenantId,
            input.agentId,
            input.environmentKey,
          );
        }

        const activePublication = await transaction
          .selectFrom("environment_publications")
          .select("publication_id")
          .where("tenant_id", "=", input.tenantId)
          .where("agent_id", "=", input.agentId)
          .where("version_id", "=", agent.active_version_id)
          .where("environment_key", "=", input.environmentKey)
          .executeTakeFirst();

        if (activePublication === undefined) {
          throw new AgentEnvironmentPublicationNotFoundError(
            input.tenantId,
            input.agentId,
            input.environmentKey,
          );
        }
      }

      let existingQuery = transaction
        .selectFrom("tenant_policy_overlays")
        .select([
          "deprecated",
          "disabled",
          "environment_key",
          "overlay_id",
          "required_roles",
          "required_scopes",
        ])
        .where("tenant_id", "=", input.tenantId)
        .where("agent_id", "=", input.agentId);

      existingQuery =
        input.environmentKey === null
          ? existingQuery.where("environment_key", "is", null)
          : existingQuery.where("environment_key", "=", input.environmentKey);

      const existing = await existingQuery.forUpdate().executeTakeFirst();
      const requiredRoles = sortUniqueStrings([
        ...(existing?.required_roles ?? []),
        ...(input.requiredRoles ?? []),
      ]);
      const requiredScopes = sortUniqueStrings([
        ...(existing?.required_scopes ?? []),
        ...(input.requiredScopes ?? []),
      ]);
      const deprecated = (existing?.deprecated ?? false) || (input.deprecated ?? false);
      const disabled = (existing?.disabled ?? false) || (input.disabled ?? false);

      if (existing === undefined) {
        await transaction
          .insertInto("tenant_policy_overlays")
          .values({
            agent_id: input.agentId,
            deprecated,
            disabled,
            environment_key: input.environmentKey,
            required_roles: requiredRoles,
            required_scopes: requiredScopes,
            tenant_id: input.tenantId,
          })
          .execute();
      } else {
        await transaction
          .updateTable("tenant_policy_overlays")
          .set({
            deprecated,
            disabled,
            required_roles: requiredRoles,
            required_scopes: requiredScopes,
            updated_at: sql<string>`now()`,
          })
          .where("overlay_id", "=", existing.overlay_id)
          .execute();
      }

      return {
        agentId: input.agentId,
        deprecated,
        disabled,
        environmentKey: input.environmentKey,
        requiredRoles,
        requiredScopes,
      };
    });
  }
}
