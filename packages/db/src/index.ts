import {
  JSONColumnType,
  Kysely,
  Migrator,
  PostgresDialect,
  sql,
  type Generated,
  type Migration,
  type MigrationResult,
  type MigrationProvider,
} from "kysely";
import pg from "pg";

const { Pool } = pg;

export * from "./repositories/index.js";

export interface DatabaseConfig {
  database: string;
  host: string;
  password: string;
  port: number;
  user: string;
}

export const defaultDatabaseConfig: DatabaseConfig = {
  database: "agent_registry",
  host: "postgres",
  password: "registry",
  port: 5432,
  user: "registry",
};

export type DeploymentMode = "hosted" | "self-hosted";
export type HealthStatus = "unknown" | "healthy" | "degraded" | "unreachable";

export interface TenantsTable {
  created_at: Generated<string>;
  default_card_profile_id: Generated<string>;
  deployment_mode: DeploymentMode;
  display_name: string;
  tenant_id: string;
  updated_at: Generated<string>;
}

export interface TenantMembershipsTable {
  created_at: Generated<string>;
  registry_capabilities: string[];
  roles: string[];
  scopes: string[];
  subject_id: string;
  tenant_id: string;
  updated_at: Generated<string>;
  user_context: Record<string, unknown>;
}

export interface TenantEnvironmentsTable {
  created_at: Generated<string>;
  environment_key: string;
  tenant_id: string;
}

export interface AgentsTable {
  active_version_id: string | null;
  created_at: Generated<string>;
  deprecated: Generated<boolean>;
  disabled: Generated<boolean>;
  display_name: string;
  summary: string;
  tenant_id: string;
  updated_at: Generated<string>;
  agent_id: string;
}

export interface AgentVersionsTable {
  approved_at: string | null;
  approved_by: string | null;
  approval_state: string;
  card_profile_id: Generated<string>;
  context_contract: JSONColumnType<unknown[]>;
  created_at: Generated<string>;
  display_name: Generated<string>;
  header_contract: JSONColumnType<unknown[]>;
  publisher_id: Generated<string>;
  rejected_at: string | null;
  rejected_by: string | null;
  rejected_reason: string | null;
  required_roles: string[];
  required_scopes: string[];
  submitted_at: string | null;
  submitted_by: string | null;
  summary: string;
  tags: string[];
  capabilities: string[];
  tenant_id: string;
  version_id: string;
  version_label: string;
  version_sequence: number;
  agent_id: string;
}

export interface EnvironmentPublicationsTable {
  created_at: Generated<string>;
  environment_key: string;
  health_endpoint_url: string;
  invocation_endpoint: string | null;
  normalized_metadata: Record<string, unknown>;
  publication_id: string;
  raw_card: string;
  tenant_id: string;
  version_id: string;
  agent_id: string;
}

export interface TenantPolicyOverlaysTable {
  agent_id: string;
  created_at: Generated<string>;
  deprecated: Generated<boolean>;
  disabled: Generated<boolean>;
  environment_key: string | null;
  overlay_id: Generated<number>;
  required_roles: string[];
  required_scopes: string[];
  tenant_id: string;
  updated_at: Generated<string>;
}

export interface PublicationHealthTable {
  consecutive_failures: Generated<number>;
  health_status: HealthStatus;
  last_checked_at: string | null;
  last_error: string | null;
  last_success_at: string | null;
  publication_id: string;
  recent_failures: Generated<number>;
  updated_at: Generated<string>;
}

export interface PublicationProbeHistoryTable {
  checked_at: string;
  error: string | null;
  ok: boolean;
  probe_id: Generated<number>;
  publication_id: string;
  status_code: number | null;
}

export interface PublicationTelemetryTable {
  error_count: number;
  invocation_count: number;
  p50_latency_ms: number | null;
  p95_latency_ms: number | null;
  publication_id: string;
  recorded_at: Generated<string>;
  success_count: number;
  telemetry_id: Generated<number>;
  tenant_id: string;
  window_ended_at: string;
  window_started_at: string;
}

