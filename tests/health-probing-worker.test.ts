import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import { bootstrapFromConfig } from "../apps/api/src/bootstrap/index.ts";
import {
  HEALTH_PROBE_JOB_NAME,
  HEALTH_PROBE_RECONCILE_JOB_NAME,
  HealthProbeWorker,
  probeHealthEndpoint,
} from "../apps/worker/src/health-probe-worker.ts";
import {
  assertHealthProbeTargetAllowed,
  reducePublicationHealth,
} from "../packages/config/src/index.ts";
import {
  KyselyBootstrapRepository,
  KyselyHealthRepository,
  createKyselyDb,
  destroyKyselyDb,
  migrateToLatest,
  type AgentRegistryDb,
} from "../packages/db/src/index.ts";

const { Pool } = pg;

const integrationDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://registry:registry@postgres:5432/agent_registry";

interface FreshRegistryDatabase {
  cleanup(): Promise<void>;
  databaseUrl: string;
  db: AgentRegistryDb;
}

interface ProbeWorkerContext extends FreshRegistryDatabase {
  close(): Promise<void>;
}

interface ScheduledCall {
  cron: string;
  data: Record<string, unknown> | undefined;
  name: string;
}

interface SentCall {
  data: Record<string, unknown> | undefined;
  name: string;
}

class FakeBoss {
  readonly scheduledCalls: ScheduledCall[] = [];

  readonly sentCalls: SentCall[] = [];

  readonly workers = new Map<string, (payload?: Record<string, unknown>) => Promise<void>>();

  async schedule(
    name: string,
    cron: string,
    data?: Record<string, unknown>,
  ): Promise<string> {
    this.scheduledCalls.push({ cron, data, name });
    return `${name}-schedule`;
  }

  async send(name: string, data?: Record<string, unknown>): Promise<string> {
    this.sentCalls.push({ data, name });
    return `${name}-${this.sentCalls.length}`;
  }

  work(
    name: string,
    handler: (payload?: Record<string, unknown>) => Promise<void>,
  ): string {
    this.workers.set(name, handler);
    return `${name}-worker`;
  }
}

function getRegisteredWorker(
  boss: FakeBoss,
  name: string,
): (jobs?: Array<{ data: Record<string, unknown> }> | Record<string, unknown>) => Promise<void> {
  const worker = boss.workers.get(name);

  assert.notEqual(worker, undefined);

  return worker;
}

function asIsoString(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }

  return new Date(value).toISOString();
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
    await migrateToLatest(db);

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

async function createProbeWorkerContext(): Promise<ProbeWorkerContext> {
  const database = await createFreshRegistryDatabase();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-registry-health-worker-"));
  const bootstrapPath = path.join(tempDir, "bootstrap.yaml");

  try {
    await writeFile(
      bootstrapPath,
      [
        "tenants:",
        "  - tenantId: tenant-alpha",
        "    displayName: Tenant Alpha",
        "    environments: [dev, prod]",
        "    memberships:",
        "      - subjectId: admin-alpha",
        "        roles: [tenant-admin]",
        "",
      ].join("\n"),
      "utf8",
    );

    await bootstrapFromConfig(
      {
        bootstrap: {
          hostedManifestFile: bootstrapPath,
          selfHostedBootstrapFile: undefined,
        },
        databaseUrl: database.databaseUrl,
        deploymentMode: "hosted",
        healthProbe: {
          allowPrivateTargets: false,
          degradedThreshold: 1,
          failureWindow: 3,
          intervalSeconds: 60,
          method: "GET",
          requireHttps: true,
          timeoutSeconds: 5,
        },
        rawCardByteLimit: 256 * 1024,
      },
      new KyselyBootstrapRepository(database.db),
    );

    return {
      ...database,
      async close() {
        await rm(tempDir, { force: true, recursive: true });
        await database.cleanup();
      },
    };
  } catch (error) {
    await rm(tempDir, { force: true, recursive: true });
    await database.cleanup();
    throw error;
  }
}

