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
  userContext?: Record<string, unknown>;
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

interface ActivePublicationDetailResponse {
  activeVersionId: string;
  agentId: string;
  publication: {
    contextContract: Array<{
      description: string;
      example?: unknown;
      key: string;
      required: boolean;
      type: string;
    }>;
    deprecated: boolean;
    displayName: string;
    environmentKey: string;
    headerContract: Array<{
      description: string;
      name: string;
      required: boolean;
      source: string;
    }>;
    healthStatus: string;
    rawCard?: string;
    rawCardAvailable: boolean;
    requiredRoles: string[];
    requiredScopes: string[];
    summary: string;
  };
}

interface PreflightResponse {
  activeVersionId: string;
  agentId: string;
  authorized: boolean;
  deprecated: boolean;
  environmentKey: string;
  healthStatus: string;
  missingRequiredContextKeys: string[];
  rawCard?: string;
  rawCardAvailable: boolean;
  ready: boolean;
  unresolvedRequiredHeaderSources: string[];
}

type ApprovalState = "approved" | "draft" | "pending_review" | "rejected";
type HealthStatus = "degraded" | "healthy" | "unknown" | "unreachable";

interface SeedPublicationInput {
  environmentKey: string;
  healthStatus?: HealthStatus;
  publicationId: string;
  rawCard?: string;
}

interface SeedOverlayInput {
  deprecated?: boolean;
  disabled?: boolean;
  environmentKey: string | null;
  requiredRoles?: string[];
  requiredScopes?: string[];
}

