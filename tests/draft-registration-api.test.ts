import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import { maxRawCardBytes } from "../packages/agent-card/src/index.ts";
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
const defaultCardProfileId = "a2a-default";
const alternateCardProfileId = "a2a-v1";

interface DraftAgentRegistrationResponse {
  agentId: string;
  approvalState: string;
  cardProfileId: string;
  publications: Array<{
    environmentKey: string;
    publicationId: string;
  }>;
  versionId: string;
  versionSequence: number;
}

interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
  };
}

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

interface DraftPublicationRequest {
  environmentKey: string;
  healthEndpointUrl: string;
  invocationEndpoint?: string;
  rawCard: string;
}

interface DraftRegistrationRequest {
  capabilities?: string[];
  cardProfileId?: string;
  contextContract?: unknown[];
  displayName?: string;
  headerContract?: unknown[];
  publications?: DraftPublicationRequest[];
  requiredRoles?: string[];
  requiredScopes?: string[];
  summary?: string;
  tags?: string[];
  versionLabel?: string;
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

async function createDraftRegistrationApiContext(options: {
  tenantDefaultCardProfileId?: string;
} = {}): Promise<ApiTestContext> {
  const database = await createFreshRegistryDatabase();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-registry-draft-api-"));
  const manifestPath = path.join(tempDir, "hosted-bootstrap.yaml");

  try {
    await writeFile(
      manifestPath,
      [
        "tenants:",
        "  - tenantId: tenant-alpha",
        "    displayName: Tenant Alpha",
        `    defaultCardProfileId: ${options.tenantDefaultCardProfileId ?? defaultCardProfileId}`,
        "    environments: [dev, prod, staging]",
        "    memberships:",
        "      - subjectId: admin-alpha",
        "        roles: [tenant-admin]",
        "      - subjectId: publisher-alpha",
        "        roles: [publisher]",
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
      name: "Case Resolver",
      summary: "Handles support case routing.",
      tags: ["card-tag"],
      ...overrides,
    },
    null,
    2,
  );
}

function createDraftRegistrationRequest(
  overrides: DraftRegistrationRequest = {},
): DraftRegistrationRequest {
  return {
    capabilities: ["shared-capability"],
    cardProfileId: defaultCardProfileId,
    contextContract: [
      {
        description: "Selects the target client partition.",
        example: "client-123",
        key: "client_id",
        required: true,
        type: "string",
      },
    ],
    displayName: "Case Resolver",
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
          capabilities: ["dev-card-capability"],
          invocationEndpoint: "https://dev.agent.example.com/invoke",
          tags: ["dev-card-tag"],
        }),
      },
      {
        environmentKey: "prod",
        healthEndpointUrl: "https://prod.agent.example.com/health",
        invocationEndpoint: "https://prod.agent.example.com/invoke",
        rawCard: createRawCard({
          capabilities: ["prod-card-capability"],
          invocationEndpoint: undefined,
          tags: ["prod-card-tag"],
        }),
      },
    ],
    requiredRoles: ["support-agent"],
    requiredScopes: ["tickets.read"],
    summary: "Handles support case routing.",
    tags: ["shared-tag"],
    versionLabel: "2026.03.13",
    ...overrides,
  };
}

async function listVersionSequences(db: AgentRegistryDb, tenantId: string, agentId: string): Promise<number[]> {
  const records = await db
    .selectFrom("agent_versions")
    .select("version_sequence")
    .where("tenant_id", "=", tenantId)
    .where("agent_id", "=", agentId)
    .orderBy("version_sequence")
    .execute();

  return records.map((record) => record.version_sequence);
}

