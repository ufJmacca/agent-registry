import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sql } from "kysely";
import pg from "pg";

import { createPrincipalResolver } from "../apps/api/src/auth/index.ts";
import { bootstrapFromConfig } from "../apps/api/src/bootstrap/index.ts";
import { loadRegistryConfig } from "../packages/config/src/index.ts";
import {
  KyselyBootstrapRepository,
  createRegistryMigrator,
  createKyselyDb,
  destroyKyselyDb,
  migrateToLatest,
  type AgentRegistryDb,
} from "../packages/db/src/index.ts";

const { Pool } = pg;

const integrationDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://registry:registry@postgres:5432/agent_registry";
const defaultCardProfileId = "a2a-default";
const alternateCardProfileId = "a2a-v1";

interface FreshRegistryDatabase {
  cleanup(): Promise<void>;
  databaseUrl: string;
  db: AgentRegistryDb;
  migrationResults: Awaited<ReturnType<typeof migrateToLatest>>;
}

interface IsolatedRegistryDatabase {
  cleanup(): Promise<void>;
  databaseUrl: string;
  db: AgentRegistryDb;
}

function createIsolatedDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function createFreshRegistryDatabase(): Promise<FreshRegistryDatabase> {
  const databaseName = `agent_registry_test_${randomUUID().replaceAll("-", "_")}`;
  const adminPool = new Pool({
    connectionString: createIsolatedDatabaseUrl(integrationDatabaseUrl, "postgres"),
  });

  await adminPool.query(`create database "${databaseName}" template template0`);

  const databaseUrl = createIsolatedDatabaseUrl(integrationDatabaseUrl, databaseName);
  const db = createKyselyDb(databaseUrl);

  try {
    const migrationResults = await migrateToLatest(db);

    return {
      async cleanup() {
        await destroyKyselyDb(db);
        await adminPool.query(
          "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
          [databaseName],
        );
        await adminPool.query(`drop database if exists "${databaseName}"`);
        await adminPool.end();
      },
      databaseUrl,
      db,
      migrationResults,
    };
  } catch (error) {
    await destroyKyselyDb(db);
    await adminPool.query(`drop database if exists "${databaseName}"`);
    await adminPool.end();
    throw error;
  }
}

function formatMigrationResults(results: Awaited<ReturnType<typeof migrateToLatest>>) {
  return results.map((result) => ({
    migrationName: result.migrationName,
    status: result.status,
  }));
}

const expectedMigrationResults = [
  {
    migrationName: "001_initial_registry_schema",
    status: "Success",
  },
  {
    migrationName: "002_tenant_default_card_profiles",
    status: "Success",
  },
  {
    migrationName: "003_agent_version_profiles_and_sequence_uniqueness",
    status: "Success",
  },
  {
    migrationName: "004_version_review_metadata",
    status: "Success",
  },
  {
    migrationName: "005_publication_telemetry_unique_windows",
    status: "Success",
  },
];

async function listPublicTables(db: AgentRegistryDb): Promise<string[]> {
  const result = await sql<{ table_name: string }>`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
  `.execute(db);

  return result.rows.map((row) => row.table_name).sort();
}