interface SeedVersionInput {
  active?: boolean;
  agentId: string;
  approvalState: ApprovalState;
  capabilities?: string[];
  contextContract?: Array<{
    description: string;
    example?: string;
    key: string;
    required: boolean;
    type: "string";
  }>;
  displayName?: string;
  headerContract?: Array<{
    description: string;
    name: string;
    required: boolean;
    source: string;
  }>;
  overlays?: SeedOverlayInput[];
  publications: SeedPublicationInput[];
  publisherId: string;
  requiredRoles?: string[];
  requiredScopes?: string[];
  summary?: string;
  tags?: string[];
  versionId: string;
  versionSequence: number;
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

async function createDetailPreflightApiContext(): Promise<ApiTestContext> {
  const database = await createFreshRegistryDatabase();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-registry-detail-preflight-api-"));
  const manifestPath = path.join(tempDir, "hosted-bootstrap.yaml");

  try {
    await writeFile(
      manifestPath,
      [
        "tenants:",
        "  - tenantId: tenant-alpha",
        "    displayName: Tenant Alpha",
        "    environments: [dev, prod, staging]",
        "    memberships:",
        "      - subjectId: admin-alpha",
        "        roles: [tenant-admin]",
        "        userContext:",
        "          id: admin-1",
        "          department: platform",
        "      - subjectId: publisher-alpha",
        "        roles: [publisher]",
        "      - subjectId: caller-authorized",
        "        roles: [support-agent]",
        "        scopes: [tickets.read, tickets.write]",
        "        userContext:",
        "          id: caller-123",
        "          email: caller@example.com",
        "      - subjectId: caller-no-access",
        "        roles: []",
        "        scopes: []",
        "        userContext:",
        "          id: caller-404",
        "",
      ].join("\n"),
      "utf8",
    );

    const config = loadRegistryConfig({
      DATABASE_URL: database.databaseUrl,
      DEPLOYMENT_MODE: "hosted",
      HOSTED_BOOTSTRAP_FILE: manifestPath,
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
    "content-type": "application/json",
    "x-agent-registry-subject-id": options.subjectId,
  });

  if (options.userContext !== undefined) {
    headers.set("x-agent-registry-user-context", JSON.stringify(options.userContext));
  }

  const response = await fetch(new URL(options.path, context.baseUrl), {
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    headers,
    method: options.method ?? "GET",
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
      capabilities: ["route-cases"],
      invocationEndpoint: "https://agent.example.com/invoke",
      name: "Case Resolver",
      summary: "Handles support case routing.",
      tags: ["routing"],
      ...overrides,
    },
    null,
    2,
  );
}

async function insertVersion(context: ApiTestContext, input: SeedVersionInput): Promise<void> {
  const displayName = input.displayName ?? "Case Resolver";
  const summary = input.summary ?? "Handles support case routing.";
  const capabilities = input.capabilities ?? ["shared-capability"];
  const tags = input.tags ?? ["shared-tag"];
  const requiredRoles = input.requiredRoles ?? ["support-agent"];
  const requiredScopes = input.requiredScopes ?? ["tickets.read"];
  const headerContract = input.headerContract ?? [
    {
      description: "Passes the user id through to the downstream API.",
      name: "X-User-Id",
      required: true,
      source: "user.id",
    },
  ];
  const contextContract = input.contextContract ?? [
    {
      description: "Selects the client partition.",
      example: "client-123",
      key: "client_id",
      required: true,
      type: "string" as const,
    },
  ];

  const existingAgent = await context.db
    .selectFrom("agents")
    .select("agent_id")
    .where("tenant_id", "=", "tenant-alpha")
    .where("agent_id", "=", input.agentId)
    .executeTakeFirst();

  if (existingAgent === undefined) {
    await context.db
      .insertInto("agents")
      .values({
        active_version_id: null,
        agent_id: input.agentId,
        display_name: displayName,
        summary,
        tenant_id: "tenant-alpha",
      })
      .execute();
  }

  await context.db
    .insertInto("agent_versions")
    .values({
      agent_id: input.agentId,
      approval_state: input.approvalState,
      approved_at: input.approvalState === "approved" ? "2026-03-13T10:00:00Z" : null,
      approved_by: input.approvalState === "approved" ? "admin-alpha" : null,
      capabilities,
      card_profile_id: "a2a-default",
      context_contract: JSON.stringify(contextContract),
      display_name: displayName,
      header_contract: JSON.stringify(headerContract),
      publisher_id: input.publisherId,
      rejected_at: input.approvalState === "rejected" ? "2026-03-13T11:00:00Z" : null,
      rejected_by: input.approvalState === "rejected" ? "admin-alpha" : null,
      rejected_reason: input.approvalState === "rejected" ? "Rejected in fixture setup." : null,
      required_roles: requiredRoles,
      required_scopes: requiredScopes,
      submitted_at:
        input.approvalState === "draft" ? null : "2026-03-13T09:00:00Z",
      submitted_by:
        input.approvalState === "draft" ? null : input.publisherId,
      summary,
      tags,
      tenant_id: "tenant-alpha",
      version_id: input.versionId,
      version_label: `v${input.versionSequence}`,
      version_sequence: input.versionSequence,
    } as never)
    .execute();

  for (const publication of input.publications) {
    const rawCard =
      publication.rawCard ??
      createRawCard({
        invocationEndpoint: `https://${publication.publicationId}.example.com/invoke`,
        name: displayName,
        summary,
        tags,
      });

    await context.db
      .insertInto("environment_publications")
      .values({
        agent_id: input.agentId,
        environment_key: publication.environmentKey,
        health_endpoint_url: `https://${publication.publicationId}.example.com/health`,
        invocation_endpoint: `https://${publication.publicationId}.example.com/invoke`,
        normalized_metadata: {
          capabilities,
          cardProfileId: "a2a-default",
          displayName,
          invocationEndpoint: `https://${publication.publicationId}.example.com/invoke`,
          summary,
          tags,
        },
        publication_id: publication.publicationId,
        raw_card: rawCard,
        tenant_id: "tenant-alpha",
        version_id: input.versionId,
      })
      .execute();

    if (input.approvalState === "approved") {
      await context.db
        .insertInto("publication_health")
        .values({
          health_status: publication.healthStatus ?? "unknown",
          publication_id: publication.publicationId,
        })
        .execute();
    }
  }

  for (const overlay of input.overlays ?? []) {
    await context.db
      .insertInto("tenant_policy_overlays")
      .values({
        agent_id: input.agentId,
        deprecated: overlay.deprecated ?? false,
        disabled: overlay.disabled ?? false,
        environment_key: overlay.environmentKey,
        required_roles: overlay.requiredRoles ?? [],
        required_scopes: overlay.requiredScopes ?? [],
        tenant_id: "tenant-alpha",
      })
      .execute();
  }

  if (input.active) {
    await context.db
      .updateTable("agents")
      .set({
        active_version_id: input.versionId,
      })
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", input.agentId)
      .execute();
  }
}

test("active detail returns the selected approved publication and preserves the raw card exactly", async () => {
  // Arrange
  const context = await createDetailPreflightApiContext();
  const expectedRawCard = `\n${createRawCard({
    invocationEndpoint: "https://detail-prod.example.com/invoke",
    name: "Case Resolver Prod",
    summary: "Routes production cases.",
  })}\n`;

  try {
    await insertVersion(context, {
      active: true,
      agentId: "agent-detail",
      approvalState: "approved",
      contextContract: [
        {
          description: "Selects the client partition.",
          example: "client-123",
          key: "client_id",
          required: true,
          type: "string",
        },
      ],
      headerContract: [
        {
          description: "Identifies the end user.",
          name: "X-User-Id",
          required: true,
          source: "user.id",
        },
      ],
      publications: [
        {
          environmentKey: "dev",
          healthStatus: "unknown",
          publicationId: "publication-detail-dev",
        },
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-detail-prod",
          rawCard: expectedRawCard,
        },
      ],
      publisherId: "publisher-alpha",
      requiredScopes: ["tickets.read", "tickets.write"],
      summary: "Routes production cases.",
      versionId: "version-detail",
      versionSequence: 1,
    });

    // Act
    const response = await requestJson<ActivePublicationDetailResponse>(context, {
      path: "/tenants/tenant-alpha/agents/agent-detail?environmentKey=prod&include=rawCard",
      subjectId: "caller-authorized",
    });

    // Assert
    assert.equal(response.status, 200);
    assert.equal(response.body.agentId, "agent-detail");
    assert.equal(response.body.activeVersionId, "version-detail");
    assert.deepEqual(response.body.publication.requiredScopes, ["tickets.read", "tickets.write"]);
    assert.equal(response.body.publication.environmentKey, "prod");
    assert.equal(response.body.publication.healthStatus, "healthy");
    assert.equal(response.body.publication.rawCardAvailable, true);
    assert.equal(response.body.publication.rawCard, expectedRawCard);
    assert.equal(response.body.publication.summary, "Routes production cases.");
  } finally {
    await context.close();
  }
});

test("active detail omits rawCard for authorized callers unless it is explicitly requested", async () => {
  // Arrange
  const context = await createDetailPreflightApiContext();
  const expectedRawCard = createRawCard({
    invocationEndpoint: "https://detail-default.example.com/invoke",
    name: "Case Resolver Default",
    summary: "Returns active publication detail without inlining cards by default.",
  });

  try {
    await insertVersion(context, {
      active: true,
      agentId: "agent-detail-default",
      approvalState: "approved",
      contextContract: [
        {
          description: "Selects the client partition.",
          example: "client-123",
          key: "client_id",
          required: true,
          type: "string",
        },
      ],
      headerContract: [
        {
          description: "Identifies the end user.",
          name: "X-User-Id",
          required: true,
          source: "user.id",
        },
      ],
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-detail-default",
          rawCard: expectedRawCard,
        },
      ],
      publisherId: "publisher-alpha",
      requiredScopes: ["tickets.read"],
      summary: "Returns active publication detail without inlining cards by default.",
      versionId: "version-detail-default",
      versionSequence: 1,
    });

    // Act
    const response = await requestJson<ActivePublicationDetailResponse>(context, {
      path: "/tenants/tenant-alpha/agents/agent-detail-default?environmentKey=prod",
      subjectId: "caller-authorized",
    });

    // Assert
    assert.equal(response.status, 200);
    assert.equal(response.body.agentId, "agent-detail-default");
    assert.equal(response.body.activeVersionId, "version-detail-default");
    assert.equal(response.body.publication.environmentKey, "prod");
    assert.equal(response.body.publication.healthStatus, "healthy");
    assert.equal(response.body.publication.rawCardAvailable, true);
    assert.deepEqual(response.body.publication.requiredScopes, ["tickets.read"]);
    assert.equal(
      response.body.publication.summary,
      "Returns active publication detail without inlining cards by default.",
    );
    assert.equal("rawCard" in response.body.publication, false);
  } finally {
    await context.close();
  }
});