async function loadStoredVersionSnapshot(
  db: AgentRegistryDb,
  tenantId: string,
  agentId: string,
  versionId: string,
): Promise<{
  publications: Array<{
    environment_key: string;
    health_endpoint_url: string;
    invocation_endpoint: string;
    normalized_metadata: unknown;
    raw_card: string;
  }>;
  version: {
    approval_state: string;
    capabilities: string[];
    card_profile_id: string;
    context_contract: unknown;
    display_name: string;
    header_contract: unknown;
    required_roles: string[];
    required_scopes: string[];
    summary: string;
    tags: string[];
    version_id: string;
    version_label: string;
    version_sequence: number;
  };
}> {
  const version = await db
    .selectFrom("agent_versions")
    .select([
      "approval_state",
      "capabilities",
      "card_profile_id",
      "context_contract",
      "display_name",
      "header_contract",
      "required_roles",
      "required_scopes",
      "summary",
      "tags",
      "version_id",
      "version_label",
      "version_sequence",
    ])
    .where("tenant_id", "=", tenantId)
    .where("agent_id", "=", agentId)
    .where("version_id", "=", versionId)
    .executeTakeFirstOrThrow();
  const publications = await db
    .selectFrom("environment_publications")
    .select([
      "environment_key",
      "health_endpoint_url",
      "invocation_endpoint",
      "normalized_metadata",
      "raw_card",
    ])
    .where("tenant_id", "=", tenantId)
    .where("agent_id", "=", agentId)
    .where("version_id", "=", versionId)
    .orderBy("environment_key")
    .execute();

  return {
    publications,
    version,
  };
}

test("publisher can create a multi-environment draft registration and persist normalized publication metadata", async () => {
  // Arrange
  const context = await createDraftRegistrationApiContext();
  const requestBody = createDraftRegistrationRequest();
  if (requestBody.publications !== undefined && requestBody.publications[1] !== undefined) {
    requestBody.publications[1].rawCard = `\n${requestBody.publications[1].rawCard}\n`;
  }
  const expectedProdRawCard = requestBody.publications?.[1]?.rawCard;

  try {
    // Act
    const response = await requestJson<DraftAgentRegistrationResponse>(context, {
      body: requestBody,
      path: "/tenants/tenant-alpha/agents",
      subjectId: "publisher-alpha",
    });

    // Assert
    assert.equal(response.status, 201);

    const storedAgent = await context.db
      .selectFrom("agents")
      .select(["agent_id", "active_version_id", "display_name", "summary"])
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", response.body.agentId)
      .executeTakeFirstOrThrow();
    const storedVersion = await context.db
      .selectFrom("agent_versions")
      .select([
        "approval_state",
        "capabilities",
        "card_profile_id",
        "context_contract",
        "display_name",
        "header_contract",
        "required_roles",
        "required_scopes",
        "tags",
        "version_id",
        "version_sequence",
      ])
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", response.body.agentId)
      .where("version_id", "=", response.body.versionId)
      .executeTakeFirstOrThrow();
    const storedPublications = await context.db
      .selectFrom("environment_publications")
      .select([
        "environment_key",
        "health_endpoint_url",
        "invocation_endpoint",
        "normalized_metadata",
        "raw_card",
      ])
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", response.body.agentId)
      .where("version_id", "=", response.body.versionId)
      .orderBy("environment_key")
      .execute();

    assert.equal(response.body.approvalState, "draft");
    assert.equal(response.body.cardProfileId, defaultCardProfileId);
    assert.equal(response.body.versionSequence, 1);
    assert.deepEqual(
      response.body.publications.map((publication) => publication.environmentKey).sort(),
      ["dev", "prod"],
    );
    assert.equal(storedAgent.active_version_id, null);
    assert.equal(storedAgent.display_name, "Case Resolver");
    assert.equal(storedAgent.summary, "Handles support case routing.");
    assert.equal(storedVersion.approval_state, "draft");
    assert.equal(storedVersion.card_profile_id, defaultCardProfileId);
    assert.equal(storedVersion.display_name, "Case Resolver");
    assert.equal(storedVersion.version_id, response.body.versionId);
    assert.equal(storedVersion.version_sequence, 1);
    assert.deepEqual(storedVersion.capabilities, ["shared-capability"]);
    assert.deepEqual(storedVersion.tags, ["shared-tag"]);
    assert.deepEqual(storedVersion.required_roles, ["support-agent"]);
    assert.deepEqual(storedVersion.required_scopes, ["tickets.read"]);
    assert.deepEqual(storedVersion.header_contract, requestBody.headerContract);
    assert.deepEqual(storedVersion.context_contract, requestBody.contextContract);
    assert.deepEqual(
      storedPublications.map((publication) => publication.environment_key),
      ["dev", "prod"],
    );
    assert.equal(storedPublications[0]?.health_endpoint_url, "https://dev.agent.example.com/health");
    assert.equal(storedPublications[0]?.invocation_endpoint, "https://dev.agent.example.com/invoke");
    assert.deepEqual(storedPublications[0]?.normalized_metadata, {
      capabilities: ["dev-card-capability", "shared-capability"],
      cardProfileId: defaultCardProfileId,
      displayName: "Case Resolver",
      invocationEndpoint: "https://dev.agent.example.com/invoke",
      summary: "Handles support case routing.",
      tags: ["dev-card-tag", "shared-tag"],
    });
    assert.equal(storedPublications[1]?.health_endpoint_url, "https://prod.agent.example.com/health");
    assert.equal(storedPublications[1]?.invocation_endpoint, "https://prod.agent.example.com/invoke");
    assert.deepEqual(storedPublications[1]?.normalized_metadata, {
      capabilities: ["prod-card-capability", "shared-capability"],
      cardProfileId: defaultCardProfileId,
      displayName: "Case Resolver",
      invocationEndpoint: "https://prod.agent.example.com/invoke",
      summary: "Handles support case routing.",
      tags: ["prod-card-tag", "shared-tag"],
    });
    assert.equal(storedPublications[1]?.raw_card, expectedProdRawCard);
  } finally {
    await context.close();
  }
});