async function seedApprovedPublication(
  db: AgentRegistryDb,
  input: {
    active: boolean;
    agentId: string;
    disabledAgent?: boolean;
    disabledEnvironment?: boolean;
    environmentKey: string;
    healthEndpointUrl?: string;
    invocationEndpoint?: string;
    publicationId: string;
    tenantId: string;
    versionId: string;
    versionSequence: number;
  },
): Promise<void> {
  await db
    .insertInto("agents")
    .values({
      active_version_id: input.active ? input.versionId : null,
      agent_id: input.agentId,
      display_name: `${input.agentId} display`,
      summary: `${input.agentId} summary`,
      tenant_id: input.tenantId,
    })
    .execute();

  await db
    .insertInto("agent_versions")
    .values({
      agent_id: input.agentId,
      approval_state: "approved",
      capabilities: ["search"],
      card_profile_id: "a2a-default",
      context_contract: [],
      display_name: `${input.agentId} display`,
      header_contract: [],
      required_roles: [],
      required_scopes: [],
      summary: `${input.agentId} summary`,
      tags: ["health"],
      tenant_id: input.tenantId,
      version_id: input.versionId,
      version_label: input.versionId,
      version_sequence: input.versionSequence,
    })
    .execute();

  await db
    .insertInto("environment_publications")
    .values({
      agent_id: input.agentId,
      environment_key: input.environmentKey,
      health_endpoint_url:
        input.healthEndpointUrl ?? `https://${input.publicationId}.example.com/health`,
      invocation_endpoint:
        input.invocationEndpoint ?? `https://${input.publicationId}.example.com/invoke`,
      normalized_metadata: {
        displayName: `${input.agentId} display`,
      },
      publication_id: input.publicationId,
      raw_card: JSON.stringify({
        name: `${input.agentId} display`,
      }),
      tenant_id: input.tenantId,
      version_id: input.versionId,
    })
    .execute();

  await db
    .insertInto("publication_health")
    .values({
      publication_id: input.publicationId,
    })
    .execute();

  if (input.disabledAgent) {
    await db
      .insertInto("tenant_policy_overlays")
      .values({
        agent_id: input.agentId,
        disabled: true,
        environment_key: null,
        required_roles: [],
        required_scopes: [],
        tenant_id: input.tenantId,
      })
      .execute();
  }

  if (input.disabledEnvironment) {
    await db
      .insertInto("tenant_policy_overlays")
      .values({
        agent_id: input.agentId,
        disabled: true,
        environment_key: input.environmentKey,
        required_roles: [],
        required_scopes: [],
        tenant_id: input.tenantId,
      })
      .execute();
  }
}

test("assertHealthProbeTargetAllowed blocks hosted private targets but allows self-hosted opt-in", async () => {
  // Arrange
  const resolveProbeHostname = async (hostname: string): Promise<string[]> => {
    if (hostname === "loopback-probe.example.test") {
      return ["127.0.0.1"];
    }

    return [];
  };

  // Act / Assert
  await assert.rejects(
    () =>
      assertHealthProbeTargetAllowed("https://loopback-probe.example.test/health", {
        allowPrivateTargets: false,
        deploymentMode: "hosted",
        requireHttps: true,
        resolveProbeHostname,
      }),
    /Hosted deployments cannot probe private or loopback health endpoints\./,
  );

  await assert.doesNotReject(() =>
    assertHealthProbeTargetAllowed("https://loopback-probe.example.test/health", {
      allowPrivateTargets: true,
      deploymentMode: "self-hosted",
      requireHttps: false,
      resolveProbeHostname,
    }),
  );
});

