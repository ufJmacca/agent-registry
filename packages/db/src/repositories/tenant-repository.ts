import type { AgentRegistryDb } from "../index.js";

export interface TenantRecord {
  defaultCardProfileId: string;
  tenantId: string;
}

export interface TenantRepository {
  getById(tenantId: string): Promise<TenantRecord | null>;
}

export class KyselyTenantRepository implements TenantRepository {
  private readonly db: AgentRegistryDb;

  constructor(db: AgentRegistryDb) {
    this.db = db;
  }

  async getById(tenantId: string): Promise<TenantRecord | null> {
    const record = await this.db
      .selectFrom("tenants")
      .select(["default_card_profile_id", "tenant_id"])
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();

    if (record === undefined) {
      return null;
    }

    return {
      defaultCardProfileId: record.default_card_profile_id,
      tenantId: record.tenant_id,
    };
  }
}