export interface AgentRegistryDatabase {
  agent_versions: AgentVersionsTable;
  agents: AgentsTable;
  environment_publications: EnvironmentPublicationsTable;
  publication_health: PublicationHealthTable;
  publication_probe_history: PublicationProbeHistoryTable;
  publication_telemetry: PublicationTelemetryTable;
  tenant_environments: TenantEnvironmentsTable;
  tenant_memberships: TenantMembershipsTable;
  tenant_policy_overlays: TenantPolicyOverlaysTable;
  tenants: TenantsTable;
}

export type AgentRegistryDb = Kysely<AgentRegistryDatabase>;

export interface BootstrapTenantRecord {
  defaultCardProfileId: string;
  deploymentMode: DeploymentMode;
  displayName: string;
  tenantId: string;
}

export interface BootstrapMembershipRecord {
  registryCapabilities: string[];
  roles: string[];
  scopes: string[];
  subjectId: string;
  userContext: Record<string, unknown>;
}

export interface TenantMembershipRecord extends BootstrapMembershipRecord {
  tenantId: string;
}

export function buildDatabaseUrl(config: DatabaseConfig): string {
  return `postgres://${encodeURIComponent(config.user)}:${encodeURIComponent(config.password)}@${config.host}:${config.port}/${config.database}`;
}

export function createKyselyDb(config: DatabaseConfig | string): AgentRegistryDb {
  const connectionString = typeof config === "string" ? config : buildDatabaseUrl(config);
  const pool = new Pool({ connectionString });

  return new Kysely<AgentRegistryDatabase>({
    dialect: new PostgresDialect({
      pool,
    }),
  });
}

export async function destroyKyselyDb(db: AgentRegistryDb): Promise<void> {
  await db.destroy();
}

interface MigrationDefinition {
  name: string;
  up(db: AgentRegistryDb): Promise<void>;
}