test("active detail returns tenant-scoped 404s for inaccessible and disabled active publications to non-admin callers", async () => {
  // Arrange
  const context = await createDetailPreflightApiContext();

  try {
    await insertVersion(context, {
      active: true,
      agentId: "agent-inaccessible",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-inaccessible",
        },
      ],
      publisherId: "publisher-alpha",
      requiredRoles: ["finance-agent"],
      versionId: "version-inaccessible",
      versionSequence: 1,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-disabled",
      approvalState: "approved",
      overlays: [
        {
          disabled: true,
          environmentKey: "prod",
        },
      ],
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-disabled",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-disabled",
      versionSequence: 1,
    });

    // Act
    const inaccessibleResponse = await requestJson<ErrorResponseBody>(context, {
      path: "/tenants/tenant-alpha/agents/agent-inaccessible?environmentKey=prod",
      subjectId: "caller-authorized",
    });
    const disabledResponse = await requestJson<ErrorResponseBody>(context, {
      path: "/tenants/tenant-alpha/agents/agent-disabled?environmentKey=prod",
      subjectId: "caller-authorized",
    });

    // Assert
    assert.equal(inaccessibleResponse.status, 404);
    assert.equal(inaccessibleResponse.body.error.code, "publication_not_found");
    assert.equal(disabledResponse.status, 404);
    assert.equal(disabledResponse.body.error.code, "publication_not_found");
  } finally {
    await context.close();
  }
});