test("reducePublicationHealth derives unknown, degraded, healthy, and unreachable from the last three checks", () => {
  // Arrange
  const now = "2026-03-13T00:00:00.000Z";

  // Act
  const unknown = reducePublicationHealth([]);
  const degraded = reducePublicationHealth([
    {
      checkedAt: now,
      error: "timeout",
      ok: false,
      statusCode: null,
    },
    {
      checkedAt: "2026-03-12T23:59:00.000Z",
      error: null,
      ok: true,
      statusCode: 204,
    },
  ]);
  const healthy = reducePublicationHealth([
    {
      checkedAt: now,
      error: null,
      ok: true,
      statusCode: 204,
    },
  ]);
  const unreachable = reducePublicationHealth([
    {
      checkedAt: now,
      error: "timeout",
      ok: false,
      statusCode: null,
    },
    {
      checkedAt: "2026-03-12T23:59:00.000Z",
      error: "timeout",
      ok: false,
      statusCode: null,
    },
    {
      checkedAt: "2026-03-12T23:58:00.000Z",
      error: "503",
      ok: false,
      statusCode: 503,
    },
  ]);

  // Assert
  assert.equal(unknown.healthStatus, "unknown");
  assert.equal(unknown.recentFailures, 0);
  assert.equal(unknown.consecutiveFailures, 0);
  assert.equal(degraded.healthStatus, "degraded");
  assert.equal(degraded.recentFailures, 1);
  assert.equal(degraded.consecutiveFailures, 1);
  assert.equal(healthy.healthStatus, "healthy");
  assert.equal(healthy.recentFailures, 0);
  assert.equal(healthy.consecutiveFailures, 0);
  assert.equal(unreachable.healthStatus, "unreachable");
  assert.equal(unreachable.recentFailures, 3);
  assert.equal(unreachable.consecutiveFailures, 3);
});

test("health probe worker schedules recurring reconciliation and immediately enqueues every approved publication, including inactive and disabled ones", async () => {
  // Arrange
  const context = await createProbeWorkerContext();
  const boss = new FakeBoss();

  try {
    await seedApprovedPublication(context.db, {
      active: true,
      agentId: "agent-active",
      environmentKey: "dev",
      publicationId: "publication-active",
      tenantId: "tenant-alpha",
      versionId: "version-active",
      versionSequence: 2,
    });
    await seedApprovedPublication(context.db, {
      active: false,
      agentId: "agent-inactive",
      environmentKey: "prod",
      publicationId: "publication-inactive",
      tenantId: "tenant-alpha",
      versionId: "version-inactive",
      versionSequence: 1,
    });
    await seedApprovedPublication(context.db, {
      active: true,
      agentId: "agent-disabled",
      disabledAgent: true,
      disabledEnvironment: true,
      environmentKey: "prod",
      publicationId: "publication-disabled",
      tenantId: "tenant-alpha",
      versionId: "version-disabled",
      versionSequence: 4,
    });
    await context.db
      .insertInto("agents")
      .values({
        active_version_id: null,
        agent_id: "agent-pending",
        display_name: "Pending agent",
        summary: "Pending summary",
        tenant_id: "tenant-alpha",
      })
      .execute();
    await context.db
      .insertInto("agent_versions")
      .values({
        agent_id: "agent-pending",
        approval_state: "pending_review",
        capabilities: ["search"],
        card_profile_id: "a2a-default",
        context_contract: [],
        display_name: "Pending agent",
        header_contract: [],
        required_roles: [],
        required_scopes: [],
        summary: "Pending summary",
        tags: ["health"],
        tenant_id: "tenant-alpha",
        version_id: "version-pending",
        version_label: "version-pending",
        version_sequence: 1,
      })
      .execute();
    await context.db
      .insertInto("environment_publications")
      .values({
        agent_id: "agent-pending",
        environment_key: "dev",
        health_endpoint_url: "https://pending.example.com/health",
        invocation_endpoint: "https://pending.example.com/invoke",
        normalized_metadata: {},
        publication_id: "publication-pending",
        raw_card: "{\"name\":\"Pending\"}",
        tenant_id: "tenant-alpha",
        version_id: "version-pending",
      })
      .execute();

    const worker = new HealthProbeWorker(
      {
        allowPrivateTargets: false,
        degradedThreshold: 1,
        failureWindow: 3,
        intervalSeconds: 60,
        method: "GET",
        requireHttps: true,
        timeoutSeconds: 5,
      },
      boss,
      new KyselyHealthRepository(context.db),
    );

    // Act
    await worker.start();

    // Assert
    assert.deepEqual(boss.scheduledCalls, [
      {
        cron: "* * * * *",
        data: undefined,
        name: HEALTH_PROBE_RECONCILE_JOB_NAME,
      },
    ]);
    assert.deepEqual(
      boss.sentCalls.map((call) => ({
        name: call.name,
        publicationId: call.data?.publicationId,
      })),
      [
        {
          name: HEALTH_PROBE_JOB_NAME,
          publicationId: "publication-active",
        },
        {
          name: HEALTH_PROBE_JOB_NAME,
          publicationId: "publication-disabled",
        },
        {
          name: HEALTH_PROBE_JOB_NAME,
          publicationId: "publication-inactive",
        },
      ],
    );
    assert.equal(typeof boss.workers.get(HEALTH_PROBE_JOB_NAME), "function");
    assert.equal(typeof boss.workers.get(HEALTH_PROBE_RECONCILE_JOB_NAME), "function");
  } finally {
    await context.close();
  }
});