const migrationDefinitions: MigrationDefinition[] = [
  {
    name: "001_initial_registry_schema",
    async up(db) {
      await db.schema
        .createTable("tenants")
        .ifNotExists()
        .addColumn("tenant_id", "text", (column) => column.primaryKey())
        .addColumn("display_name", "text", (column) => column.notNull())
        .addColumn("deployment_mode", "text", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addColumn("updated_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .execute();

      await db.schema
        .createTable("tenant_memberships")
        .ifNotExists()
        .addColumn("tenant_id", "text", (column) =>
          column.notNull().references("tenants.tenant_id").onDelete("cascade"),
        )
        .addColumn("subject_id", "text", (column) => column.notNull())
        .addColumn("roles", sql`text[]`, (column) =>
          column.notNull().defaultTo(sql`'{}'::text[]`),
        )
        .addColumn("scopes", sql`text[]`, (column) =>
          column.notNull().defaultTo(sql`'{}'::text[]`),
        )
        .addColumn("registry_capabilities", sql`text[]`, (column) =>
          column.notNull().defaultTo(sql`'{}'::text[]`),
        )
        .addColumn("user_context", "jsonb", (column) =>
          column.notNull().defaultTo(sql`'{}'::jsonb`),
        )
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addColumn("updated_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addPrimaryKeyConstraint("tenant_memberships_pkey", ["tenant_id", "subject_id"])
        .execute();

      await db.schema
        .createTable("tenant_environments")
        .ifNotExists()
        .addColumn("tenant_id", "text", (column) =>
          column.notNull().references("tenants.tenant_id").onDelete("cascade"),
        )
        .addColumn("environment_key", "text", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addPrimaryKeyConstraint("tenant_environments_pkey", ["tenant_id", "environment_key"])
        .execute();

      await db.schema
        .createTable("agents")
        .ifNotExists()
        .addColumn("tenant_id", "text", (column) =>
          column.notNull().references("tenants.tenant_id").onDelete("cascade"),
        )
        .addColumn("agent_id", "text", (column) => column.notNull())
        .addColumn("display_name", "text", (column) => column.notNull())
        .addColumn("summary", "text", (column) => column.notNull())
        .addColumn("disabled", "boolean", (column) =>
          column.notNull().defaultTo(false),
        )
        .addColumn("deprecated", "boolean", (column) =>
          column.notNull().defaultTo(false),
        )
        .addColumn("active_version_id", "text")
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addColumn("updated_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addPrimaryKeyConstraint("agents_pkey", ["tenant_id", "agent_id"])
        .execute();

      await db.schema
        .createTable("agent_versions")
        .ifNotExists()
        .addColumn("tenant_id", "text", (column) => column.notNull())
        .addColumn("agent_id", "text", (column) => column.notNull())
        .addColumn("version_id", "text", (column) => column.notNull())
        .addColumn("version_sequence", "integer", (column) => column.notNull())
        .addColumn("version_label", "text", (column) => column.notNull())
        .addColumn("summary", "text", (column) => column.notNull())
        .addColumn("capabilities", sql`text[]`, (column) =>
          column.notNull().defaultTo(sql`'{}'::text[]`),
        )
        .addColumn("tags", sql`text[]`, (column) =>
          column.notNull().defaultTo(sql`'{}'::text[]`),
        )
        .addColumn("required_roles", sql`text[]`, (column) =>
          column.notNull().defaultTo(sql`'{}'::text[]`),
        )
        .addColumn("required_scopes", sql`text[]`, (column) =>
          column.notNull().defaultTo(sql`'{}'::text[]`),
        )
        .addColumn("header_contract", "jsonb", (column) =>
          column.notNull().defaultTo(sql`'[]'::jsonb`),
        )
        .addColumn("context_contract", "jsonb", (column) =>
          column.notNull().defaultTo(sql`'[]'::jsonb`),
        )
        .addColumn("approval_state", "text", (column) => column.notNull())
        .addColumn("submitted_at", "timestamptz")
        .addColumn("submitted_by", "text")
        .addColumn("approved_at", "timestamptz")
        .addColumn("approved_by", "text")
        .addColumn("rejected_at", "timestamptz")
        .addColumn("rejected_by", "text")
        .addColumn("rejected_reason", "text")
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addPrimaryKeyConstraint("agent_versions_pkey", ["tenant_id", "agent_id", "version_id"])
        .addForeignKeyConstraint(
          "agent_versions_agent_fk",
          ["tenant_id", "agent_id"],
          "agents",
          ["tenant_id", "agent_id"],
          (constraint) => constraint.onDelete("cascade"),
        )
        .execute();

      await db.schema
        .createIndex("agent_versions_sequence_idx")
        .ifNotExists()
        .on("agent_versions")
        .columns(["tenant_id", "agent_id", "version_sequence"])
        .execute();

      await db.schema
        .createTable("environment_publications")
        .ifNotExists()
        .addColumn("publication_id", "text", (column) => column.primaryKey())
        .addColumn("tenant_id", "text", (column) => column.notNull())
        .addColumn("agent_id", "text", (column) => column.notNull())
        .addColumn("version_id", "text", (column) => column.notNull())
        .addColumn("environment_key", "text", (column) => column.notNull())
        .addColumn("raw_card", "text", (column) => column.notNull())
        .addColumn("invocation_endpoint", "text")
        .addColumn("normalized_metadata", "jsonb", (column) =>
          column.notNull().defaultTo(sql`'{}'::jsonb`),
        )
        .addColumn("health_endpoint_url", "text", (column) => column.notNull())
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addForeignKeyConstraint(
          "environment_publications_version_fk",
          ["tenant_id", "agent_id", "version_id"],
          "agent_versions",
          ["tenant_id", "agent_id", "version_id"],
          (constraint) => constraint.onDelete("cascade"),
        )
        .execute();

      await db.schema
        .createIndex("environment_publications_env_idx")
        .ifNotExists()
        .on("environment_publications")
        .columns(["tenant_id", "environment_key"])
        .execute();

      await db.schema
        .createIndex("environment_publications_version_env_idx")
        .ifNotExists()
        .on("environment_publications")
        .columns(["tenant_id", "agent_id", "version_id", "environment_key"])
        .unique()
        .execute();

      await db.schema
        .createTable("tenant_policy_overlays")
        .ifNotExists()
        .addColumn("overlay_id", "bigserial", (column) => column.primaryKey())
        .addColumn("tenant_id", "text", (column) =>
          column.notNull().references("tenants.tenant_id").onDelete("cascade"),
        )
        .addColumn("agent_id", "text", (column) => column.notNull())
        .addColumn("environment_key", "text")
        .addColumn("required_roles", sql`text[]`, (column) =>
          column.notNull().defaultTo(sql`'{}'::text[]`),
        )
        .addColumn("required_scopes", sql`text[]`, (column) =>
          column.notNull().defaultTo(sql`'{}'::text[]`),
        )
        .addColumn("disabled", "boolean", (column) =>
          column.notNull().defaultTo(false),
        )
        .addColumn("deprecated", "boolean", (column) =>
          column.notNull().defaultTo(false),
        )
        .addColumn("created_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addColumn("updated_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .addForeignKeyConstraint(
          "tenant_policy_overlays_agent_fk",
          ["tenant_id", "agent_id"],
          "agents",
          ["tenant_id", "agent_id"],
          (constraint) => constraint.onDelete("cascade"),
        )
        .execute();

      await db.schema
        .createTable("publication_health")
        .ifNotExists()
        .addColumn("publication_id", "text", (column) =>
          column.primaryKey().references("environment_publications.publication_id").onDelete("cascade"),
        )
        .addColumn("health_status", "text", (column) =>
          column.notNull().defaultTo("unknown"),
        )
        .addColumn("recent_failures", "integer", (column) =>
          column.notNull().defaultTo(0),
        )
        .addColumn("consecutive_failures", "integer", (column) =>
          column.notNull().defaultTo(0),
        )
        .addColumn("last_checked_at", "timestamptz")
        .addColumn("last_success_at", "timestamptz")
        .addColumn("last_error", "text")
        .addColumn("updated_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .execute();

      await db.schema
        .createTable("publication_telemetry")
        .ifNotExists()
        .addColumn("telemetry_id", "bigserial", (column) => column.primaryKey())
        .addColumn("tenant_id", "text", (column) =>
          column.notNull().references("tenants.tenant_id").onDelete("cascade"),
        )
        .addColumn("publication_id", "text", (column) =>
          column.notNull().references("environment_publications.publication_id").onDelete("cascade"),
        )
        .addColumn("invocation_count", "integer", (column) => column.notNull())
        .addColumn("success_count", "integer", (column) => column.notNull())
        .addColumn("error_count", "integer", (column) => column.notNull())
        .addColumn("p50_latency_ms", "integer")
        .addColumn("p95_latency_ms", "integer")
        .addColumn("window_started_at", "timestamptz", (column) => column.notNull())
        .addColumn("window_ended_at", "timestamptz", (column) => column.notNull())
        .addColumn("recorded_at", "timestamptz", (column) =>
          column.notNull().defaultTo(sql`now()`),
        )
        .execute();

      await db.schema
        .createIndex("publication_telemetry_window_idx")
        .ifNotExists()
        .on("publication_telemetry")
        .columns(["tenant_id", "publication_id", "window_started_at", "window_ended_at"])
        .execute();
    },
  },
  {
    name: "002_tenant_default_card_profiles",
    async up(db) {
      await db.schema
        .alterTable("tenants")
        .addColumn("default_card_profile_id", "text", (column) =>
          column.notNull().defaultTo("a2a-default"),
        )
        .execute();
    },
  },
  {
    name: "003_agent_version_profiles_and_sequence_uniqueness",
    async up(db) {
      await sql`
        alter table agent_versions
        add column if not exists card_profile_id text
      `.execute(db);
      await sql`
        alter table agent_versions
        add column if not exists display_name text
      `.execute(db);
      await sql`
        update agent_versions as versions
        set card_profile_id = tenants.default_card_profile_id
        from tenants
        where versions.tenant_id = tenants.tenant_id
          and versions.card_profile_id is null
      `.execute(db);
      await sql`
        update agent_versions as versions
        set display_name = agents.display_name
        from agents
        where versions.tenant_id = agents.tenant_id
          and versions.agent_id = agents.agent_id
          and versions.display_name is null
      `.execute(db);
      await sql`
        alter table agent_versions
        alter column card_profile_id set default 'a2a-default'
      `.execute(db);
      await sql`
        alter table agent_versions
        alter column display_name set default ''
      `.execute(db);
      await sql`
        update agent_versions
        set card_profile_id = 'a2a-default'
        where card_profile_id is null
      `.execute(db);
      await sql`
        update agent_versions
        set display_name = ''
        where display_name is null
      `.execute(db);
      await sql`
        alter table agent_versions
        alter column card_profile_id set not null
      `.execute(db);
      await sql`
        alter table agent_versions
        alter column display_name set not null
      `.execute(db);
      await sql`
        drop index if exists agent_versions_sequence_idx
      `.execute(db);
      await db.schema
        .createIndex("agent_versions_sequence_idx")
        .on("agent_versions")
        .columns(["tenant_id", "agent_id", "version_sequence"])
        .unique()
        .execute();
    },
  },
  {
    name: "004_version_review_metadata",
    async up(db) {
      await sql`
        alter table agent_versions
        add column if not exists submitted_by text
      `.execute(db);
      await sql`
        alter table agent_versions
        add column if not exists approved_at timestamptz
      `.execute(db);
      await sql`
        alter table agent_versions
        add column if not exists approved_by text
      `.execute(db);
      await sql`
        alter table agent_versions
        add column if not exists rejected_at timestamptz
      `.execute(db);
      await sql`
        alter table agent_versions
        add column if not exists rejected_by text
      `.execute(db);
    },
  },
  {
    name: "005_agent_version_publishers",
    async up(db) {
      await sql`
        alter table agent_versions
        add column if not exists publisher_id text
      `.execute(db);
      await sql`
        update agent_versions
        set publisher_id = coalesce(submitted_by, '')
        where publisher_id is null
      `.execute(db);
      await sql`
        alter table agent_versions
        alter column publisher_id set default ''
      `.execute(db);
      await sql`
        alter table agent_versions
        alter column publisher_id set not null
      `.execute(db);
      await db.schema
        .createIndex("agent_versions_publisher_idx")
        .ifNotExists()
        .on("agent_versions")
        .columns(["tenant_id", "publisher_id"])
        .execute();
    },
  },
  {
    name: "006_publication_probe_history",
    async up(db) {
      await db.schema
        .createTable("publication_probe_history")
        .ifNotExists()
        .addColumn("probe_id", "bigserial", (column) => column.primaryKey())
        .addColumn("publication_id", "text", (column) =>
          column.notNull().references("environment_publications.publication_id").onDelete("cascade"),
        )
        .addColumn("checked_at", "timestamptz", (column) => column.notNull())
        .addColumn("ok", "boolean", (column) => column.notNull())
        .addColumn("status_code", "integer")
        .addColumn("error", "text")
        .execute();

      await db.schema
        .createIndex("publication_probe_history_publication_checked_idx")
        .ifNotExists()
        .on("publication_probe_history")
        .columns(["publication_id", "checked_at"])
        .execute();
    },
  },
  {
    name: "007_publication_telemetry_unique_windows",
    async up(db) {
      const telemetryTableResult = await sql<{ exists: boolean }>`
        select to_regclass('public.publication_telemetry') is not null as exists
      `.execute(db);
      const telemetryTableExists = telemetryTableResult.rows[0]?.exists ?? false;

      if (!telemetryTableExists) {
        const publicationTableResult = await sql<{ exists: boolean }>`
          select to_regclass('public.environment_publications') is not null as exists
        `.execute(db);
        const publicationTableExists = publicationTableResult.rows[0]?.exists ?? false;

        if (!publicationTableExists) {
          return;
        }

        await db.schema
          .createTable("publication_telemetry")
          .ifNotExists()
          .addColumn("telemetry_id", "bigserial", (column) => column.primaryKey())
          .addColumn("tenant_id", "text", (column) =>
            column.notNull().references("tenants.tenant_id").onDelete("cascade"),
          )
          .addColumn("publication_id", "text", (column) =>
            column.notNull().references("environment_publications.publication_id").onDelete("cascade"),
          )
          .addColumn("invocation_count", "integer", (column) => column.notNull())
          .addColumn("success_count", "integer", (column) => column.notNull())
          .addColumn("error_count", "integer", (column) => column.notNull())
          .addColumn("p50_latency_ms", "integer")
          .addColumn("p95_latency_ms", "integer")
          .addColumn("window_started_at", "timestamptz", (column) => column.notNull())
          .addColumn("window_ended_at", "timestamptz", (column) => column.notNull())
          .addColumn("recorded_at", "timestamptz", (column) =>
            column.notNull().defaultTo(sql`now()`),
          )
          .execute();
      }

      await sql`
        delete from publication_telemetry as older
        using publication_telemetry as newer
        where older.tenant_id = newer.tenant_id
          and older.publication_id = newer.publication_id
          and older.window_started_at = newer.window_started_at
          and older.window_ended_at = newer.window_ended_at
          and older.telemetry_id < newer.telemetry_id
      `.execute(db);
      await sql`
        drop index if exists publication_telemetry_window_idx
      `.execute(db);
      await db.schema
        .createIndex("publication_telemetry_window_idx")
        .on("publication_telemetry")
        .columns(["tenant_id", "publication_id", "window_started_at", "window_ended_at"])
        .unique()
        .execute();
    },
  },
];

class ForwardOnlyMigrationProvider implements MigrationProvider {
  async getMigrations(): Promise<Record<string, Migration>> {
    return Object.fromEntries(
      migrationDefinitions.map(({ name, up }) => [
        name,
        {
          up,
          async down() {
            throw new Error(`Migration '${name}' is forward-only`);
          },
        },
      ]),
    );
  }
}

export function createRegistryMigrator(db: AgentRegistryDb): Migrator {
  return new Migrator({
    db,
    provider: new ForwardOnlyMigrationProvider(),
  });
}

export async function migrateToLatest(db: AgentRegistryDb): Promise<MigrationResult[]> {
  const migrator = createRegistryMigrator(db);
  const { error, results } = await migrator.migrateToLatest();

  if (error) {
    throw error;
  }

  return results ?? [];
}

export class KyselyTenantMembershipLookup {
  private readonly db: AgentRegistryDb;

  constructor(db: AgentRegistryDb) {
    this.db = db;
  }

  async getMembership(tenantId: string, subjectId: string): Promise<TenantMembershipRecord | null> {
    const record = await this.db
      .selectFrom("tenant_memberships")
      .select([
        "registry_capabilities",
        "roles",
        "scopes",
        "subject_id",
        "tenant_id",
        "user_context",
      ])
      .where("tenant_id", "=", tenantId)
      .where("subject_id", "=", subjectId)
      .executeTakeFirst();

    if (record === undefined) {
      return null;
    }

    return {
      registryCapabilities: record.registry_capabilities,
      roles: record.roles,
      scopes: record.scopes,
      subjectId: record.subject_id,
      tenantId: record.tenant_id,
      userContext: record.user_context,
    };
  }
}

export class KyselyBootstrapRepository {
  private readonly db: AgentRegistryDb;

  constructor(db: AgentRegistryDb) {
    this.db = db;
  }

  async upsertTenant(tenant: BootstrapTenantRecord): Promise<void> {
    await this.db
      .insertInto("tenants")
      .values({
        default_card_profile_id: tenant.defaultCardProfileId,
        deployment_mode: tenant.deploymentMode,
        display_name: tenant.displayName,
        tenant_id: tenant.tenantId,
      })
      .onConflict((conflict) =>
        conflict.column("tenant_id").doUpdateSet({
          default_card_profile_id: tenant.defaultCardProfileId,
          deployment_mode: tenant.deploymentMode,
          display_name: tenant.displayName,
          updated_at: sql<string>`now()`,
        }),
      )
      .execute();
  }

  async replaceEnvironments(tenantId: string, environments: string[]): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      await transaction.deleteFrom("tenant_environments").where("tenant_id", "=", tenantId).execute();

      if (environments.length === 0) {
        return;
      }

      await transaction
        .insertInto("tenant_environments")
        .values(
          environments.map((environmentKey) => ({
            environment_key: environmentKey,
            tenant_id: tenantId,
          })),
        )
        .execute();
    });
  }

  async upsertMembership(tenantId: string, membership: BootstrapMembershipRecord): Promise<void> {
    await this.db
      .insertInto("tenant_memberships")
      .values({
        registry_capabilities: membership.registryCapabilities,
        roles: membership.roles,
        scopes: membership.scopes,
        subject_id: membership.subjectId,
        tenant_id: tenantId,
        user_context: membership.userContext,
      })
      .onConflict((conflict) =>
        conflict.columns(["tenant_id", "subject_id"]).doUpdateSet({
          registry_capabilities: membership.registryCapabilities,
          roles: membership.roles,
          scopes: membership.scopes,
          updated_at: sql<string>`now()`,
          user_context: membership.userContext,
        }),
      )
      .execute();
  }
}
