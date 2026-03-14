import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import { bootstrapFromConfig } from "../apps/api/src/bootstrap/index.ts";
import { createApiRequestListener } from "../apps/api/src/http.ts";
import { loadRegistryConfig } from "../packages/config/src/index.ts";
import {
  KyselyBootstrapRepository,
  createKyselyDb,
  destroyKyselyDb,
  type HealthStatus,
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

interface ApiTestContext extends FreshRegistryDatabase {
  baseUrl: string;
  close(): Promise<void>;
}

interface JsonRequestOptions {
  body?: unknown;
  method?: "GET" | "POST";
  path: string;
  subjectId: string;
}

interface JsonResponse<TBody> {
  body: TBody;
  status: number;
}

interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
  };
}

interface DraftAgentRegistrationResponse {
  agentId: string;
  approvalState: string;
  publications: Array<{
    environmentKey: string;
    publicationId: string;
  }>;
  versionId: string;
  versionSequence: number;
}

interface VersionLifecycleResponse {
  activeVersionId: string | null;
  agentId: string;
  approvalState: "approved" | "pending_review" | "rejected";
  versionId: string;
}

interface PublicationTelemetrySummary {
  errorCount: number;
  invocationCount: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  recordedAt: string;
  successCount: number;
  windowEndedAt: string;
  windowStartedAt: string;
}

interface UpsertTelemetryResponse {
  telemetry: PublicationTelemetrySummary;
}

interface AgentAdminDetailResponse {
  activeVersion: {
    approvalState: string;
    publications: Array<{
      environmentKey: string;
      healthEndpointUrl: string;
      healthStatus: string | null;
      publicationId: string;
      telemetry: PublicationTelemetrySummary[];
    }>;
    versionId: string;
    versionSequence: number;
  } | null;
  activeVersionId: string | null;
  agentId: string;
}

interface VersionAdminDetailResponse {
  active: boolean;
  agentId: string;
  approvalState: string;
  publications: Array<{
    environmentKey: string;
    healthEndpointUrl: string;
    healthStatus: string | null;
    invocationEndpoint: string | null;
    normalizedMetadata: unknown;
    publicationId: string;
    rawCard: string;
    telemetry: PublicationTelemetrySummary[];
  }>;
  versionId: string;
}

interface DraftPublicationRequest {
  environmentKey: string;
  healthEndpointUrl: string;
  rawCard: string;
}

interface DraftRegistrationRequest {
  capabilities: string[];
  contextContract: Array<{
    description: string;
    example: string;
    key: string;
    required: boolean;
    type: "string";
  }>;
  displayName: string;
  headerContract: Array<{
    description: string;
    name: string;
    required: boolean;
    source: string;
  }>;
  publications: DraftPublicationRequest[];
  requiredRoles: string[];
  requiredScopes: string[];
  summary: string;
  tags: string[];
  versionLabel: string;
}

interface UpsertTelemetryRequest {
  errorCount: number;
  invocationCount: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  successCount: number;
  windowEndedAt: string;
  windowStartedAt: string;
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

async function createTelemetryApiContext(): Promise<ApiTestContext> {
  const database = await createFreshRegistryDatabase();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-registry-telemetry-api-"));
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
        "      - subjectId: publisher-alpha",
        "        roles: [publisher]",
        "      - subjectId: caller-alpha",
        "        roles: [support-agent]",
        "  - tenantId: tenant-beta",
        "    displayName: Tenant Beta",
        "    environments: [dev, prod]",
        "    memberships:",
        "      - subjectId: admin-beta",
        "        roles: [tenant-admin]",
        "      - subjectId: publisher-beta",
        "        roles: [publisher]",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = loadRegistryConfig({
      DATABASE_URL: database.databaseUrl,
      DEPLOYMENT_MODE: "hosted",
      HOSTED_BOOTSTRAP_FILE: bootstrapPath,
    });

    await bootstrapFromConfig(config, new KyselyBootstrapRepository(database.db));

    const server = http.createServer(
      createApiRequestListener({
        config,
        db: database.db,
      }),
    );

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve());
    });

    const address = server.address();

    if (address === null || typeof address === "string") {
      throw new Error("Expected an IPv4 test server address");
    }

    return {
      ...database,
      baseUrl: `http://127.0.0.1:${address.port}`,
      async close() {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        });
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