test("publisher can omit cardProfileId and the tenant default profile is applied", async () => {
  // Arrange
  const context = await createDraftRegistrationApiContext({
    tenantDefaultCardProfileId: alternateCardProfileId,
  });
  const requestBody = createDraftRegistrationRequest({
    cardProfileId: undefined,
  });

  try {
    // Act
    const response = await requestJson<DraftAgentRegistrationResponse>(context, {
      body: requestBody,
      path: "/tenants/tenant-alpha/agents",
      subjectId: "publisher-alpha",
    });

    // Assert
    assert.equal(response.status, 201);

    const storedVersion = await context.db
      .selectFrom("agent_versions")
      .select("card_profile_id")
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", response.body.agentId)
      .where("version_id", "=", response.body.versionId)
      .executeTakeFirstOrThrow();
    const storedPublications = await context.db
      .selectFrom("environment_publications")
      .select(["environment_key", "normalized_metadata"])
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", response.body.agentId)
      .where("version_id", "=", response.body.versionId)
      .orderBy("environment_key")
      .execute();

    assert.equal(response.body.cardProfileId, alternateCardProfileId);
    assert.equal(storedVersion.card_profile_id, alternateCardProfileId);
    assert.equal(
      (storedPublications[0]?.normalized_metadata as Record<string, unknown>).cardProfileId,
      alternateCardProfileId,
    );
    assert.equal(
      (storedPublications[1]?.normalized_metadata as Record<string, unknown>).cardProfileId,
      alternateCardProfileId,
    );
  } finally {
    await context.close();
  }
});