test("preflight returns authorization, readiness, deprecation, health, and rawCard only for authorized callers", async () => {
  // Arrange
  const context = await createDetailPreflightApiContext();
  const expectedRawCard = createRawCard({
    invocationEndpoint: "https://preflight-prod.example.com/invoke",
    name: "Ready Checker",
    summary: "Evaluates runtime readiness.",
  });

  try {
    await insertVersion(context, {
      active: true,
      agentId: "agent-preflight",
      approvalState: "approved",
      contextContract: [
        {
          description: "Selects the client partition.",
          example: "client-123",
          key: "client_id",
          required: true,
          type: "string",
        },
      ],
      headerContract: [
        {
          description: "Identifies the end user.",
          name: "X-User-Id",
          required: true,
          source: "user.id",
        },
        {
          description: "Routes by department.",
          name: "X-Department",
          required: true,
          source: "user.department",
        },
        {
          description: "Adds email when available.",
          name: "X-User-Email",
          required: false,
          source: "user.email",
        },
      ],
      overlays: [
        {
          deprecated: true,
          environmentKey: "prod",
        },
      ],
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "degraded",
          publicationId: "publication-preflight",
          rawCard: expectedRawCard,
        },
      ],
      publisherId: "publisher-alpha",
      requiredScopes: ["tickets.read", "tickets.write"],
      summary: "Evaluates runtime readiness.",
      versionId: "version-preflight",
      versionSequence: 1,
    });

    // Act
    const missingReadinessResponse = await requestJson<PreflightResponse>(context, {
      body: {
        includeRawCard: true,
      },
      method: "POST",
      path: "/tenants/tenant-alpha/agents/agent-preflight/environments/prod:preflight",
      subjectId: "caller-authorized",
    });
    const readyResponse = await requestJson<PreflightResponse>(context, {
      body: {
        context: {
          client_id: "client-123",
        },
        includeRawCard: true,
      },
      method: "POST",
      path: "/tenants/tenant-alpha/agents/agent-preflight/environments/prod:preflight",
      subjectId: "caller-authorized",
      userContext: {
        department: "support",
      },
    });

    // Assert
    assert.equal(missingReadinessResponse.status, 200);
    assert.deepEqual(missingReadinessResponse.body, {
      activeVersionId: "version-preflight",
      agentId: "agent-preflight",
      authorized: true,
      deprecated: true,
      environmentKey: "prod",
      healthStatus: "degraded",
      missingRequiredContextKeys: ["client_id"],
      rawCard: expectedRawCard,
      rawCardAvailable: true,
      ready: false,
      unresolvedRequiredHeaderSources: ["user.department"],
    });
    assert.equal(readyResponse.status, 200);
    assert.deepEqual(readyResponse.body, {
      activeVersionId: "version-preflight",
      agentId: "agent-preflight",
      authorized: true,
      deprecated: true,
      environmentKey: "prod",
      healthStatus: "degraded",
      missingRequiredContextKeys: [],
      rawCard: expectedRawCard,
      rawCardAvailable: true,
      ready: true,
      unresolvedRequiredHeaderSources: [],
    });
  } finally {
    await context.close();
  }
});