async function requestJson<TBody>(
  context: ApiTestContext,
  options: JsonRequestOptions,
): Promise<JsonResponse<TBody>> {
  const headers = new Headers({
    "x-agent-registry-subject-id": options.subjectId,
  });

  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(new URL(options.path, context.baseUrl), {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method: options.method ?? "POST",
  });
  const bodyText = await response.text();
  const body = bodyText === "" ? null : (JSON.parse(bodyText) as TBody);

  return {
    body: body as TBody,
    status: response.status,
  };
}

function createRawCard(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify(
    {
      capabilities: ["card-search"],
      invocationEndpoint: "https://agent.example.com/invoke",
      name: "Telemetry Relay",
      summary: "Relays advisory metrics to the registry.",
      tags: ["telemetry"],
      ...overrides,
    },
    null,
    2,
  );
}

function createDraftRegistrationRequest(
  overrides: Partial<DraftRegistrationRequest> = {},
): DraftRegistrationRequest {
  return {
    capabilities: ["shared-capability"],
    contextContract: [
      {
        description: "Selects the target client partition.",
        example: "client-123",
        key: "client_id",
        required: true,
        type: "string",
      },
    ],
    displayName: "Telemetry Relay",
    headerContract: [
      {
        description: "Passes the user id through to the downstream API.",
        name: "X-User-Id",
        required: true,
        source: "user.id",
      },
    ],
    publications: [
      {
        environmentKey: "dev",
        healthEndpointUrl: "https://dev.agent.example.com/health",
        rawCard: createRawCard({
          invocationEndpoint: "https://dev.agent.example.com/invoke",
        }),
      },
      {
        environmentKey: "prod",
        healthEndpointUrl: "https://prod.agent.example.com/health",
        rawCard: createRawCard({
          invocationEndpoint: "https://prod.agent.example.com/invoke",
        }),
      },
    ],
    requiredRoles: ["support-agent"],
    requiredScopes: ["tickets.read"],
    summary: "Relays advisory metrics to the registry.",
    tags: ["telemetry"],
    versionLabel: "2026.03.14",
    ...overrides,
  };
}

async function createDraftVersion(
  context: ApiTestContext,
  tenantId: string,
  subjectId: string,
  overrides: Partial<DraftRegistrationRequest> = {},
): Promise<DraftAgentRegistrationResponse> {
  const response = await requestJson<DraftAgentRegistrationResponse>(context, {
    body: createDraftRegistrationRequest(overrides),
    path: `/tenants/${tenantId}/agents`,
    subjectId,
  });

  assert.equal(response.status, 201);
  return response.body;
}

async function submitVersion(
  context: ApiTestContext,
  tenantId: string,
  agentId: string,
  versionId: string,
  subjectId: string,
): Promise<JsonResponse<VersionLifecycleResponse | ErrorResponseBody>> {
  return requestJson<VersionLifecycleResponse | ErrorResponseBody>(context, {
    path: `/tenants/${tenantId}/agents/${agentId}/versions/${versionId}:submit`,
    subjectId,
  });
}

async function approveVersion(
  context: ApiTestContext,
  tenantId: string,
  agentId: string,
  versionId: string,
  subjectId: string,
): Promise<JsonResponse<VersionLifecycleResponse | ErrorResponseBody>> {
  return requestJson<VersionLifecycleResponse | ErrorResponseBody>(context, {
    path: `/tenants/${tenantId}/agents/${agentId}/versions/${versionId}:approve`,
    subjectId,
  });
}