test("publisher can create a new draft version and persist an immutable snapshot", async () => {
  // Arrange
  const context = await createDraftRegistrationApiContext();
  const initialRequest = createDraftRegistrationRequest();
  const initialResponse = await requestJson<DraftAgentRegistrationResponse>(context, {
    body: initialRequest,
    path: "/tenants/tenant-alpha/agents",
    subjectId: "publisher-alpha",
  });
  assert.equal(initialResponse.status, 201);

  const nextVersionRequest = createDraftRegistrationRequest({
    capabilities: ["shared-capability", "triage"],
    contextContract: [
      {
        description: "Selects the target client partition.",
        example: "client-456",
        key: "client_id",
        required: true,
        type: "string",
      },
      {
        description: "Includes optional escalation flags.",
        example: ["vip"],
        key: "labels",
        required: false,
        type: "array",
      },
    ],
    headerContract: [
      {
        description: "Passes the user id through to the downstream API.",
        name: "X-User-Id",
        required: true,
        source: "user.id",
      },
      {
        description: "Provides the caller's department to the downstream API.",
        name: "X-User-Department",
        required: false,
        source: "user.department",
      },
    ],
    publications: [
      {
        environmentKey: "dev",
        healthEndpointUrl: "https://dev-v2.agent.example.com/health",
        rawCard: createRawCard({
          capabilities: ["dev-v2-card-capability"],
          invocationEndpoint: "https://dev-v2.agent.example.com/invoke",
          tags: ["dev-v2-card-tag"],
        }),
      },
      {
        environmentKey: "staging",
        healthEndpointUrl: "https://staging.agent.example.com/health",
        invocationEndpoint: "https://staging.agent.example.com/invoke",
        rawCard: createRawCard({
          capabilities: ["staging-card-capability"],
          invocationEndpoint: undefined,
          tags: ["staging-card-tag"],
        }),
      },
    ],
    requiredRoles: ["case-manager"],
    requiredScopes: ["tickets.read", "tickets.write"],
    tags: ["shared-tag", "ops"],
    versionLabel: "2026.03.14",
  });

  try {
    // Act
    const response = await requestJson<DraftAgentRegistrationResponse>(context, {
      body: nextVersionRequest,
      path: `/tenants/tenant-alpha/agents/${initialResponse.body.agentId}/versions`,
      subjectId: "publisher-alpha",
    });
    const initialSnapshot = await loadStoredVersionSnapshot(
      context.db,
      "tenant-alpha",
      initialResponse.body.agentId,
      initialResponse.body.versionId,
    );
    const nextSnapshot = await loadStoredVersionSnapshot(
      context.db,
      "tenant-alpha",
      initialResponse.body.agentId,
      response.body.versionId,
    );

    // Assert
    assert.equal(response.status, 201);
    assert.equal(response.body.agentId, initialResponse.body.agentId);
    assert.equal(response.body.approvalState, "draft");
    assert.equal(response.body.cardProfileId, defaultCardProfileId);
    assert.equal(response.body.versionSequence, 2);
    assert.deepEqual(
      response.body.publications.map((publication) => publication.environmentKey).sort(),
      ["dev", "staging"],
    );

    assert.equal(nextSnapshot.version.approval_state, "draft");
    assert.deepEqual(nextSnapshot.version.capabilities, ["shared-capability", "triage"]);
    assert.equal(nextSnapshot.version.card_profile_id, defaultCardProfileId);
    assert.deepEqual(nextSnapshot.version.context_contract, nextVersionRequest.contextContract);
    assert.equal(nextSnapshot.version.display_name, "Case Resolver");
    assert.deepEqual(nextSnapshot.version.header_contract, nextVersionRequest.headerContract);
    assert.deepEqual(nextSnapshot.version.required_roles, ["case-manager"]);
    assert.deepEqual(nextSnapshot.version.required_scopes, ["tickets.read", "tickets.write"]);
    assert.equal(nextSnapshot.version.summary, "Handles support case routing.");
    assert.deepEqual(nextSnapshot.version.tags, ["shared-tag", "ops"]);
    assert.equal(nextSnapshot.version.version_id, response.body.versionId);
    assert.equal(nextSnapshot.version.version_label, "2026.03.14");
    assert.equal(nextSnapshot.version.version_sequence, 2);
    assert.deepEqual(
      nextSnapshot.publications.map((publication) => publication.environment_key),
      ["dev", "staging"],
    );
    assert.equal(
      nextSnapshot.publications[0]?.health_endpoint_url,
      "https://dev-v2.agent.example.com/health",
    );
    assert.equal(
      nextSnapshot.publications[0]?.invocation_endpoint,
      "https://dev-v2.agent.example.com/invoke",
    );
    assert.deepEqual(nextSnapshot.publications[0]?.normalized_metadata, {
      capabilities: ["dev-v2-card-capability", "shared-capability", "triage"],
      cardProfileId: defaultCardProfileId,
      displayName: "Case Resolver",
      invocationEndpoint: "https://dev-v2.agent.example.com/invoke",
      summary: "Handles support case routing.",
      tags: ["dev-v2-card-tag", "ops", "shared-tag"],
    });
    assert.equal(nextSnapshot.publications[0]?.raw_card, nextVersionRequest.publications?.[0]?.rawCard);
    assert.equal(
      nextSnapshot.publications[1]?.health_endpoint_url,
      "https://staging.agent.example.com/health",
    );
    assert.equal(
      nextSnapshot.publications[1]?.invocation_endpoint,
      "https://staging.agent.example.com/invoke",
    );
    assert.deepEqual(nextSnapshot.publications[1]?.normalized_metadata, {
      capabilities: ["shared-capability", "staging-card-capability", "triage"],
      cardProfileId: defaultCardProfileId,
      displayName: "Case Resolver",
      invocationEndpoint: "https://staging.agent.example.com/invoke",
      summary: "Handles support case routing.",
      tags: ["ops", "shared-tag", "staging-card-tag"],
    });
    assert.equal(nextSnapshot.publications[1]?.raw_card, nextVersionRequest.publications?.[1]?.rawCard);

    assert.equal(initialSnapshot.version.version_sequence, 1);
    assert.equal(initialSnapshot.version.approval_state, "draft");
    assert.deepEqual(initialSnapshot.version.capabilities, ["shared-capability"]);
    assert.equal(initialSnapshot.version.card_profile_id, defaultCardProfileId);
    assert.deepEqual(initialSnapshot.version.context_contract, initialRequest.contextContract);
    assert.equal(initialSnapshot.version.display_name, initialRequest.displayName);
    assert.deepEqual(initialSnapshot.version.header_contract, initialRequest.headerContract);
    assert.deepEqual(initialSnapshot.version.required_roles, ["support-agent"]);
    assert.deepEqual(initialSnapshot.version.required_scopes, ["tickets.read"]);
    assert.equal(initialSnapshot.version.summary, initialRequest.summary);
    assert.deepEqual(initialSnapshot.version.tags, ["shared-tag"]);
    assert.equal(initialSnapshot.version.version_id, initialResponse.body.versionId);
    assert.equal(initialSnapshot.version.version_label, "2026.03.13");
    assert.deepEqual(
      initialSnapshot.publications.map((publication) => publication.environment_key),
      ["dev", "prod"],
    );
    assert.equal(
      initialSnapshot.publications[0]?.health_endpoint_url,
      "https://dev.agent.example.com/health",
    );
    assert.equal(
      initialSnapshot.publications[0]?.invocation_endpoint,
      "https://dev.agent.example.com/invoke",
    );
    assert.deepEqual(initialSnapshot.publications[0]?.normalized_metadata, {
      capabilities: ["dev-card-capability", "shared-capability"],
      cardProfileId: defaultCardProfileId,
      displayName: "Case Resolver",
      invocationEndpoint: "https://dev.agent.example.com/invoke",
      summary: "Handles support case routing.",
      tags: ["dev-card-tag", "shared-tag"],
    });
    assert.equal(initialSnapshot.publications[0]?.raw_card, initialRequest.publications?.[0]?.rawCard);
    assert.equal(
      initialSnapshot.publications[1]?.health_endpoint_url,
      "https://prod.agent.example.com/health",
    );
    assert.equal(
      initialSnapshot.publications[1]?.invocation_endpoint,
      "https://prod.agent.example.com/invoke",
    );
    assert.deepEqual(initialSnapshot.publications[1]?.normalized_metadata, {
      capabilities: ["prod-card-capability", "shared-capability"],
      cardProfileId: defaultCardProfileId,
      displayName: "Case Resolver",
      invocationEndpoint: "https://prod.agent.example.com/invoke",
      summary: "Handles support case routing.",
      tags: ["prod-card-tag", "shared-tag"],
    });
    assert.equal(initialSnapshot.publications[1]?.raw_card, initialRequest.publications?.[1]?.rawCard);
  } finally {
    await context.close();
  }
});