test("preflight omits rawCard for authorized callers unless it is explicitly requested", async () => {
  // Arrange
  const context = await createDetailPreflightApiContext();
  const expectedRawCard = createRawCard({
    invocationEndpoint: "https://preflight-default.example.com/invoke",
    name: "Preflight Default",
    summary: "Evaluates readiness without inlining cards by default.",
  });

  try {
    await insertVersion(context, {
      active: true,
      agentId: "agent-preflight-default",
      approvalState: "approved",
      contextContract: [
        {
          description: "Selects the client partition.",
          example: "client-123",
          key: "client_id",
          required: true,
          type: "string",
        },
      ],
      headerContract: [
        {
          description: "Identifies the end user.",
          name: "X-User-Id",
          required: true,
          source: "user.id",
        },
      ],
      overlays: [
        {
          deprecated: true,
          environmentKey: "prod",
        },
      ],
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-preflight-default",
          rawCard: expectedRawCard,
        },
      ],
      publisherId: "publisher-alpha",
      requiredScopes: ["tickets.read"],
      summary: "Evaluates readiness without inlining cards by default.",
      versionId: "version-preflight-default",
      versionSequence: 1,
    });

    // Act
    const response = await requestJson<PreflightResponse>(context, {
      body: {
        context: {
          client_id: "client-123",
        },
      },
      method: "POST",
      path:
        "/tenants/tenant-alpha/agents/agent-preflight-default/environments/prod:preflight",
      subjectId: "caller-authorized",
    });

    // Assert
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      activeVersionId: "version-preflight-default",
      agentId: "agent-preflight-default",
      authorized: true,
      deprecated: true,
      environmentKey: "prod",
      healthStatus: "healthy",
      missingRequiredContextKeys: [],
      rawCardAvailable: true,
      ready: true,
      unresolvedRequiredHeaderSources: [],
    });
    assert.equal("rawCard" in response.body, false);
  } finally {
    await context.close();
  }
});

test("preflight returns 200 for existing unauthorized or disabled publications and 404 only when the selection is missing", async () => {
  // Arrange
  const context = await createDetailPreflightApiContext();

  try {
    await insertVersion(context, {
      active: true,
      agentId: "agent-preflight-unauthorized",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-preflight-unauthorized",
        },
      ],
      publisherId: "publisher-alpha",
      requiredRoles: ["finance-agent"],
      versionId: "version-preflight-unauthorized",
      versionSequence: 1,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-preflight-disabled",
      approvalState: "approved",
      overlays: [
        {
          disabled: true,
          environmentKey: "prod",
        },
      ],
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "unreachable",
          publicationId: "publication-preflight-disabled",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-preflight-disabled",
      versionSequence: 1,
    });

    // Act
    const unauthorizedResponse = await requestJson<PreflightResponse>(context, {
      body: {
        includeRawCard: true,
      },
      method: "POST",
      path:
        "/tenants/tenant-alpha/agents/agent-preflight-unauthorized/environments/prod:preflight",
      subjectId: "caller-authorized",
    });
    const disabledResponse = await requestJson<PreflightResponse>(context, {
      body: {
        includeRawCard: true,
      },
      method: "POST",
      path: "/tenants/tenant-alpha/agents/agent-preflight-disabled/environments/prod:preflight",
      subjectId: "caller-authorized",
    });
    const missingResponse = await requestJson<ErrorResponseBody>(context, {
      body: {
        includeRawCard: true,
      },
      method: "POST",
      path: "/tenants/tenant-alpha/agents/agent-preflight-disabled/environments/dev:preflight",
      subjectId: "caller-authorized",
    });

    // Assert
    assert.equal(unauthorizedResponse.status, 200);
    assert.deepEqual(unauthorizedResponse.body, {
      activeVersionId: "version-preflight-unauthorized",
      agentId: "agent-preflight-unauthorized",
      authorized: false,
      deprecated: false,
      environmentKey: "prod",
      healthStatus: "healthy",
      missingRequiredContextKeys: ["client_id"],
      rawCardAvailable: true,
      ready: false,
      unresolvedRequiredHeaderSources: [],
    });
    assert.equal("rawCard" in unauthorizedResponse.body, false);

    assert.equal(disabledResponse.status, 200);
    assert.deepEqual(disabledResponse.body, {
      activeVersionId: "version-preflight-disabled",
      agentId: "agent-preflight-disabled",
      authorized: false,
      deprecated: false,
      environmentKey: "prod",
      healthStatus: "unreachable",
      missingRequiredContextKeys: ["client_id"],
      rawCardAvailable: true,
      ready: false,
      unresolvedRequiredHeaderSources: [],
    });
    assert.equal("rawCard" in disabledResponse.body, false);

    assert.equal(missingResponse.status, 404);
    assert.equal(missingResponse.body.error.code, "publication_not_found");
  } finally {
    await context.close();
  }
});
