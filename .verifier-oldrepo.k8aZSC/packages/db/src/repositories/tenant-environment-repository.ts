import type { AgentRegistryDb } from "../index.js";

export interface TenantEnvironmentRecord {
  environmentKey: string;
}

export interface TenantEnvironmentCatalogRepository {
  create(tenantId: string, environmentKey: string): Promise<TenantEnvironmentRecord>;
  listForTenant(tenantId: string): Promise<TenantEnvironmentRecord[]>;
}

export class DuplicateTenantEnvironmentError extends Error {
  readonly environmentKey: string;

  readonly tenantId: string;

  constructor(tenantId: string, environmentKey: string) {
    super(`Environment '${environmentKey}' already exists for tenant '${tenantId}'.`);
    this.environmentKey = environmentKey;
    this.tenantId = tenantId;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code === "23505"
  );
}

export class KyselyTenantEnvironmentRepository implements TenantEnvironmentCatalogRepository {
  private readonly db: AgentRegistryDb;

  constructor(db: AgentRegistryDb) {
    this.db = db;
  }

  async listForTenant(tenantId: string): Promise<TenantEnvironmentRecord[]> {
    const records = await this.db
      .selectFrom("tenant_environments")
      .select("environment_key")
      .where("tenant_id", "=", tenantId)
      .orderBy("environment_key")
      .execute();

    return records.map((record) => ({
      environmentKey: record.environment_key,
    }));
  }

  async create(tenantId: string, environmentKey: string): Promise<TenantEnvironmentRecord> {
    try {
      const record = await this.db
        .insertInto("tenant_environments")
        .values({
          environment_key: environmentKey,
          tenant_id: tenantId,
        })
        .returning("environment_key")
        .executeTakeFirstOrThrow();

      return {
        environmentKey: record.environment_key,
      };
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DuplicateTenantEnvironmentError(tenantId, environmentKey);
      }

      throw error;
    }
  }
}