test("creating draft versions concurrently allocates monotonically increasing version sequences per agent", async () => {
  // Arrange
  const context = await createDraftRegistrationApiContext();
  const createResponse = await requestJson<DraftAgentRegistrationResponse>(context, {
    body: createDraftRegistrationRequest(),
    path: "/tenants/tenant-alpha/agents",
    subjectId: "publisher-alpha",
  });
  assert.equal(createResponse.status, 201);
  const agentId = createResponse.body.agentId;

  try {
    const requests = Array.from({ length: 4 }, (_, index) =>
      requestJson<DraftAgentRegistrationResponse>(context, {
        body: createDraftRegistrationRequest({
          versionLabel: `2026.03.13-${index + 2}`,
        }),
        path: `/tenants/tenant-alpha/agents/${agentId}/versions`,
        subjectId: "publisher-alpha",
      }),
    );

    // Act
    const responses = await Promise.all(requests);
    const storedSequences = await listVersionSequences(context.db, "tenant-alpha", agentId);

    // Assert
    assert.deepEqual(
      responses.map((response) => response.status),
      [201, 201, 201, 201],
    );
    assert.deepEqual(
      responses.map((response) => response.body.versionSequence).sort((left, right) => left - right),
      [2, 3, 4, 5],
    );
    assert.deepEqual(storedSequences, [1, 2, 3, 4, 5]);
  } finally {
    await context.close();
  }
});