async function createApprovedVersion(
  context: ApiTestContext,
  tenantId: string,
  publisherSubjectId: string,
  adminSubjectId: string,
): Promise<DraftAgentRegistrationResponse> {
  const draft = await createDraftVersion(context, tenantId, publisherSubjectId);
  const submitResponse = await submitVersion(
    context,
    tenantId,
    draft.agentId,
    draft.versionId,
    publisherSubjectId,
  );
  const approveResponse = await approveVersion(
    context,
    tenantId,
    draft.agentId,
    draft.versionId,
    adminSubjectId,
  );

  assert.equal(submitResponse.status, 200);
  assert.equal(approveResponse.status, 200);

  return draft;
}

async function postTelemetry(
  context: ApiTestContext,
  options: {
    agentId: string;
    body: UpsertTelemetryRequest;
    environmentKey: string;
    subjectId: string;
    tenantId: string;
    versionId: string;
  },
): Promise<JsonResponse<UpsertTelemetryResponse | ErrorResponseBody>> {
  return requestJson<UpsertTelemetryResponse | ErrorResponseBody>(context, {
    body: options.body,
    path:
      `/tenants/${options.tenantId}/agents/${options.agentId}/versions/${options.versionId}` +
      `/environments/${options.environmentKey}:telemetry`,
    subjectId: options.subjectId,
  });
}

function buildTelemetryRequest(
  overrides: Partial<UpsertTelemetryRequest> = {},
): UpsertTelemetryRequest {
  return {
    errorCount: 1,
    invocationCount: 12,
    p50LatencyMs: 180,
    p95LatencyMs: 410,
    successCount: 11,
    windowEndedAt: "2026-03-14T00:05:00.000Z",
    windowStartedAt: "2026-03-14T00:00:00.000Z",
    ...overrides,
  };
}

function findPublicationByEnvironment<TPublication extends { environmentKey: string }>(
  publications: TPublication[],
  environmentKey: string,
): TPublication {
  const publication = publications.find((entry) => entry.environmentKey === environmentKey);

  assert.notEqual(publication, undefined);
  return publication as TPublication;
}

function normalizeTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

async function getStoredTelemetryRows(
  context: ApiTestContext,
  tenantId: string,
  publicationId: string,
) {
  const rows = await context.db
    .selectFrom("publication_telemetry")
    .select([
      "error_count",
      "invocation_count",
      "p50_latency_ms",
      "p95_latency_ms",
      "publication_id",
      "success_count",
      "tenant_id",
      "window_ended_at",
      "window_started_at",
    ])
    .where("tenant_id", "=", tenantId)
    .where("publication_id", "=", publicationId)
    .orderBy("window_started_at")
    .execute();

  return rows.map((row) => ({
    ...row,
    window_ended_at: normalizeTimestamp(row.window_ended_at),
    window_started_at: normalizeTimestamp(row.window_started_at),
  }));
}

async function getStoredTelemetryRowsForWindow(
  context: ApiTestContext,
  tenantId: string,
  windowStartedAt: string,
  windowEndedAt: string,
) {
  const rows = await context.db
    .selectFrom("publication_telemetry")
    .select([
      "error_count",
      "invocation_count",
      "p50_latency_ms",
      "p95_latency_ms",
      "publication_id",
      "success_count",
      "tenant_id",
      "window_ended_at",
      "window_started_at",
    ])
    .where("tenant_id", "=", tenantId)
    .where("window_started_at", "=", windowStartedAt)
    .where("window_ended_at", "=", windowEndedAt)
    .orderBy("publication_id")
    .execute();

  return rows.map((row) => ({
    ...row,
    window_ended_at: normalizeTimestamp(row.window_ended_at),
    window_started_at: normalizeTimestamp(row.window_started_at),
  }));
}

async function getTenantPolicyOverlaySnapshot(
  context: ApiTestContext,
  tenantId: string,
  agentId: string,
) {
  const rows = await context.db
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
    .execute();

  return rows
    .map((row) => ({
      deprecated: row.deprecated,
      disabled: row.disabled,
      environment_key: row.environment_key,
      required_roles: row.required_roles,
      required_scopes: row.required_scopes,
    }))
    .sort((left, right) => (left.environment_key ?? "").localeCompare(right.environment_key ?? ""));
}