test("registered reconcile and probe handlers re-enqueue approved publications, revalidate targets per probe, and persist health state", async () => {
  // Arrange
  const context = await createProbeWorkerContext();
  const boss = new FakeBoss();
  const fetchCalls: Array<{
    method: string | undefined;
    url: string;
  }> = [];
  const resolveProbeHostname = async (hostname: string): Promise<string[]> => {
    if (hostname === "loopback-probe.example.test") {
      return ["127.0.0.1"];
    }

    return [];
  };
  const fetchImpl: typeof fetch = async (input, init) => {
    fetchCalls.push({
      method: init?.method,
      url: input instanceof Request ? input.url : input.toString(),
    });

    return new Response(null, {
      status: 204,
    });
  };

  try {
    await seedApprovedPublication(context.db, {
      active: true,
      agentId: "agent-active",
      environmentKey: "dev",
      publicationId: "publication-active",
      tenantId: "tenant-alpha",
      versionId: "version-active",
      versionSequence: 2,
    });
    await seedApprovedPublication(context.db, {
      active: false,
      agentId: "agent-inactive",
      environmentKey: "prod",
      publicationId: "publication-inactive",
      tenantId: "tenant-alpha",
      versionId: "version-inactive",
      versionSequence: 1,
    });
    await seedApprovedPublication(context.db, {
      active: true,
      agentId: "agent-disabled",
      disabledAgent: true,
      disabledEnvironment: true,
      environmentKey: "prod",
      publicationId: "publication-disabled",
      tenantId: "tenant-alpha",
      versionId: "version-disabled",
      versionSequence: 4,
    });

    const worker = new HealthProbeWorker(
      {
        allowPrivateTargets: false,
        degradedThreshold: 1,
        failureWindow: 3,
        intervalSeconds: 60,
        method: "GET",
        requireHttps: true,
        timeoutSeconds: 5,
      },
      boss,
      new KyselyHealthRepository(context.db),
      {
        deploymentMode: "hosted",
        fetchImpl,
        resolveProbeHostname,
      },
    );

    await worker.start();
    boss.sentCalls.length = 0;

    await context.db
      .updateTable("environment_publications")
      .set({
        health_endpoint_url: "https://loopback-probe.example.test/health",
      })
      .where("publication_id", "=", "publication-disabled")
      .execute();

    // Act
    await getRegisteredWorker(boss, HEALTH_PROBE_RECONCILE_JOB_NAME)();
    await getRegisteredWorker(boss, HEALTH_PROBE_JOB_NAME)([
      {
        data: {
          publicationId: "publication-active",
        },
      },
      {
        data: {
          publicationId: "publication-disabled",
        },
      },
    ]);

    const probeHistory = await context.db
      .selectFrom("publication_probe_history")
      .select(["checked_at", "error", "ok", "publication_id", "status_code"])
      .where("publication_id", "in", ["publication-active", "publication-disabled"])
      .orderBy("publication_id")
      .execute();
    const publicationHealth = await context.db
      .selectFrom("publication_health")
      .select([
        "consecutive_failures",
        "health_status",
        "last_checked_at",
        "last_error",
        "last_success_at",
        "publication_id",
        "recent_failures",
      ])
      .where("publication_id", "in", ["publication-active", "publication-disabled"])
      .orderBy("publication_id")
      .execute();

    // Assert
    assert.deepEqual(
      boss.sentCalls.map((call) => ({
        name: call.name,
        publicationId: call.data?.publicationId,
      })),
      [
        {
          name: HEALTH_PROBE_JOB_NAME,
          publicationId: "publication-active",
        },
        {
          name: HEALTH_PROBE_JOB_NAME,
          publicationId: "publication-disabled",
        },
        {
          name: HEALTH_PROBE_JOB_NAME,
          publicationId: "publication-inactive",
        },
      ],
    );
    assert.deepEqual(fetchCalls, [
      {
        method: "GET",
        url: "https://publication-active.example.com/health",
      },
    ]);
    assert.deepEqual(
      probeHistory.map((row) => ({
        error: row.error,
        ok: row.ok,
        publicationId: row.publication_id,
        statusCode: row.status_code,
      })),
      [
        {
          error: null,
          ok: true,
          publicationId: "publication-active",
          statusCode: 204,
        },
        {
          error: "Hosted deployments cannot probe private or loopback health endpoints.",
          ok: false,
          publicationId: "publication-disabled",
          statusCode: null,
        },
      ],
    );

    const activeHistory = probeHistory.find((row) => row.publication_id === "publication-active");
    const activeHealth = publicationHealth.find(
      (row) => row.publication_id === "publication-active",
    );
    const disabledHistory = probeHistory.find(
      (row) => row.publication_id === "publication-disabled",
    );
    const disabledHealth = publicationHealth.find(
      (row) => row.publication_id === "publication-disabled",
    );

    assert.notEqual(activeHistory, undefined);
    assert.notEqual(activeHealth, undefined);
    assert.equal(activeHealth.health_status, "healthy");
    assert.equal(activeHealth.consecutive_failures, 0);
    assert.equal(activeHealth.recent_failures, 0);
    assert.equal(activeHealth.last_error, null);
    assert.equal(asIsoString(activeHealth.last_checked_at), asIsoString(activeHistory.checked_at));
    assert.equal(asIsoString(activeHealth.last_success_at), asIsoString(activeHistory.checked_at));

    assert.notEqual(disabledHistory, undefined);
    assert.notEqual(disabledHealth, undefined);
    assert.equal(disabledHealth.health_status, "degraded");
    assert.equal(disabledHealth.consecutive_failures, 1);
    assert.equal(disabledHealth.recent_failures, 1);
    assert.equal(
      disabledHealth.last_error,
      "Hosted deployments cannot probe private or loopback health endpoints.",
    );
    assert.equal(
      asIsoString(disabledHealth.last_checked_at),
      asIsoString(disabledHistory.checked_at),
    );
    assert.equal(disabledHealth.last_success_at, null);
  } finally {
    await context.close();
  }
});

