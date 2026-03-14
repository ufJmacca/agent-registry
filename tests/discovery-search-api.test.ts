import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { sql } from "kysely";
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

interface DiscoveryItemResponse {
  activeVersionId: string;
  agentId: string;
  deprecated: boolean;
  displayName: string;
  environmentKey: string;
  healthStatus: string;
  publisherId: string;
  rawCard?: string;
  rawCardAvailable: boolean;
  status: string;
}

interface DiscoveryListResponse {
  items: DiscoveryItemResponse[];
  page: number;
  pageSize: number;
  total: number;
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

async function createDiscoveryApiContext(): Promise<ApiTestContext> {
  const database = await createFreshRegistryDatabase();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-registry-discovery-api-"));
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
        "      - subjectId: publisher-alpha",
        "        roles: [publisher]",
        "      - subjectId: publisher-beta",
        "        roles: [publisher]",
        "      - subjectId: caller-authorized",
        "        roles: [support-agent, region-analyst]",
        "        scopes: [overlay.use, tickets.read, tickets.write]",
        "      - subjectId: caller-all-overlay-roles",
        "        roles: [support-agent, region-analyst, risk-analyst]",
        "        scopes: [tickets.read]",
        "      - subjectId: caller-case-manager",
        "        roles: [case-manager, region-analyst]",
        "        scopes: [overlay.use, tickets.read]",
        "      - subjectId: caller-missing-overlay-role",
        "        roles: [support-agent]",
        "        scopes: [overlay.use, tickets.read]",
        "      - subjectId: caller-missing-publisher-scope",
        "        roles: [support-agent, region-analyst]",
        "        scopes: [overlay.use]",
        "      - subjectId: caller-missing-overlay-scope",
        "        roles: [support-agent, region-analyst]",
        "        scopes: [tickets.read]",
        "      - subjectId: caller-no-access",
        "        roles: []",
        "        scopes: []",
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
  const response = await fetch(new URL(options.path, context.baseUrl), {
    headers: new Headers({
      "x-agent-registry-subject-id": options.subjectId,
    }),
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
      capabilities: ["card-search"],
      invocationEndpoint: "https://agent.example.com/invoke",
      name: "Case Resolver",
      summary: "Handles support case routing.",
      tags: ["card-tag"],
      ...overrides,
    },
    null,
    2,
  );
}

function createLargeRawCard(name: string, minimumBytes: number): string {
  const baseRecord = {
    capabilities: ["card-search"],
    invocationEndpoint: `https://${name}.example.com/invoke`,
    name,
    summary: `${name} summary`,
    tags: ["oversized"],
  };
  const baseCard = JSON.stringify(baseRecord, null, 2);
  const paddingLength = Math.max(0, minimumBytes - Buffer.byteLength(baseCard, "utf8"));

  return JSON.stringify(
    {
      ...baseRecord,
      padding: "x".repeat(paddingLength),
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

test("available returns only authorized approved-active publications and excludes disabled items while flagging deprecated and unhealthy items", async () => {
  // Arrange
  const context = await createDiscoveryApiContext();

  try {
    await insertVersion(context, {
      active: true,
      agentId: "agent-authorized",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-authorized",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-authorized",
      versionSequence: 1,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-deprecated",
      approvalState: "approved",
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
          publicationId: "publication-deprecated",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-deprecated",
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
    await insertVersion(context, {
      agentId: "agent-pending-only",
      approvalState: "pending_review",
      publications: [
        {
          environmentKey: "prod",
          publicationId: "publication-pending-only",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-pending-only",
      versionSequence: 1,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-stays-active",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "dev",
          healthStatus: "unknown",
          publicationId: "publication-stays-active-approved",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-stays-active-approved",
      versionSequence: 1,
    });
    await insertVersion(context, {
      agentId: "agent-stays-active",
      approvalState: "pending_review",
      publications: [
        {
          environmentKey: "dev",
          publicationId: "publication-stays-active-pending",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-stays-active-pending",
      versionSequence: 2,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-unauthorized",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-unauthorized",
        },
      ],
      publisherId: "publisher-alpha",
      requiredRoles: ["finance-agent"],
      versionId: "version-unauthorized",
      versionSequence: 1,
    });

    // Act
    const response = await requestJson<DiscoveryListResponse>(context, {
      path: "/tenants/tenant-alpha/agents/available?pageSize=20",
      subjectId: "caller-authorized",
    });

    // Assert
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.items.map((item) => ({
        activeVersionId: item.activeVersionId,
        agentId: item.agentId,
        deprecated: item.deprecated,
        environmentKey: item.environmentKey,
        healthStatus: item.healthStatus,
        status: item.status,
      })),
      [
        {
          activeVersionId: "version-authorized",
          agentId: "agent-authorized",
          deprecated: false,
          environmentKey: "prod",
          healthStatus: "healthy",
          status: "approved_active",
        },
        {
          activeVersionId: "version-stays-active-approved",
          agentId: "agent-stays-active",
          deprecated: false,
          environmentKey: "dev",
          healthStatus: "unknown",
          status: "approved_active",
        },
        {
          activeVersionId: "version-deprecated",
          agentId: "agent-deprecated",
          deprecated: true,
          environmentKey: "prod",
          healthStatus: "degraded",
          status: "approved_active",
        },
      ],
    );
    assert.equal(response.body.total, 3);
  } finally {
    await context.close();
  }
});

test("available access checks combine publisher and overlay role and scope clauses with logical AND", async () => {
  // Arrange
  const context = await createDiscoveryApiContext();

  try {
    await insertVersion(context, {
      active: true,
      agentId: "agent-gated",
      approvalState: "approved",
      overlays: [
        {
          environmentKey: null,
          requiredRoles: ["region-analyst", "risk-analyst"],
        },
        {
          environmentKey: "prod",
          requiredScopes: ["overlay.use"],
        },
      ],
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-gated",
        },
      ],
      publisherId: "publisher-alpha",
      requiredRoles: ["support-agent", "case-manager"],
      requiredScopes: ["tickets.read"],
      versionId: "version-gated",
      versionSequence: 1,
    });

    // Act
    const authorizedResponse = await requestJson<DiscoveryListResponse>(context, {
      path: "/tenants/tenant-alpha/agents/available",
      subjectId: "caller-authorized",
    });
    const caseManagerResponse = await requestJson<DiscoveryListResponse>(context, {
      path: "/tenants/tenant-alpha/agents/available",
      subjectId: "caller-case-manager",
    });
    const missingOverlayRoleResponse = await requestJson<DiscoveryListResponse>(context, {
      path: "/tenants/tenant-alpha/agents/available",
      subjectId: "caller-missing-overlay-role",
    });
    const missingPublisherScopeResponse = await requestJson<DiscoveryListResponse>(context, {
      path: "/tenants/tenant-alpha/agents/available",
      subjectId: "caller-missing-publisher-scope",
    });
    const missingOverlayScopeResponse = await requestJson<DiscoveryListResponse>(context, {
      path: "/tenants/tenant-alpha/agents/available",
      subjectId: "caller-missing-overlay-scope",
    });

    // Assert
    assert.deepEqual(
      authorizedResponse.body.items.map((item) => item.agentId),
      ["agent-gated"],
    );
    assert.deepEqual(
      caseManagerResponse.body.items.map((item) => item.agentId),
      ["agent-gated"],
    );
    assert.deepEqual(missingOverlayRoleResponse.body.items, []);
    assert.deepEqual(missingPublisherScopeResponse.body.items, []);
    assert.deepEqual(missingOverlayScopeResponse.body.items, []);
  } finally {
    await context.close();
  }
});

test("available access requires agent and environment overlay role clauses independently", async () => {
  // Arrange
  const context = await createDiscoveryApiContext();

  try {
    await insertVersion(context, {
      active: true,
      agentId: "agent-separate-overlay-roles",
      approvalState: "approved",
      overlays: [
        {
          environmentKey: null,
          requiredRoles: ["region-analyst"],
        },
        {
          environmentKey: "prod",
          requiredRoles: ["risk-analyst"],
        },
      ],
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-separate-overlay-roles",
        },
      ],
      publisherId: "publisher-alpha",
      requiredRoles: ["support-agent"],
      requiredScopes: ["tickets.read"],
      versionId: "version-separate-overlay-roles",
      versionSequence: 1,
    });

    // Act
    const authorizedResponse = await requestJson<DiscoveryListResponse>(context, {
      path: "/tenants/tenant-alpha/agents/available",
      subjectId: "caller-all-overlay-roles",
    });
    const missingEnvironmentRoleResponse = await requestJson<DiscoveryListResponse>(context, {
      path: "/tenants/tenant-alpha/agents/available",
      subjectId: "caller-authorized",
    });

    // Assert
    assert.deepEqual(
      authorizedResponse.body.items.map((item) => item.agentId),
      ["agent-separate-overlay-roles"],
    );
    assert.deepEqual(missingEnvironmentRoleResponse.body.items, []);
  } finally {
    await context.close();
  }
});

test("search supports repeated filters and defaults to approved-active results", async () => {
  // Arrange
  const context = await createDiscoveryApiContext();

  try {
    await insertVersion(context, {
      active: true,
      agentId: "agent-search-match",
      approvalState: "approved",
      headerContract: [
        {
          description: "Passes the user id through to the downstream API.",
          name: "X-User-Id",
          required: true,
          source: "user.id",
        },
        {
          description: "Passes the user email through when available.",
          name: "X-User-Email",
          required: false,
          source: "user.email",
        },
      ],
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-search-match",
        },
      ],
      publisherId: "publisher-alpha",
      requiredScopes: ["tickets.read", "tickets.write"],
      versionId: "version-search-match",
      versionSequence: 1,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-search-wrong-scope",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-search-wrong-scope",
        },
      ],
      publisherId: "publisher-alpha",
      requiredScopes: ["tickets.read"],
      versionId: "version-search-wrong-scope",
      versionSequence: 1,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-search-wrong-header",
      approvalState: "approved",
      headerContract: [
        {
          description: "Passes the user department through to the downstream API.",
          name: "X-Department",
          required: true,
          source: "user.department",
        },
      ],
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-search-wrong-header",
        },
      ],
      publisherId: "publisher-alpha",
      requiredScopes: ["tickets.read", "tickets.write"],
      versionId: "version-search-wrong-header",
      versionSequence: 1,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-search-wrong-context",
      approvalState: "approved",
      contextContract: [
        {
          description: "Selects the request locale.",
          key: "locale",
          required: true,
          type: "string",
        },
      ],
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-search-wrong-context",
        },
      ],
      publisherId: "publisher-alpha",
      requiredScopes: ["tickets.read", "tickets.write"],
      versionId: "version-search-wrong-context",
      versionSequence: 1,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-search-deprecated",
      approvalState: "approved",
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
          publicationId: "publication-search-deprecated",
        },
      ],
      publisherId: "publisher-alpha",
      requiredScopes: ["tickets.read", "tickets.write"],
      versionId: "version-search-deprecated",
      versionSequence: 1,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-search-active",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "staging",
          healthStatus: "unknown",
          publicationId: "publication-search-active-approved",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-search-active-approved",
      versionSequence: 1,
    });
    await insertVersion(context, {
      agentId: "agent-search-active",
      approvalState: "pending_review",
      publications: [
        {
          environmentKey: "staging",
          publicationId: "publication-search-active-pending",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-search-active-pending",
      versionSequence: 2,
    });
    await insertVersion(context, {
      agentId: "agent-search-pending-only",
      approvalState: "pending_review",
      publications: [
        {
          environmentKey: "prod",
          publicationId: "publication-search-pending-only",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-search-pending-only",
      versionSequence: 1,
    });

    // Act
    const filteredResponse = await requestJson<DiscoveryListResponse>(context, {
      path:
        "/tenants/tenant-alpha/agents/search?environment=prod&environment=staging&publisher=publisher-alpha&requiredScope=tickets.read&requiredScope=tickets.write&requiredHeader=X-User-Id&requiredContextKey=client_id&healthStatus=healthy&healthStatus=unknown&deprecated=false&page=1&pageSize=20",
      subjectId: "caller-authorized",
    });
    const defaultStatusResponse = await requestJson<DiscoveryListResponse>(context, {
      path: "/tenants/tenant-alpha/agents/search?pageSize=20",
      subjectId: "caller-authorized",
    });
    const pendingStatusResponse = await requestJson<DiscoveryListResponse>(context, {
      path: "/tenants/tenant-alpha/agents/search?status=pending_review&pageSize=20",
      subjectId: "caller-authorized",
    });

    // Assert
    assert.equal(filteredResponse.status, 200);
    assert.deepEqual(
      filteredResponse.body.items.map((item) => item.agentId),
      ["agent-search-match"],
    );
    assert.deepEqual(
      defaultStatusResponse.body.items.map((item) => item.agentId),
      [
        "agent-search-deprecated",
        "agent-search-match",
        "agent-search-wrong-context",
        "agent-search-wrong-header",
        "agent-search-wrong-scope",
        "agent-search-active",
      ],
    );
    assert.deepEqual(pendingStatusResponse.body.items, []);
  } finally {
    await context.close();
  }
});

test("search ordering is deterministic with and without a text query", async () => {
  // Arrange
  const context = await createDiscoveryApiContext();

  try {
    await insertVersion(context, {
      active: true,
      agentId: "agent-zeta",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-zeta",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-zeta-2",
      versionSequence: 2,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-alpha",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-alpha",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-alpha-1",
      versionSequence: 1,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-beta",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-beta",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-beta-1",
      versionSequence: 1,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-unknown",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "unknown",
          publicationId: "publication-unknown",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-unknown-5",
      versionSequence: 5,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-degraded",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "degraded",
          publicationId: "publication-degraded",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-degraded-4",
      versionSequence: 4,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-unreachable",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "unreachable",
          publicationId: "publication-unreachable",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-unreachable-6",
      versionSequence: 6,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-query-display",
      approvalState: "approved",
      displayName: "Atlas Resolver",
      publications: [
        {
          environmentKey: "dev",
          healthStatus: "unknown",
          publicationId: "publication-query-display",
        },
      ],
      publisherId: "publisher-alpha",
      summary: "Routes support cases.",
      tags: ["support"],
      versionId: "version-query-display",
      versionSequence: 1,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-query-summary",
      approvalState: "approved",
      displayName: "Workflow Router",
      publications: [
        {
          environmentKey: "dev",
          healthStatus: "healthy",
          publicationId: "publication-query-summary",
        },
      ],
      publisherId: "publisher-alpha",
      summary: "Atlas workflow assistant.",
      tags: ["support"],
      versionId: "version-query-summary",
      versionSequence: 1,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-query-tag",
      approvalState: "approved",
      displayName: "Ticket Router",
      publications: [
        {
          environmentKey: "dev",
          healthStatus: "healthy",
          publicationId: "publication-query-tag",
        },
      ],
      publisherId: "publisher-alpha",
      summary: "Routes support cases.",
      tags: ["atlas"],
      versionId: "version-query-tag",
      versionSequence: 1,
    });

    // Act
    const defaultResponse = await requestJson<DiscoveryListResponse>(context, {
      path:
        "/tenants/tenant-alpha/agents/search?publisher=publisher-alpha&environment=prod&pageSize=20",
      subjectId: "caller-authorized",
    });
    const queryResponse = await requestJson<DiscoveryListResponse>(context, {
      path:
        "/tenants/tenant-alpha/agents/search?q=atlas&publisher=publisher-alpha&environment=dev&pageSize=20",
      subjectId: "caller-authorized",
    });

    // Assert
    assert.deepEqual(
      defaultResponse.body.items.map((item) => item.agentId),
      [
        "agent-zeta",
        "agent-alpha",
        "agent-beta",
        "agent-unknown",
        "agent-degraded",
        "agent-unreachable",
      ],
    );
    assert.deepEqual(
      queryResponse.body.items.map((item) => item.agentId),
      [
        "agent-query-display",
        "agent-query-summary",
        "agent-query-tag",
      ],
    );
  } finally {
    await context.close();
  }
});

test("search pagination returns the requested page slice and total", async () => {
  // Arrange
  const context = await createDiscoveryApiContext();

  try {
    await insertVersion(context, {
      active: true,
      agentId: "agent-page-zeta",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-page-zeta",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-page-zeta-4",
      versionSequence: 4,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-page-alpha",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-page-alpha",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-page-alpha-3",
      versionSequence: 3,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-page-beta",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "healthy",
          publicationId: "publication-page-beta",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-page-beta-2",
      versionSequence: 2,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-page-unknown",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "unknown",
          publicationId: "publication-page-unknown",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-page-unknown-5",
      versionSequence: 5,
    });
    await insertVersion(context, {
      active: true,
      agentId: "agent-page-degraded",
      approvalState: "approved",
      publications: [
        {
          environmentKey: "prod",
          healthStatus: "degraded",
          publicationId: "publication-page-degraded",
        },
      ],
      publisherId: "publisher-alpha",
      versionId: "version-page-degraded-6",
      versionSequence: 6,
    });

    // Act
    const response = await requestJson<DiscoveryListResponse>(context, {
      path:
        "/tenants/tenant-alpha/agents/search?publisher=publisher-alpha&environment=prod&page=2&pageSize=2",
      subjectId: "caller-authorized",
    });

    // Assert
    assert.equal(response.status, 200);
    assert.equal(response.body.page, 2);
    assert.equal(response.body.pageSize, 2);
    assert.equal(response.body.total, 5);
    assert.deepEqual(
      response.body.items.map((item) => item.agentId),
      ["agent-page-beta", "agent-page-unknown"],
    );
  } finally {
    await context.close();
  }
});

test("include=rawCard caps page size, rejects non-approved-active status combinations, and enforces a payload cap", async () => {
  // Arrange
  const context = await createDiscoveryApiContext();

  try {
    for (let index = 1; index <= 6; index += 1) {
      await insertVersion(context, {
        active: true,
        agentId: `agent-small-${index}`,
        approvalState: "approved",
        publications: [
          {
            environmentKey: "prod",
            healthStatus: "healthy",
            publicationId: `publication-small-${index}`,
          },
        ],
        publisherId: "publisher-alpha",
        versionId: `version-small-${index}`,
        versionSequence: 1,
      });
    }

    for (let index = 1; index <= 4; index += 1) {
      await insertVersion(context, {
        active: true,
        agentId: `agent-large-${index}`,
        approvalState: "approved",
        publications: [
          {
            environmentKey: "prod",
            healthStatus: "healthy",
            publicationId: `publication-large-${index}`,
            rawCard: createLargeRawCard(`Large Agent ${index}`, 90 * 1024),
          },
        ],
        publisherId: "publisher-beta",
        versionId: `version-large-${index}`,
        versionSequence: 1,
      });
    }

    // Act
    const cappedResponse = await requestJson<DiscoveryListResponse>(context, {
      path:
        "/tenants/tenant-alpha/agents/search?include=rawCard&publisher=publisher-alpha&pageSize=10",
      subjectId: "caller-authorized",
    });
    const invalidStatusResponse = await requestJson<ErrorResponseBody>(context, {
      path:
        "/tenants/tenant-alpha/agents/search?include=rawCard&status=approved_active&status=pending_review",
      subjectId: "caller-authorized",
    });
    const payloadResponse = await requestJson<ErrorResponseBody>(context, {
      path:
        "/tenants/tenant-alpha/agents/search?include=rawCard&publisher=publisher-beta&pageSize=4",
      subjectId: "caller-authorized",
    });

    // Assert
    assert.equal(cappedResponse.status, 200);
    assert.equal(cappedResponse.body.pageSize, 5);
    assert.equal(cappedResponse.body.items.length, 5);
    assert.equal(cappedResponse.body.total, 6);
    assert.ok(cappedResponse.body.items.every((item) => typeof item.rawCard === "string"));

    assert.equal(invalidStatusResponse.status, 400);
    assert.equal(invalidStatusResponse.body.error.code, "invalid_query");

    assert.equal(payloadResponse.status, 400);
    assert.equal(payloadResponse.body.error.code, "raw_card_payload_too_large");
  } finally {
    await context.close();
  }
});