test("registration rejects unsupported card profiles", async () => {
  // Arrange
  const context = await createDraftRegistrationApiContext();
  const requestBody = createDraftRegistrationRequest({
    cardProfileId: "unsupported-profile",
  });

  try {
    // Act
    const response = await requestJson<ErrorResponseBody>(context, {
      body: requestBody,
      path: "/tenants/tenant-alpha/agents",
      subjectId: "publisher-alpha",
    });

    // Assert
    assert.equal(response.status, 400);
    assert.match(response.body.error.message, /unknown card profile/i);
  } finally {
    await context.close();
  }
});

test("registration rejects duplicate publication environments", async () => {
  // Arrange
  const context = await createDraftRegistrationApiContext();
  const requestBody = createDraftRegistrationRequest({
    publications: [
      {
        environmentKey: "dev",
        healthEndpointUrl: "https://dev.agent.example.com/health",
        rawCard: createRawCard({
          capabilities: ["dev-card-capability"],
          invocationEndpoint: "https://dev.agent.example.com/invoke",
        }),
      },
      {
        environmentKey: "dev",
        healthEndpointUrl: "https://prod.agent.example.com/health",
        rawCard: createRawCard({
          capabilities: ["prod-card-capability"],
          invocationEndpoint: "https://prod.agent.example.com/invoke",
        }),
      },
    ],
  });

  try {
    // Act
    const response = await requestJson<ErrorResponseBody>(context, {
      body: requestBody,
      path: "/tenants/tenant-alpha/agents",
      subjectId: "publisher-alpha",
    });

    // Assert
    assert.equal(response.status, 400);
    assert.match(response.body.error.message, /duplicate environment key/i);
  } finally {
    await context.close();
  }
});