test("probe handler rejects seeded hosted non-HTTPS probe targets before transport execution", async () => {
  // Arrange
  const context = await createProbeWorkerContext();
  const boss = new FakeBoss();
  const fetchCalls: Array<{
    method: string | undefined;
    url: string;
  }> = [];
  const healthEndpointUrl = "http://public-probe.example.test/health";

  try {
    await seedApprovedPublication(context.db, {
      active: true,
      agentId: "agent-http-policy",
      environmentKey: "dev",
      healthEndpointUrl,
      invocationEndpoint: "https://public-probe.example.test/invoke",
      publicationId: "publication-http-policy",
      tenantId: "tenant-alpha",
      versionId: "version-http-policy",
      versionSequence: 1,
    });

    const worker = new HealthProbeWorker(
      {
        allowPrivateTargets: false,
        degradedThreshold: 1,
        failureWindow: 3,
        intervalSeconds: 60,
        method: "GET",
        requireHttps: true,
        timeoutSeconds: 5,
      },
      boss,
      new KyselyHealthRepository(context.db),
      {
        deploymentMode: "hosted",
        fetchImpl: async (input, init) => {
          fetchCalls.push({
            method: init?.method,
            url: input instanceof Request ? input.url : input.toString(),
          });

          return new Response(null, {
            status: 204,
          });
        },
      },
    );

    await worker.start();
    boss.sentCalls.length = 0;

    // Act
    await getRegisteredWorker(boss, HEALTH_PROBE_JOB_NAME)({
      publicationId: "publication-http-policy",
    });
    const probeHistory = await context.db
      .selectFrom("publication_probe_history")
      .select(["checked_at", "error", "ok", "status_code"])
      .where("publication_id", "=", "publication-http-policy")
      .execute();
    const publicationHealth = await context.db
      .selectFrom("publication_health")
      .select([
        "consecutive_failures",
        "health_status",
        "last_checked_at",
        "last_error",
        "last_success_at",
        "recent_failures",
      ])
      .where("publication_id", "=", "publication-http-policy")
      .executeTakeFirstOrThrow();

    // Assert
    assert.deepEqual(fetchCalls, []);
    assert.deepEqual(
      probeHistory.map((row) => ({
        error: row.error,
        ok: row.ok,
        statusCode: row.status_code,
      })),
      [
        {
          error: `Hosted deployments require HTTPS health endpoints; received '${healthEndpointUrl}'.`,
          ok: false,
          statusCode: null,
        },
      ],
    );
    assert.equal(publicationHealth.health_status, "degraded");
    assert.equal(publicationHealth.consecutive_failures, 1);
    assert.equal(publicationHealth.recent_failures, 1);
    assert.equal(
      publicationHealth.last_error,
      `Hosted deployments require HTTPS health endpoints; received '${healthEndpointUrl}'.`,
    );
    assert.equal(
      asIsoString(publicationHealth.last_checked_at),
      asIsoString(probeHistory[0]?.checked_at ?? null),
    );
    assert.equal(publicationHealth.last_success_at, null);
  } finally {
    await context.close();
  }
});