async function createAr03RegistryDatabase(): Promise<IsolatedRegistryDatabase> {
  const databaseName = `agent_registry_test_${randomUUID().replaceAll("-", "_")}`;
  const adminPool = new Pool({
    connectionString: createIsolatedDatabaseUrl(integrationDatabaseUrl, "postgres"),
  });

  await adminPool.query(`create database "${databaseName}" template template0`);

  const databaseUrl = createIsolatedDatabaseUrl(integrationDatabaseUrl, databaseName);
  const db = createKyselyDb(databaseUrl);

  try {
    await sql`
      create table tenants (
        tenant_id text primary key,
        deployment_mode text not null,
        display_name text not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `.execute(db);
    await sql`
      create table agents (
        tenant_id text not null references tenants(tenant_id) on delete cascade,
        agent_id text not null,
        display_name text not null,
        summary text not null,
        disabled boolean not null default false,
        deprecated boolean not null default false,
        active_version_id text,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now(),
        primary key (tenant_id, agent_id)
      )
    `.execute(db);
    await sql`
      create table agent_versions (
        tenant_id text not null,
        agent_id text not null,
        version_id text not null,
        version_sequence integer not null,
        version_label text not null,
        summary text not null,
        capabilities text[] not null default '{}'::text[],
        tags text[] not null default '{}'::text[],
        required_roles text[] not null default '{}'::text[],
        required_scopes text[] not null default '{}'::text[],
        header_contract jsonb not null default '[]'::jsonb,
        context_contract jsonb not null default '[]'::jsonb,
        approval_state text not null,
        submitted_at timestamptz,
        rejected_reason text,
        created_at timestamptz not null default now(),
        primary key (tenant_id, agent_id, version_id),
        constraint agent_versions_agent_fk
          foreign key (tenant_id, agent_id)
          references agents(tenant_id, agent_id)
          on delete cascade
      )
    `.execute(db);
    await sql`
      create index agent_versions_sequence_idx
      on agent_versions (tenant_id, agent_id, version_sequence)
    `.execute(db);
    await sql`
      create table kysely_migration (
        name text primary key,
        timestamp text not null
      )
    `.execute(db);
    await sql`
      insert into kysely_migration (name, timestamp)
      values ('001_initial_registry_schema', ${Date.now().toString()})
    `.execute(db);

    return {
      async cleanup() {
        await destroyKyselyDb(db);
        await adminPool.query(
          "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
          [databaseName],
        );
        await adminPool.query(`drop database if exists "${databaseName}"`);
        await adminPool.end();
      },
      databaseUrl,
      db,
    };
  } catch (error) {
    await destroyKyselyDb(db);
    await adminPool.query(`drop database if exists "${databaseName}"`);
    await adminPool.end();
    throw error;
  }
}