test("registration rejects unknown tenant environments and empty publication sets", async () => {
  // Arrange
  const context = await createDraftRegistrationApiContext();
  const unknownEnvironmentRequest = createDraftRegistrationRequest({
    publications: [
      {
        environmentKey: "qa",
        healthEndpointUrl: "https://qa.agent.example.com/health",
        rawCard: createRawCard({
          invocationEndpoint: "https://qa.agent.example.com/invoke",
        }),
      },
    ],
  });
  const emptyPublicationsRequest = createDraftRegistrationRequest({
    publications: [],
  });

  try {
    // Act
    const unknownEnvironmentResponse = await requestJson<ErrorResponseBody>(context, {
      body: unknownEnvironmentRequest,
      path: "/tenants/tenant-alpha/agents",
      subjectId: "publisher-alpha",
    });
    const emptyPublicationsResponse = await requestJson<ErrorResponseBody>(context, {
      body: emptyPublicationsRequest,
      path: "/tenants/tenant-alpha/agents",
      subjectId: "publisher-alpha",
    });

    // Assert
    assert.equal(unknownEnvironmentResponse.status, 400);
    assert.match(unknownEnvironmentResponse.body.error.message, /unknown tenant environment/i);
    assert.equal(emptyPublicationsResponse.status, 400);
    assert.match(emptyPublicationsResponse.body.error.message, /at least one environment publication/i);
  } finally {
    await context.close();
  }
});

test("registration rejects malformed context contracts", async () => {
  // Arrange
  const context = await createDraftRegistrationApiContext();
  const requestBody = createDraftRegistrationRequest({
    contextContract: [
      {
        description: "Uses an unsupported type.",
        key: "client_id",
        required: true,
        type: "uuid",
      },
    ],
  });

  try {
    // Act
    const response = await requestJson<ErrorResponseBody>(context, {
      body: requestBody,
      path: "/tenants/tenant-alpha/agents",
      subjectId: "publisher-alpha",
    });

    // Assert
    assert.equal(response.status, 400);
    assert.match(response.body.error.message, /context contract/i);
  } finally {
    await context.close();
  }
});

test("registration rejects oversize cards and invalid raw cards", async () => {
  // Arrange
  const context = await createDraftRegistrationApiContext();
  const oversizeCardRequest = createDraftRegistrationRequest({
    publications: [
      {
        environmentKey: "dev",
        healthEndpointUrl: "https://dev.agent.example.com/health",
        rawCard: createRawCard({
          summary: "x".repeat(maxRawCardBytes + 1),
        }),
      },
    ],
  });
  const invalidCardRequest = createDraftRegistrationRequest({
    publications: [
      {
        environmentKey: "dev",
        healthEndpointUrl: "https://dev.agent.example.com/health",
        rawCard: "{this-is-not-json}",
      },
    ],
  });

  try {
    // Act
    const oversizeResponse = await requestJson<ErrorResponseBody>(context, {
      body: oversizeCardRequest,
      path: "/tenants/tenant-alpha/agents",
      subjectId: "publisher-alpha",
    });
    const invalidCardResponse = await requestJson<ErrorResponseBody>(context, {
      body: invalidCardRequest,
      path: "/tenants/tenant-alpha/agents",
      subjectId: "publisher-alpha",
    });

    // Assert
    assert.equal(oversizeResponse.status, 400);
    assert.match(oversizeResponse.body.error.message, /raw card exceeds/i);
    assert.equal(invalidCardResponse.status, 400);
    assert.match(invalidCardResponse.body.error.message, /raw card is not valid/i);
  } finally {
    await context.close();
  }
});