test("probe handler allows self-hosted private targets when opt-in is enabled and persists probe state", async () => {
  // Arrange
  const context = await createProbeWorkerContext();
  const boss = new FakeBoss();
  const fetchCalls: Array<{
    method: string | undefined;
    url: string;
  }> = [];
  const healthEndpointUrl = "https://loopback-probe.example.test/health";
  const resolveProbeHostname = async (hostname: string): Promise<string[]> => {
    if (hostname === "loopback-probe.example.test") {
      return ["127.0.0.1"];
    }

    return [];
  };

  try {
    await seedApprovedPublication(context.db, {
      active: true,
      agentId: "agent-self-hosted-private",
      environmentKey: "dev",
      healthEndpointUrl,
      invocationEndpoint: "https://loopback-probe.example.test/invoke",
      publicationId: "publication-self-hosted-private",
      tenantId: "tenant-alpha",
      versionId: "version-self-hosted-private",
      versionSequence: 1,
    });

    const worker = new HealthProbeWorker(
      {
        allowPrivateTargets: true,
        degradedThreshold: 1,
        failureWindow: 3,
        intervalSeconds: 60,
        method: "GET",
        requireHttps: true,
        timeoutSeconds: 5,
      },
      boss,
      new KyselyHealthRepository(context.db),
      {
        deploymentMode: "self-hosted",
        fetchImpl: async (input, init) => {
          fetchCalls.push({
            method: init?.method,
            url: input instanceof Request ? input.url : input.toString(),
          });

          return new Response(null, {
            status: 204,
          });
        },
        resolveProbeHostname,
      },
    );

    await worker.start();
    boss.sentCalls.length = 0;

    // Act
    await getRegisteredWorker(boss, HEALTH_PROBE_JOB_NAME)({
      publicationId: "publication-self-hosted-private",
    });
    const probeHistory = await context.db
      .selectFrom("publication_probe_history")
      .select(["checked_at", "error", "ok", "status_code"])
      .where("publication_id", "=", "publication-self-hosted-private")
      .execute();
    const publicationHealth = await context.db
      .selectFrom("publication_health")
      .select([
        "consecutive_failures",
        "health_status",
        "last_checked_at",
        "last_error",
        "last_success_at",
        "recent_failures",
      ])
      .where("publication_id", "=", "publication-self-hosted-private")
      .executeTakeFirstOrThrow();

    // Assert
    assert.deepEqual(fetchCalls, [
      {
        method: "GET",
        url: healthEndpointUrl,
      },
    ]);
    assert.deepEqual(
      probeHistory.map((row) => ({
        error: row.error,
        ok: row.ok,
        statusCode: row.status_code,
      })),
      [
        {
          error: null,
          ok: true,
          statusCode: 204,
        },
      ],
    );
    assert.equal(publicationHealth.health_status, "healthy");
    assert.equal(publicationHealth.consecutive_failures, 0);
    assert.equal(publicationHealth.recent_failures, 0);
    assert.equal(publicationHealth.last_error, null);
    assert.equal(
      asIsoString(publicationHealth.last_checked_at),
      asIsoString(probeHistory[0]?.checked_at ?? null),
    );
    assert.equal(
      asIsoString(publicationHealth.last_success_at),
      asIsoString(probeHistory[0]?.checked_at ?? null),
    );
  } finally {
    await context.close();
  }
});