async function getPublicationHealth(
  context: ApiTestContext,
  publicationId: string,
): Promise<{
  consecutive_failures: number;
  health_status: HealthStatus;
  last_checked_at: string | null;
  last_error: string | null;
  last_success_at: string | null;
  publication_id: string;
  recent_failures: number;
}> {
  return context.db
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
    .where("publication_id", "=", publicationId)
    .executeTakeFirstOrThrow();
}

test("telemetry upserts one summary per publication window and exposes it in admin detail", async () => {
  // Arrange
  const context = await createTelemetryApiContext();

  try {
    const approvedVersion = await createApprovedVersion(
      context,
      "tenant-alpha",
      "publisher-alpha",
      "admin-alpha",
    );
    const devPublication = findPublicationByEnvironment(approvedVersion.publications, "dev");
    const firstTelemetry = buildTelemetryRequest();
    const updatedTelemetry = buildTelemetryRequest({
      invocationCount: 15,
      p50LatencyMs: 140,
      p95LatencyMs: 320,
      successCount: 14,
    });

    // Act
    const firstWrite = await postTelemetry(context, {
      agentId: approvedVersion.agentId,
      body: firstTelemetry,
      environmentKey: "dev",
      subjectId: "publisher-alpha",
      tenantId: "tenant-alpha",
      versionId: approvedVersion.versionId,
    });
    const secondWrite = await postTelemetry(context, {
      agentId: approvedVersion.agentId,
      body: updatedTelemetry,
      environmentKey: "dev",
      subjectId: "publisher-alpha",
      tenantId: "tenant-alpha",
      versionId: approvedVersion.versionId,
    });
    const storedTelemetry = await getStoredTelemetryRows(
      context,
      "tenant-alpha",
      devPublication.publicationId,
    );
    const versionDetail = await requestJson<VersionAdminDetailResponse>(context, {
      method: "GET",
      path: `/tenants/tenant-alpha/agents/${approvedVersion.agentId}/versions/${approvedVersion.versionId}`,
      subjectId: "admin-alpha",
    });
    const agentDetail = await requestJson<AgentAdminDetailResponse>(context, {
      method: "GET",
      path: `/tenants/tenant-alpha/agents/${approvedVersion.agentId}`,
      subjectId: "admin-alpha",
    });

    // Assert
    assert.equal(firstWrite.status, 200);
    assert.equal(secondWrite.status, 200);
    assert.equal((secondWrite.body as UpsertTelemetryResponse).telemetry.invocationCount, 15);
    assert.match((secondWrite.body as UpsertTelemetryResponse).telemetry.recordedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(storedTelemetry, [
      {
        error_count: 1,
        invocation_count: 15,
        p50_latency_ms: 140,
        p95_latency_ms: 320,
        publication_id: devPublication.publicationId,
        success_count: 14,
        tenant_id: "tenant-alpha",
        window_ended_at: "2026-03-14T00:05:00.000Z",
        window_started_at: "2026-03-14T00:00:00.000Z",
      },
    ]);
    assert.equal(versionDetail.status, 200);
    assert.deepEqual(
      findPublicationByEnvironment(versionDetail.body.publications, "dev").telemetry.map((entry) => ({
        errorCount: entry.errorCount,
        invocationCount: entry.invocationCount,
        p50LatencyMs: entry.p50LatencyMs,
        p95LatencyMs: entry.p95LatencyMs,
        successCount: entry.successCount,
        windowEndedAt: entry.windowEndedAt,
        windowStartedAt: entry.windowStartedAt,
      })),
      [
        {
          errorCount: 1,
          invocationCount: 15,
          p50LatencyMs: 140,
          p95LatencyMs: 320,
          successCount: 14,
          windowEndedAt: "2026-03-14T00:05:00.000Z",
          windowStartedAt: "2026-03-14T00:00:00.000Z",
        },
      ],
    );
    assert.equal(agentDetail.status, 200);
    assert.deepEqual(
      findPublicationByEnvironment(
        agentDetail.body.activeVersion?.publications ?? [],
        "dev",
      ).telemetry.map((entry) => entry.invocationCount),
      [15],
    );
  } finally {
    await context.close();
  }
});

test("telemetry keeps same-window summaries separate across publications in one tenant", async () => {
  // Arrange
  const context = await createTelemetryApiContext();

  try {
    const approvedVersion = await createApprovedVersion(
      context,
      "tenant-alpha",
      "publisher-alpha",
      "admin-alpha",
    );
    const devPublication = findPublicationByEnvironment(approvedVersion.publications, "dev");
    const prodPublication = findPublicationByEnvironment(approvedVersion.publications, "prod");
    const devTelemetry = buildTelemetryRequest();
    const prodTelemetry = buildTelemetryRequest({
      errorCount: 2,
      invocationCount: 21,
      p50LatencyMs: 95,
      p95LatencyMs: 180,
      successCount: 19,
    });

    // Act
    const devWrite = await postTelemetry(context, {
      agentId: approvedVersion.agentId,
      body: devTelemetry,
      environmentKey: "dev",
      subjectId: "publisher-alpha",
      tenantId: "tenant-alpha",
      versionId: approvedVersion.versionId,
    });
    const prodWrite = await postTelemetry(context, {
      agentId: approvedVersion.agentId,
      body: prodTelemetry,
      environmentKey: "prod",
      subjectId: "publisher-alpha",
      tenantId: "tenant-alpha",
      versionId: approvedVersion.versionId,
    });
    const storedTelemetry = await getStoredTelemetryRowsForWindow(
      context,
      "tenant-alpha",
      devTelemetry.windowStartedAt,
      devTelemetry.windowEndedAt,
    );
    const expectedTelemetry = [
      {
        error_count: 1,
        invocation_count: 12,
        p50_latency_ms: 180,
        p95_latency_ms: 410,
        publication_id: devPublication.publicationId,
        success_count: 11,
        tenant_id: "tenant-alpha",
        window_ended_at: "2026-03-14T00:05:00.000Z",
        window_started_at: "2026-03-14T00:00:00.000Z",
      },
      {
        error_count: 2,
        invocation_count: 21,
        p50_latency_ms: 95,
        p95_latency_ms: 180,
        publication_id: prodPublication.publicationId,
        success_count: 19,
        tenant_id: "tenant-alpha",
        window_ended_at: "2026-03-14T00:05:00.000Z",
        window_started_at: "2026-03-14T00:00:00.000Z",
      },
    ].sort((left, right) => left.publication_id.localeCompare(right.publication_id));
    const versionDetail = await requestJson<VersionAdminDetailResponse>(context, {
      method: "GET",
      path: `/tenants/tenant-alpha/agents/${approvedVersion.agentId}/versions/${approvedVersion.versionId}`,
      subjectId: "admin-alpha",
    });

    // Assert
    assert.equal(devWrite.status, 200);
    assert.equal(prodWrite.status, 200);
    assert.deepEqual(storedTelemetry, expectedTelemetry);
    assert.equal(versionDetail.status, 200);
    assert.deepEqual(
      findPublicationByEnvironment(versionDetail.body.publications, "dev").telemetry.map((entry) => ({
        errorCount: entry.errorCount,
        invocationCount: entry.invocationCount,
        successCount: entry.successCount,
      })),
      [
        {
          errorCount: 1,
          invocationCount: 12,
          successCount: 11,
        },
      ],
    );
    assert.deepEqual(
      findPublicationByEnvironment(versionDetail.body.publications, "prod").telemetry.map((entry) => ({
        errorCount: entry.errorCount,
        invocationCount: entry.invocationCount,
        successCount: entry.successCount,
      })),
      [
        {
          errorCount: 2,
          invocationCount: 21,
          successCount: 19,
        },
      ],
    );
  } finally {
    await context.close();
  }
});

test("telemetry writes and reads enforce tenant scoping and role checks", async () => {
  // Arrange
  const context = await createTelemetryApiContext();

  try {
    const approvedVersion = await createApprovedVersion(
      context,
      "tenant-alpha",
      "publisher-alpha",
      "admin-alpha",
    );
    const telemetry = buildTelemetryRequest();

    // Act
    const allowedWrite = await postTelemetry(context, {
      agentId: approvedVersion.agentId,
      body: telemetry,
      environmentKey: "dev",
      subjectId: "publisher-alpha",
      tenantId: "tenant-alpha",
      versionId: approvedVersion.versionId,
    });
    const crossTenantWrite = await postTelemetry(context, {
      agentId: approvedVersion.agentId,
      body: telemetry,
      environmentKey: "dev",
      subjectId: "publisher-beta",
      tenantId: "tenant-alpha",
      versionId: approvedVersion.versionId,
    });
    const unauthorizedWrite = await postTelemetry(context, {
      agentId: approvedVersion.agentId,
      body: telemetry,
      environmentKey: "dev",
      subjectId: "caller-alpha",
      tenantId: "tenant-alpha",
      versionId: approvedVersion.versionId,
    });
    const adminRead = await requestJson<VersionAdminDetailResponse>(context, {
      method: "GET",
      path: `/tenants/tenant-alpha/agents/${approvedVersion.agentId}/versions/${approvedVersion.versionId}`,
      subjectId: "admin-alpha",
    });
    const publisherRead = await requestJson<VersionAdminDetailResponse | ErrorResponseBody>(context, {
      method: "GET",
      path: `/tenants/tenant-alpha/agents/${approvedVersion.agentId}/versions/${approvedVersion.versionId}`,
      subjectId: "publisher-alpha",
    });
    const crossTenantRead = await requestJson<VersionAdminDetailResponse | ErrorResponseBody>(context, {
      method: "GET",
      path: `/tenants/tenant-alpha/agents/${approvedVersion.agentId}/versions/${approvedVersion.versionId}`,
      subjectId: "admin-beta",
    });

    // Assert
    assert.equal(allowedWrite.status, 200);
    assert.equal(crossTenantWrite.status, 403);
    assert.equal((crossTenantWrite.body as ErrorResponseBody).error.code, "forbidden");
    assert.equal(unauthorizedWrite.status, 403);
    assert.deepEqual((unauthorizedWrite.body as ErrorResponseBody).error, {
      code: "forbidden",
      message: "Publisher or tenant admin role is required to submit telemetry.",
    });
    assert.equal(adminRead.status, 200);
    assert.deepEqual(
      findPublicationByEnvironment(adminRead.body.publications, "dev").telemetry.map((entry) => entry.invocationCount),
      [12],
    );
    assert.equal(publisherRead.status, 403);
    assert.deepEqual((publisherRead.body as ErrorResponseBody).error, {
      code: "forbidden",
      message: "Tenant admin role is required to view admin detail endpoints.",
    });
    assert.equal(crossTenantRead.status, 403);
    assert.equal((crossTenantRead.body as ErrorResponseBody).error.code, "forbidden");
  } finally {
    await context.close();
  }
});

test("telemetry ingestion is advisory and leaves health, lifecycle, and publication metadata unchanged", async () => {
  // Arrange
  const context = await createTelemetryApiContext();

  try {
    const approvedVersion = await createApprovedVersion(
      context,
      "tenant-alpha",
      "publisher-alpha",
      "admin-alpha",
    );
    const prodPublication = findPublicationByEnvironment(approvedVersion.publications, "prod");

    await context.db
      .insertInto("tenant_policy_overlays")
      .values([
        {
          agent_id: approvedVersion.agentId,
          deprecated: true,
          disabled: false,
          environment_key: null,
          required_roles: ["registry-auditor"],
          required_scopes: ["agents.audit"],
          tenant_id: "tenant-alpha",
        },
        {
          agent_id: approvedVersion.agentId,
          deprecated: false,
          disabled: true,
          environment_key: "prod",
          required_roles: ["prod-operator"],
          required_scopes: ["prod.invoke"],
          tenant_id: "tenant-alpha",
        },
      ])
      .execute();

    await context.db
      .updateTable("publication_health")
      .set({
        consecutive_failures: 1,
        health_status: "degraded",
        last_checked_at: "2026-03-14T01:00:00.000Z",
        last_error: "timeout",
        recent_failures: 1,
      })
      .where("publication_id", "=", prodPublication.publicationId)
      .execute();

    const versionBefore = await context.db
      .selectFrom("agent_versions")
      .select(["approval_state", "required_roles", "required_scopes", "version_id"])
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", approvedVersion.agentId)
      .where("version_id", "=", approvedVersion.versionId)
      .executeTakeFirstOrThrow();
    const publicationBefore = await context.db
      .selectFrom("environment_publications")
      .select([
        "health_endpoint_url",
        "invocation_endpoint",
        "normalized_metadata",
        "publication_id",
        "raw_card",
      ])
      .where("publication_id", "=", prodPublication.publicationId)
      .executeTakeFirstOrThrow();
    const healthBefore = await getPublicationHealth(context, prodPublication.publicationId);
    const agentBefore = await context.db
      .selectFrom("agents")
      .select(["active_version_id", "agent_id", "deprecated", "disabled"])
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", approvedVersion.agentId)
      .executeTakeFirstOrThrow();
    const overlaysBefore = await getTenantPolicyOverlaySnapshot(
      context,
      "tenant-alpha",
      approvedVersion.agentId,
    );

    // Act
    const telemetryWrite = await postTelemetry(context, {
      agentId: approvedVersion.agentId,
      body: buildTelemetryRequest({
        invocationCount: 22,
        successCount: 20,
      }),
      environmentKey: "prod",
      subjectId: "publisher-alpha",
      tenantId: "tenant-alpha",
      versionId: approvedVersion.versionId,
    });
    const versionAfter = await context.db
      .selectFrom("agent_versions")
      .select(["approval_state", "required_roles", "required_scopes", "version_id"])
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", approvedVersion.agentId)
      .where("version_id", "=", approvedVersion.versionId)
      .executeTakeFirstOrThrow();
    const publicationAfter = await context.db
      .selectFrom("environment_publications")
      .select([
        "health_endpoint_url",
        "invocation_endpoint",
        "normalized_metadata",
        "publication_id",
        "raw_card",
      ])
      .where("publication_id", "=", prodPublication.publicationId)
      .executeTakeFirstOrThrow();
    const healthAfter = await getPublicationHealth(context, prodPublication.publicationId);
    const agentAfter = await context.db
      .selectFrom("agents")
      .select(["active_version_id", "agent_id", "deprecated", "disabled"])
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", approvedVersion.agentId)
      .executeTakeFirstOrThrow();
    const overlaysAfter = await getTenantPolicyOverlaySnapshot(
      context,
      "tenant-alpha",
      approvedVersion.agentId,
    );
    const versionDetail = await requestJson<VersionAdminDetailResponse>(context, {
      method: "GET",
      path: `/tenants/tenant-alpha/agents/${approvedVersion.agentId}/versions/${approvedVersion.versionId}`,
      subjectId: "admin-alpha",
    });

    // Assert
    assert.equal(telemetryWrite.status, 200);
    assert.deepEqual(versionAfter, versionBefore);
    assert.deepEqual(publicationAfter, publicationBefore);
    assert.deepEqual(healthAfter, healthBefore);
    assert.deepEqual(agentAfter, agentBefore);
    assert.deepEqual(overlaysAfter, overlaysBefore);
    assert.equal(versionDetail.status, 200);
    assert.equal(findPublicationByEnvironment(versionDetail.body.publications, "prod").healthStatus, "degraded");
    assert.deepEqual(
      findPublicationByEnvironment(versionDetail.body.publications, "prod").telemetry.map((entry) => ({
        invocationCount: entry.invocationCount,
        successCount: entry.successCount,
      })),
      [
        {
          invocationCount: 22,
          successCount: 20,
        },
      ],
    );
  } finally {
    await context.close();
  }
});