test("loadRegistryConfig loads hosted defaults and bootstrap input", async () => {
  // Arrange
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-registry-config-hosted-"));
  const hostedManifestPath = path.join(tempDir, "hosted-bootstrap.yaml");

  try {
    await writeFile(hostedManifestPath, "tenants: []\n", "utf8");

    // Act
    const config = loadRegistryConfig({
      DATABASE_URL: "postgres://registry:registry@postgres:5432/agent_registry",
      DEPLOYMENT_MODE: "hosted",
      HOSTED_BOOTSTRAP_FILE: hostedManifestPath,
    });

    // Assert
    assert.equal(config.deploymentMode, "hosted");
    assert.equal(config.rawCardByteLimit, 256 * 1024);
    assert.equal(config.bootstrap.hostedManifestFile, hostedManifestPath);
    assert.equal(config.bootstrap.selfHostedBootstrapFile, undefined);
    assert.deepEqual(config.healthProbe, {
      allowPrivateTargets: false,
      degradedThreshold: 1,
      failureWindow: 3,
      intervalSeconds: 60,
      method: "GET",
      requireHttps: true,
      timeoutSeconds: 5,
    });
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test("loadRegistryConfig requires a self-hosted bootstrap file", () => {
  // Arrange
  const env = {
    DATABASE_URL: "postgres://registry:registry@postgres:5432/agent_registry",
    DEPLOYMENT_MODE: "self-hosted",
  };

  // Act / Assert
  assert.throws(
    () => loadRegistryConfig(env),
    /SELF_HOSTED_BOOTSTRAP_FILE/,
  );
});

test("migrateToLatest creates the full registry schema and keeps migrations forward-only", async () => {
  // Arrange
  const database = await createFreshRegistryDatabase();

  try {
    const requiredTables = [
      "agent_versions",
      "agents",
      "environment_publications",
      "publication_health",
      "publication_telemetry",
      "tenant_environments",
      "tenant_memberships",
      "tenant_policy_overlays",
      "tenants",
    ];

    // Act
    await database.db
      .insertInto("tenants")
      .values({
        default_card_profile_id: alternateCardProfileId,
        deployment_mode: "hosted",
        display_name: "Schema Tenant",
        tenant_id: "tenant-schema",
      })
      .execute();
    await database.db
      .insertInto("tenant_environments")
      .values({
        environment_key: "prod",
        tenant_id: "tenant-schema",
      })
      .execute();
    await database.db
      .insertInto("tenant_memberships")
      .values({
        registry_capabilities: ["tenants:read"],
        roles: ["tenant-admin"],
        scopes: ["agents.read"],
        subject_id: "subject-schema",
        tenant_id: "tenant-schema",
        user_context: {
          department: "platform",
        },
      })
      .execute();
    await database.db
      .insertInto("agents")
      .values({
        active_version_id: "version-1",
        agent_id: "agent-schema",
        display_name: "Schema Agent",
        summary: "Proves the full registry schema",
        tenant_id: "tenant-schema",
      })
      .execute();
    await database.db
      .insertInto("agent_versions")
      .values({
        agent_id: "agent-schema",
        approval_state: "approved",
        capabilities: ["search"],
        context_contract: JSON.stringify([
          {
            description: "Required context",
            key: "client_id",
            required: true,
            type: "string",
          },
        ]),
        header_contract: JSON.stringify([
          {
            description: "Pass through the user id",
            name: "X-User-Id",
            required: true,
            source: "user.id",
          },
        ]),
        required_roles: ["support-agent"],
        required_scopes: ["tickets.read"],
        submitted_at: "2026-03-12T00:00:00Z",
        summary: "Approved schema version",
        tags: ["support"],
        tenant_id: "tenant-schema",
        version_id: "version-1",
        version_label: "1.0.0",
        version_sequence: 1,
      })
      .execute();
    await database.db
      .insertInto("environment_publications")
      .values({
        agent_id: "agent-schema",
        environment_key: "prod",
        health_endpoint_url: "https://agent.example.com/health",
        invocation_endpoint: "https://agent.example.com/invoke",
        normalized_metadata: {
          capabilities: ["search"],
          displayName: "Schema Agent",
        },
        publication_id: "publication-1",
        raw_card: JSON.stringify({
          capabilities: ["search"],
          name: "Schema Agent",
        }),
        tenant_id: "tenant-schema",
        version_id: "version-1",
      })
      .execute();
    await database.db
      .insertInto("tenant_policy_overlays")
      .values({
        agent_id: "agent-schema",
        environment_key: "prod",
        required_roles: ["registry-auditor"],
        required_scopes: ["agents.audit"],
        tenant_id: "tenant-schema",
      })
      .execute();
    await database.db
      .insertInto("publication_health")
      .values({
        publication_id: "publication-1",
      })
      .execute();
    await database.db
      .insertInto("publication_telemetry")
      .values({
        error_count: 1,
        invocation_count: 10,
        p50_latency_ms: 120,
        p95_latency_ms: 240,
        publication_id: "publication-1",
        success_count: 9,
        tenant_id: "tenant-schema",
        window_ended_at: "2026-03-12T00:05:00Z",
        window_started_at: "2026-03-12T00:00:00Z",
      })
      .execute();

    const tables = await listPublicTables(database.db);
    const tenant = await database.db
      .selectFrom("tenants")
      .select(["tenant_id", "display_name", "deployment_mode", "default_card_profile_id"])
      .where("tenant_id", "=", "tenant-schema")
      .executeTakeFirstOrThrow();
    const membership = await database.db
      .selectFrom("tenant_memberships")
      .select(["tenant_id", "subject_id", "roles", "scopes", "registry_capabilities", "user_context"])
      .where("tenant_id", "=", "tenant-schema")
      .where("subject_id", "=", "subject-schema")
      .executeTakeFirstOrThrow();
    const agent = await database.db
      .selectFrom("agents")
      .select(["tenant_id", "agent_id", "active_version_id", "disabled", "deprecated"])
      .where("tenant_id", "=", "tenant-schema")
      .where("agent_id", "=", "agent-schema")
      .executeTakeFirstOrThrow();
    const version = await database.db
      .selectFrom("agent_versions")
      .select([
        "tenant_id",
        "agent_id",
        "version_id",
        "version_sequence",
        "approval_state",
        "capabilities",
        "tags",
        "required_roles",
        "required_scopes",
        "header_contract",
        "context_contract",
      ])
      .where("tenant_id", "=", "tenant-schema")
      .where("agent_id", "=", "agent-schema")
      .where("version_id", "=", "version-1")
      .executeTakeFirstOrThrow();
    const publication = await database.db
      .selectFrom("environment_publications")
      .select([
        "publication_id",
        "tenant_id",
        "agent_id",
        "version_id",
        "environment_key",
        "raw_card",
        "invocation_endpoint",
        "normalized_metadata",
        "health_endpoint_url",
      ])
      .where("publication_id", "=", "publication-1")
      .executeTakeFirstOrThrow();
    const overlay = await database.db
      .selectFrom("tenant_policy_overlays")
      .select([
        "tenant_id",
        "agent_id",
        "environment_key",
        "required_roles",
        "required_scopes",
        "disabled",
        "deprecated",
      ])
      .where("tenant_id", "=", "tenant-schema")
      .where("agent_id", "=", "agent-schema")
      .executeTakeFirstOrThrow();
    const health = await database.db
      .selectFrom("publication_health")
      .select([
        "publication_id",
        "health_status",
        "recent_failures",
        "consecutive_failures",
        "last_checked_at",
        "last_success_at",
        "last_error",
      ])
      .where("publication_id", "=", "publication-1")
      .executeTakeFirstOrThrow();
    const telemetry = await database.db
      .selectFrom("publication_telemetry")
      .select([
        "tenant_id",
        "publication_id",
        "invocation_count",
        "success_count",
        "error_count",
        "p50_latency_ms",
        "p95_latency_ms",
      ])
      .where("tenant_id", "=", "tenant-schema")
      .where("publication_id", "=", "publication-1")
      .executeTakeFirstOrThrow();
    const rollbackAttempt = await createRegistryMigrator(database.db).migrateDown();
    const publicationAfterRollbackAttempt = await database.db
      .selectFrom("environment_publications")
      .select(["publication_id", "environment_key"])
      .where("publication_id", "=", "publication-1")
      .executeTakeFirstOrThrow();

    // Assert
    assert.deepEqual(formatMigrationResults(database.migrationResults), expectedMigrationResults);
    assert.deepEqual(tables.filter((tableName) => requiredTables.includes(tableName)), requiredTables);
    assert.deepEqual(tenant, {
      default_card_profile_id: alternateCardProfileId,
      deployment_mode: "hosted",
      display_name: "Schema Tenant",
      tenant_id: "tenant-schema",
    });
    assert.deepEqual(membership, {
      registry_capabilities: ["tenants:read"],
      roles: ["tenant-admin"],
      scopes: ["agents.read"],
      subject_id: "subject-schema",
      tenant_id: "tenant-schema",
      user_context: {
        department: "platform",
      },
    });
    assert.deepEqual(agent, {
      active_version_id: "version-1",
      agent_id: "agent-schema",
      deprecated: false,
      disabled: false,
      tenant_id: "tenant-schema",
    });
    assert.deepEqual(version, {
      agent_id: "agent-schema",
      approval_state: "approved",
      capabilities: ["search"],
      context_contract: [
        {
          description: "Required context",
          key: "client_id",
          required: true,
          type: "string",
        },
      ],
      header_contract: [
        {
          description: "Pass through the user id",
          name: "X-User-Id",
          required: true,
          source: "user.id",
        },
      ],
      required_roles: ["support-agent"],
      required_scopes: ["tickets.read"],
      tags: ["support"],
      tenant_id: "tenant-schema",
      version_id: "version-1",
      version_sequence: 1,
    });
    assert.deepEqual(publication, {
      agent_id: "agent-schema",
      environment_key: "prod",
      health_endpoint_url: "https://agent.example.com/health",
      invocation_endpoint: "https://agent.example.com/invoke",
      normalized_metadata: {
        capabilities: ["search"],
        displayName: "Schema Agent",
      },
      publication_id: "publication-1",
      raw_card: JSON.stringify({
        capabilities: ["search"],
        name: "Schema Agent",
      }),
      tenant_id: "tenant-schema",
      version_id: "version-1",
    });
    assert.deepEqual(overlay, {
      agent_id: "agent-schema",
      deprecated: false,
      disabled: false,
      environment_key: "prod",
      required_roles: ["registry-auditor"],
      required_scopes: ["agents.audit"],
      tenant_id: "tenant-schema",
    });
    assert.deepEqual(health, {
      consecutive_failures: 0,
      health_status: "unknown",
      last_checked_at: null,
      last_error: null,
      last_success_at: null,
      publication_id: "publication-1",
      recent_failures: 0,
    });
    assert.deepEqual(telemetry, {
      error_count: 1,
      invocation_count: 10,
      p50_latency_ms: 120,
      p95_latency_ms: 240,
      publication_id: "publication-1",
      success_count: 9,
      tenant_id: "tenant-schema",
    });
    assert.ok(rollbackAttempt.error instanceof Error);
    assert.match(rollbackAttempt.error.message, /forward-only/);
    assert.deepEqual(
      formatMigrationResults((rollbackAttempt.results ?? []) as Awaited<ReturnType<typeof migrateToLatest>>),
      [
        {
          migrationName: "005_publication_telemetry_unique_windows",
          status: "Error",
        },
      ],
    );
    assert.deepEqual(publicationAfterRollbackAttempt, {
      environment_key: "prod",
      publication_id: "publication-1",
    });
  } finally {
    await database.cleanup();
  }
});

test("migrateToLatest upgrades the AR-03 agent_versions schema for draft registration", async () => {
  // Arrange
  const database = await createAr03RegistryDatabase();

  try {
    await database.db
      .insertInto("tenants")
      .values({
        deployment_mode: "hosted",
        display_name: "Legacy Tenant",
        tenant_id: "tenant-legacy",
      })
      .execute();
    await database.db
      .insertInto("agents")
      .values({
        active_version_id: "version-legacy",
        agent_id: "agent-legacy",
        display_name: "Legacy Agent",
        summary: "Agent created before draft registration",
        tenant_id: "tenant-legacy",
      })
      .execute();
    await database.db
      .insertInto("agent_versions")
      .values({
        agent_id: "agent-legacy",
        approval_state: "approved",
        capabilities: ["search"],
        context_contract: JSON.stringify([]),
        header_contract: JSON.stringify([]),
        required_roles: [],
        required_scopes: [],
        summary: "Legacy schema version",
        tags: ["legacy"],
        tenant_id: "tenant-legacy",
        version_id: "version-legacy",
        version_label: "0.9.0",
        version_sequence: 1,
      })
      .execute();
    const migrationResults = await migrateToLatest(database.db);

    // Act
    const version = await database.db
      .selectFrom("agent_versions")
      .select(["card_profile_id", "display_name", "version_sequence"])
      .where("tenant_id", "=", "tenant-legacy")
      .where("agent_id", "=", "agent-legacy")
      .where("version_id", "=", "version-legacy")
      .executeTakeFirstOrThrow();
    const tenant = await database.db
      .selectFrom("tenants")
      .select(["default_card_profile_id"])
      .where("tenant_id", "=", "tenant-legacy")
      .executeTakeFirstOrThrow();
    const duplicateInsert = database.db
      .insertInto("agent_versions")
      .values({
        agent_id: "agent-legacy",
        approval_state: "draft",
        capabilities: [],
        card_profile_id: defaultCardProfileId,
        context_contract: JSON.stringify([]),
        display_name: "Legacy Agent",
        header_contract: JSON.stringify([]),
        required_roles: [],
        required_scopes: [],
        summary: "Duplicate sequence should fail",
        tags: [],
        tenant_id: "tenant-legacy",
        version_id: "version-duplicate",
        version_label: "0.9.1",
        version_sequence: 1,
      })
      .execute();

    // Assert
    assert.deepEqual(formatMigrationResults(migrationResults), [
      {
        migrationName: "002_tenant_default_card_profiles",
        status: "Success",
      },
      {
        migrationName: "003_agent_version_profiles_and_sequence_uniqueness",
        status: "Success",
      },
      {
        migrationName: "004_version_review_metadata",
        status: "Success",
      },
      {
        migrationName: "005_publication_telemetry_unique_windows",
        status: "Success",
      },
    ]);
    assert.deepEqual(tenant, {
      default_card_profile_id: defaultCardProfileId,
    });
    assert.deepEqual(version, {
      card_profile_id: defaultCardProfileId,
      display_name: "Legacy Agent",
      version_sequence: 1,
    });
    await assert.rejects(duplicateInsert, /agent_versions_sequence_idx/);
  } finally {
    await database.cleanup();
  }
});

test("bootstrapFromConfig migrates and upserts hosted tenants, environments, memberships, and principal resolution", async () => {
  // Arrange
  const database = await createFreshRegistryDatabase();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-registry-bootstrap-hosted-"));
  const initialManifestPath = path.join(tempDir, "hosted-bootstrap.yaml");
  const updatedManifestPath = path.join(tempDir, "hosted-bootstrap-updated.yaml");

  try {
    await writeFile(
      initialManifestPath,
      [
        "tenants:",
        "  - tenantId: tenant-alpha",
        "    displayName: Tenant Alpha",
        `    defaultCardProfileId: ${alternateCardProfileId}`,
        "    environments: [dev, prod]",
        "    memberships:",
        "      - subjectId: user-123",
        "        roles: [tenant-admin]",
        "        scopes: [agents.read]",
        "        registryCapabilities: [bootstrap:write]",
        "        userContext:",
        "          department: support",
        "  - tenantId: tenant-beta",
        "    displayName: Tenant Beta",
        "    environments: [prod]",
        "",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      updatedManifestPath,
      [
        "tenants:",
        "  - tenantId: tenant-alpha",
        "    displayName: Tenant Alpha Updated",
        `    defaultCardProfileId: ${defaultCardProfileId}`,
        "    environments: [prod, staging]",
        "    memberships:",
        "      - subjectId: user-123",
        "        roles: [tenant-operator]",
        "        scopes: [agents.read, agents.write]",
        "        registryCapabilities: [bootstrap:write, tenants:read]",
        "        userContext:",
        "          department: operations",
        "  - tenantId: tenant-beta",
        "    displayName: Tenant Beta",
        "    environments: [dev]",
        "",
      ].join("\n"),
      "utf8",
    );

    const initialConfig = loadRegistryConfig({
      DATABASE_URL: database.databaseUrl,
      DEPLOYMENT_MODE: "hosted",
      HOSTED_BOOTSTRAP_FILE: initialManifestPath,
    });
    const updatedConfig = loadRegistryConfig({
      DATABASE_URL: database.databaseUrl,
      DEPLOYMENT_MODE: "hosted",
      HOSTED_BOOTSTRAP_FILE: updatedManifestPath,
    });
    const repository = new KyselyBootstrapRepository(database.db);

    // Act
    const initialSummary = await bootstrapFromConfig(initialConfig, repository);
    const updatedSummary = await bootstrapFromConfig(updatedConfig, repository);
    const tenants = await database.db
      .selectFrom("tenants")
      .select(["tenant_id", "display_name", "deployment_mode", "default_card_profile_id"])
      .orderBy("tenant_id")
      .execute();
    const environments = await database.db
      .selectFrom("tenant_environments")
      .select(["tenant_id", "environment_key"])
      .orderBy("tenant_id")
      .orderBy("environment_key")
      .execute();
    const memberships = await database.db
      .selectFrom("tenant_memberships")
      .select([
        "tenant_id",
        "subject_id",
        "roles",
        "scopes",
        "registry_capabilities",
        "user_context",
      ])
      .orderBy("tenant_id")
      .orderBy("subject_id")
      .execute();
    const principal = await createPrincipalResolver(database.db).resolve({
      auth: {
        subjectId: "user-123",
        userContext: {
          email: "user-123@example.com",
        },
      },
      tenantId: "tenant-alpha",
    });

    // Assert
    assert.deepEqual(formatMigrationResults(database.migrationResults), expectedMigrationResults);
    assert.deepEqual(initialSummary, {
      membershipCount: 1,
      tenantCount: 2,
    });
    assert.deepEqual(updatedSummary, {
      membershipCount: 1,
      tenantCount: 2,
    });
    assert.deepEqual(tenants, [
      {
        default_card_profile_id: defaultCardProfileId,
        deployment_mode: "hosted",
        display_name: "Tenant Alpha Updated",
        tenant_id: "tenant-alpha",
      },
      {
        default_card_profile_id: defaultCardProfileId,
        deployment_mode: "hosted",
        display_name: "Tenant Beta",
        tenant_id: "tenant-beta",
      },
    ]);
    assert.deepEqual(environments, [
      {
        environment_key: "prod",
        tenant_id: "tenant-alpha",
      },
      {
        environment_key: "staging",
        tenant_id: "tenant-alpha",
      },
      {
        environment_key: "dev",
        tenant_id: "tenant-beta",
      },
    ]);
    assert.deepEqual(memberships, [
      {
        registry_capabilities: ["bootstrap:write", "tenants:read"],
        roles: ["tenant-operator"],
        scopes: ["agents.read", "agents.write"],
        subject_id: "user-123",
        tenant_id: "tenant-alpha",
        user_context: {
          department: "operations",
        },
      },
    ]);
    assert.deepEqual(principal, {
      registryCapabilities: ["bootstrap:write", "tenants:read"],
      roles: ["tenant-operator"],
      scopes: ["agents.read", "agents.write"],
      subjectId: "user-123",
      tenantId: "tenant-alpha",
      userContext: {
        department: "operations",
        email: "user-123@example.com",
      },
    });
  } finally {
    await rm(tempDir, { force: true, recursive: true });
    await database.cleanup();
  }
});

test("bootstrapFromConfig initializes self-hosted mode from SELF_HOSTED_BOOTSTRAP_FILE", async () => {
  // Arrange
  const database = await createFreshRegistryDatabase();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-registry-bootstrap-self-hosted-"));
  const manifestPath = path.join(tempDir, "self-hosted-bootstrap.yaml");

  try {
    await writeFile(
      manifestPath,
      [
        "tenants:",
        "  - tenantId: tenant-self-hosted",
        "    displayName: Self Hosted Tenant",
        "    environments: [dev, prod]",
        "    memberships:",
        "      - subjectId: operator-1",
        "        roles: [tenant-admin]",
        "        scopes: [agents.read]",
        "        registryCapabilities: [bootstrap:write]",
        "        userContext:",
        "          department: platform",
        "",
      ].join("\n"),
      "utf8",
    );
    const config = loadRegistryConfig({
      DATABASE_URL: database.databaseUrl,
      DEPLOYMENT_MODE: "self-hosted",
      SELF_HOSTED_BOOTSTRAP_FILE: manifestPath,
    });
    const repository = new KyselyBootstrapRepository(database.db);

    // Act
    const summary = await bootstrapFromConfig(config, repository);
    const tenants = await database.db
      .selectFrom("tenants")
      .select(["tenant_id", "display_name", "deployment_mode", "default_card_profile_id"])
      .execute();
    const environments = await database.db
      .selectFrom("tenant_environments")
      .select(["tenant_id", "environment_key"])
      .orderBy("environment_key")
      .execute();
    const memberships = await database.db
      .selectFrom("tenant_memberships")
      .select([
        "tenant_id",
        "subject_id",
        "roles",
        "scopes",
        "registry_capabilities",
        "user_context",
      ])
      .execute();

    // Assert
    assert.deepEqual(formatMigrationResults(database.migrationResults), expectedMigrationResults);
    assert.deepEqual(summary, {
      membershipCount: 1,
      tenantCount: 1,
    });
    assert.deepEqual(tenants, [
      {
        default_card_profile_id: defaultCardProfileId,
        deployment_mode: "self-hosted",
        display_name: "Self Hosted Tenant",
        tenant_id: "tenant-self-hosted",
      },
    ]);
    assert.deepEqual(environments, [
      {
        environment_key: "dev",
        tenant_id: "tenant-self-hosted",
      },
      {
        environment_key: "prod",
        tenant_id: "tenant-self-hosted",
      },
    ]);
    assert.deepEqual(memberships, [
      {
        registry_capabilities: ["bootstrap:write"],
        roles: ["tenant-admin"],
        scopes: ["agents.read"],
        subject_id: "operator-1",
        tenant_id: "tenant-self-hosted",
        user_context: {
          department: "platform",
        },
      },
    ]);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
    await database.cleanup();
  }
});

test("bootstrapFromConfig rejects multi-tenant manifests in self-hosted mode without persisting data", async () => {
  // Arrange
  const database = await createFreshRegistryDatabase();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-registry-bootstrap-reject-"));
  const manifestPath = path.join(tempDir, "self-hosted-bootstrap.yaml");

  try {
    await writeFile(
      manifestPath,
      [
        "tenants:",
        "  - tenantId: tenant-alpha",
        "    displayName: Tenant Alpha",
        "    environments: [dev]",
        "  - tenantId: tenant-beta",
        "    displayName: Tenant Beta",
        "    environments: [prod]",
        "",
      ].join("\n"),
      "utf8",
    );
    const config = loadRegistryConfig({
      DATABASE_URL: database.databaseUrl,
      DEPLOYMENT_MODE: "self-hosted",
      SELF_HOSTED_BOOTSTRAP_FILE: manifestPath,
    });
    const repository = new KyselyBootstrapRepository(database.db);

    // Act
    await assert.rejects(
      () => bootstrapFromConfig(config, repository),
      /self-hosted mode supports exactly one tenant/,
    );
    const tenants = await database.db.selectFrom("tenants").select("tenant_id").execute();
    const environments = await database.db
      .selectFrom("tenant_environments")
      .select("environment_key")
      .execute();
    const memberships = await database.db
      .selectFrom("tenant_memberships")
      .select("subject_id")
      .execute();

    // Assert
    assert.deepEqual(formatMigrationResults(database.migrationResults), expectedMigrationResults);
    assert.deepEqual(tenants, []);
    assert.deepEqual(environments, []);
    assert.deepEqual(memberships, []);
  } finally {
    await rm(tempDir, { force: true, recursive: true });
    await database.cleanup();
  }
});