test("probeHealthEndpoint uses anonymous GET requests and does not follow redirects", async () => {
  // Arrange
  let redirectTargetSeen = false;
  let observedHeaders: http.IncomingHttpHeaders | undefined;
  let observedMethod: string | undefined;
  const server = http.createServer((request, response) => {
    if (request.url === "/redirect") {
      observedHeaders = request.headers;
      observedMethod = request.method;
      response.writeHead(302, {
        location: "/target",
      });
      response.end();
      return;
    }

    if (request.url === "/target") {
      redirectTargetSeen = true;
      response.writeHead(200);
      response.end("ok");
      return;
    }

    response.writeHead(404);
    response.end();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Expected an IPv4 server address for the probe transport test.");
  }

  try {
    // Act
    const result = await probeHealthEndpoint(`http://127.0.0.1:${address.port}/redirect`, {
      timeoutSeconds: 5,
    });

    // Assert
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 302);
    assert.equal(redirectTargetSeen, false);
    assert.equal(observedMethod, "GET");
    assert.equal(observedHeaders?.authorization, undefined);
    assert.equal(observedHeaders?.cookie, undefined);
    assert.equal(observedHeaders?.["x-agent-registry-tenant-id"], undefined);
    assert.equal(observedHeaders?.["x-user-id"], undefined);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
});

test("probeHealthEndpoint aborts after the configured 5 second timeout", async () => {
  // Arrange
  let observedHeaders: http.IncomingHttpHeaders | undefined;
  let observedMethod: string | undefined;
  let resolveRequestSeen: (() => void) | undefined;
  let resolveSocketClosed: (() => void) | undefined;
  const requestSeen = new Promise<void>((resolve) => {
    resolveRequestSeen = resolve;
  });
  const socketClosed = new Promise<void>((resolve) => {
    resolveSocketClosed = resolve;
  });
  const server = http.createServer((request, _response) => {
    if (request.url !== "/hang") {
      return;
    }

    observedHeaders = request.headers;
    observedMethod = request.method;
    request.socket.once("close", () => resolveSocketClosed?.());
    resolveRequestSeen?.();
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Expected an IPv4 server address for the probe timeout test.");
  }

  const startedAt = Date.now();

  try {
    // Act
    const resultPromise = probeHealthEndpoint(`http://127.0.0.1:${address.port}/hang`, {
      timeoutSeconds: 5,
    });
    await requestSeen;
    const result = await resultPromise;
    const elapsedMs = Date.now() - startedAt;
    await socketClosed;

    // Assert
    assert.equal(observedMethod, "GET");
    assert.equal(observedHeaders?.authorization, undefined);
    assert.equal(observedHeaders?.cookie, undefined);
    assert.equal(observedHeaders?.["x-agent-registry-tenant-id"], undefined);
    assert.equal(observedHeaders?.["x-user-id"], undefined);
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, null);
    assert.match(result.error ?? "", /abort|timeout/i);
    assert.ok(
      elapsedMs >= 4_900,
      `Expected the probe timeout to wait about 5 seconds, received ${elapsedMs}ms.`,
    );
    assert.ok(
      elapsedMs < 7_000,
      `Expected the probe timeout to finish shortly after 5 seconds, received ${elapsedMs}ms.`,
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  }
});