test("registration rejects malformed contracts, conflicting invocation overrides, and invalid health endpoints", async () => {
  // Arrange
  const context = await createDraftRegistrationApiContext();
  const invalidContractRequest = createDraftRegistrationRequest({
    headerContract: [
      {
        description: "Missing a source field.",
        name: "X-User-Id",
        required: true,
      },
    ],
  });
  const conflictingInvocationRequest = createDraftRegistrationRequest({
    publications: [
      {
        environmentKey: "dev",
        healthEndpointUrl: "https://dev.agent.example.com/health",
        invocationEndpoint: "https://override.agent.example.com/invoke",
        rawCard: createRawCard({
          invocationEndpoint: "https://dev.agent.example.com/invoke",
        }),
      },
    ],
  });
  const invalidHealthEndpointRequest = createDraftRegistrationRequest({
    publications: [
      {
        environmentKey: "dev",
        healthEndpointUrl: "http://dev.agent.example.com/health",
        rawCard: createRawCard({
          invocationEndpoint: "https://dev.agent.example.com/invoke",
        }),
      },
    ],
  });

  try {
    // Act
    const invalidContractResponse = await requestJson<ErrorResponseBody>(context, {
      body: invalidContractRequest,
      path: "/tenants/tenant-alpha/agents",
      subjectId: "publisher-alpha",
    });
    const conflictingInvocationResponse = await requestJson<ErrorResponseBody>(context, {
      body: conflictingInvocationRequest,
      path: "/tenants/tenant-alpha/agents",
      subjectId: "publisher-alpha",
    });
    const invalidHealthEndpointResponse = await requestJson<ErrorResponseBody>(context, {
      body: invalidHealthEndpointRequest,
      path: "/tenants/tenant-alpha/agents",
      subjectId: "publisher-alpha",
    });

    // Assert
    assert.equal(invalidContractResponse.status, 400);
    assert.match(invalidContractResponse.body.error.message, /header contract/i);
    assert.equal(conflictingInvocationResponse.status, 400);
    assert.match(conflictingInvocationResponse.body.error.message, /invocation endpoint/i);
    assert.equal(invalidHealthEndpointResponse.status, 400);
    assert.match(invalidHealthEndpointResponse.body.error.message, /health endpoint/i);
  } finally {
    await context.close();
  }
});

test("registration rejects normalized displayName and summary conflicts", async () => {
  // Arrange
  const context = await createDraftRegistrationApiContext();
  const displayNameConflictRequest = createDraftRegistrationRequest({
    displayName: "Shared Display Name",
    publications: [
      {
        environmentKey: "dev",
        healthEndpointUrl: "https://dev.agent.example.com/health",
        rawCard: createRawCard({
          invocationEndpoint: "https://dev.agent.example.com/invoke",
          name: "Card Display Name",
          summary: "Shared Summary",
        }),
      },
    ],
    summary: "Shared Summary",
  });
  const summaryConflictRequest = createDraftRegistrationRequest({
    displayName: "Shared Display Name",
    publications: [
      {
        environmentKey: "dev",
        healthEndpointUrl: "https://dev.agent.example.com/health",
        rawCard: createRawCard({
          invocationEndpoint: "https://dev.agent.example.com/invoke",
          name: "Shared Display Name",
          summary: "Card Summary",
        }),
      },
    ],
    summary: "Shared Summary",
  });

  try {
    // Act
    const displayNameConflictResponse = await requestJson<ErrorResponseBody>(context, {
      body: displayNameConflictRequest,
      path: "/tenants/tenant-alpha/agents",
      subjectId: "publisher-alpha",
    });
    const summaryConflictResponse = await requestJson<ErrorResponseBody>(context, {
      body: summaryConflictRequest,
      path: "/tenants/tenant-alpha/agents",
      subjectId: "publisher-alpha",
    });

    // Assert
    assert.equal(displayNameConflictResponse.status, 400);
    assert.match(displayNameConflictResponse.body.error.message, /displayname/i);
    assert.equal(summaryConflictResponse.status, 400);
    assert.match(summaryConflictResponse.body.error.message, /summary/i);
  } finally {
    await context.close();
  }
});
