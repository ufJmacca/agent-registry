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
}

interface JsonResponse<TBody> {
  body: TBody;
  status: number;
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

interface ErrorResponseBody {
  error: {
    code: string;
    message: string;
  };
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

interface VersionLifecycleResponse {
  activeVersionId: string | null;
  agentId: string;
  approvalState: "approved" | "pending_review" | "rejected";
  versionId: string;
}

interface AgentOverlayResponse {
  overlay: {
    agentId: string;
    deprecated: boolean;
    disabled: boolean;
    environmentKey: string | null;
    requiredRoles: string[];
    requiredScopes: string[];
  };
}

interface AgentAdminDetailResponse {
  activeVersion: {
    approvalState: string;
    publications: Array<{
      environmentKey: string;
      healthEndpointUrl: string;
      healthStatus: string | null;
      publicationId: string;
    }>;
    review: {
      approvedAt: string | null;
      approvedBy: string | null;
      rejectedAt: string | null;
      rejectedBy: string | null;
      rejectedReason: string | null;
      submittedAt: string | null;
      submittedBy: string | null;
    };
    versionId: string;
    versionSequence: number;
  } | null;
  activeVersionId: string | null;
  agentId: string;
  overlay: {
    agent: {
      deprecated: boolean;
      disabled: boolean;
      requiredRoles: string[];
      requiredScopes: string[];
    };
    environments: Array<{
      deprecated: boolean;
      disabled: boolean;
      environmentKey: string;
      requiredRoles: string[];
      requiredScopes: string[];
    }>;
  };
  versions: Array<{
    approvalState: string;
    versionId: string;
    versionSequence: number;
  }>;
}

interface VersionAdminDetailResponse {
  active: boolean;
  agentId: string;
  approvalState: string;
  cardProfileId: string;
  contextContract: unknown[];
  displayName: string;
  headerContract: unknown[];
  publications: Array<{
    environmentKey: string;
    healthEndpointUrl: string;
    healthStatus: string | null;
    invocationEndpoint: string | null;
    normalizedMetadata: unknown;
    publicationId: string;
    rawCard: string;
  }>;
  requiredRoles: string[];
  requiredScopes: string[];
  review: {
    approvedAt: string | null;
    approvedBy: string | null;
    rejectedAt: string | null;
    rejectedBy: string | null;
    rejectedReason: string | null;
    submittedAt: string | null;
    submittedBy: string | null;
  };
  summary: string;
  tags: string[];
  versionId: string;
  versionLabel: string;
  versionSequence: number;
}

interface PublicationHealthDetailResponse {
  current: {
    consecutiveFailures: number;
    healthStatus: "degraded" | "healthy" | "unknown" | "unreachable";
    lastCheckedAt: string | null;
    lastError: string | null;
    lastSuccessAt: string | null;
    recentFailures: number;
  };
  environmentKey: string;
  history: Array<{
    checkedAt: string;
    error: string | null;
    ok: boolean;
    statusCode: number | null;
  }>;
  publicationId: string;
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

async function createReviewApiContext(
  options: {
    allowPrivateTargets?: boolean;
    deploymentMode?: "hosted" | "self-hosted";
    resolveProbeHostname?: (hostname: string) => Promise<string[]>;
  } = {},
): Promise<ApiTestContext> {
  const database = await createFreshRegistryDatabase();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-registry-review-api-"));
  const bootstrapPath = path.join(tempDir, "bootstrap.yaml");
  const deploymentMode = options.deploymentMode ?? "hosted";

  try {
    await writeFile(
      bootstrapPath,
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
        "",
      ].join("\n"),
      "utf8",
    );

    const config = loadRegistryConfig({
      DATABASE_URL: database.databaseUrl,
      DEPLOYMENT_MODE: deploymentMode,
      HEALTH_PROBE_ALLOW_PRIVATE_TARGETS: options.allowPrivateTargets ? "true" : "false",
      HOSTED_BOOTSTRAP_FILE: deploymentMode === "hosted" ? bootstrapPath : undefined,
      SELF_HOSTED_BOOTSTRAP_FILE: deploymentMode === "self-hosted" ? bootstrapPath : undefined,
    });

    await bootstrapFromConfig(config, new KyselyBootstrapRepository(database.db));

    const server = http.createServer(
      createApiRequestListener({
        config,
        db: database.db,
        reviewServiceOptions: {
          resolveProbeHostname: options.resolveProbeHostname,
        },
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
        rawCard: createRawCard({
          capabilities: ["prod-card-capability"],
          invocationEndpoint: "https://prod.agent.example.com/invoke",
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

async function createDraftVersion(
  context: ApiTestContext,
  overrides: Record<string, unknown> = {},
): Promise<DraftAgentRegistrationResponse> {
  const response = await requestJson<DraftAgentRegistrationResponse>(context, {
    body: createDraftRegistrationRequest(overrides),
    path: "/tenants/tenant-alpha/agents",
    subjectId: "publisher-alpha",
  });

  assert.equal(response.status, 201);
  return response.body;
}

async function submitVersion(
  context: ApiTestContext,
  agentId: string,
  versionId: string,
): Promise<JsonResponse<VersionLifecycleResponse | ErrorResponseBody>> {
  return requestJson<VersionLifecycleResponse | ErrorResponseBody>(context, {
    path: `/tenants/tenant-alpha/agents/${agentId}/versions/${versionId}:submit`,
    subjectId: "publisher-alpha",
  });
}

async function approveVersion(
  context: ApiTestContext,
  agentId: string,
  versionId: string,
): Promise<JsonResponse<VersionLifecycleResponse | ErrorResponseBody>> {
  return requestJson<VersionLifecycleResponse | ErrorResponseBody>(context, {
    path: `/tenants/tenant-alpha/agents/${agentId}/versions/${versionId}:approve`,
    subjectId: "admin-alpha",
  });
}

async function seedPendingReviewVersion(
  context: ApiTestContext,
  input: {
    agentId: string;
    environmentKey?: string;
    healthEndpointUrl: string;
    publicationId: string;
    versionId: string;
  },
): Promise<void> {
  await context.db
    .insertInto("agents")
    .values({
      active_version_id: null,
      agent_id: input.agentId,
      display_name: "Seeded Case Resolver",
      summary: "Seeded summary",
      tenant_id: "tenant-alpha",
    })
    .execute();

  await context.db
    .insertInto("agent_versions")
    .values({
      agent_id: input.agentId,
      approval_state: "pending_review",
      capabilities: ["search"],
      card_profile_id: "a2a-default",
      context_contract: [],
      display_name: "Seeded Case Resolver",
      header_contract: [],
      required_roles: [],
      required_scopes: [],
      submitted_at: "2026-03-13T00:00:00.000Z",
      submitted_by: "publisher-alpha",
      summary: "Seeded summary",
      tags: ["seeded"],
      tenant_id: "tenant-alpha",
      version_id: input.versionId,
      version_label: input.versionId,
      version_sequence: 1,
    })
    .execute();

  await context.db
    .insertInto("environment_publications")
    .values({
      agent_id: input.agentId,
      environment_key: input.environmentKey ?? "dev",
      health_endpoint_url: input.healthEndpointUrl,
      invocation_endpoint: "https://seeded.agent.example.com/invoke",
      normalized_metadata: {
        displayName: "Seeded Case Resolver",
      },
      publication_id: input.publicationId,
      raw_card: createRawCard({
        invocationEndpoint: "https://seeded.agent.example.com/invoke",
      }),
      tenant_id: "tenant-alpha",
      version_id: input.versionId,
    })
    .execute();
}

async function rejectVersion(
  context: ApiTestContext,
  agentId: string,
  versionId: string,
  reason = "Missing security review evidence.",
): Promise<JsonResponse<VersionLifecycleResponse | ErrorResponseBody>> {
  return requestJson<VersionLifecycleResponse | ErrorResponseBody>(context, {
    body: { reason },
    path: `/tenants/tenant-alpha/agents/${agentId}/versions/${versionId}:reject`,
    subjectId: "admin-alpha",
  });
}

test("submit, approve, and reject enforce lifecycle transitions and record reviewer metadata", async () => {
  // Arrange
  const context = await createReviewApiContext();

  try {
    const firstDraft = await createDraftVersion(context);

    // Act
    const rejectDraftResponse = await rejectVersion(context, firstDraft.agentId, firstDraft.versionId);
    const submitResponse = await submitVersion(context, firstDraft.agentId, firstDraft.versionId);
    const resubmitResponse = await submitVersion(context, firstDraft.agentId, firstDraft.versionId);
    const approveResponse = await approveVersion(context, firstDraft.agentId, firstDraft.versionId);
    const reapproveResponse = await approveVersion(context, firstDraft.agentId, firstDraft.versionId);
    const secondDraft = await createDraftVersion(context, {
      versionLabel: "2026.03.14",
    });
    const secondSubmitResponse = await submitVersion(context, secondDraft.agentId, secondDraft.versionId);
    const rejectResponse = await rejectVersion(
      context,
      secondDraft.agentId,
      secondDraft.versionId,
      "Missing threat model.",
    );
    const rerejectResponse = await rejectVersion(context, secondDraft.agentId, secondDraft.versionId);
    const firstVersion = await context.db
      .selectFrom("agent_versions")
      .select([
        "approval_state",
        "approved_at",
        "approved_by",
        "rejected_at",
        "rejected_by",
        "rejected_reason",
        "submitted_at",
        "submitted_by",
      ])
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", firstDraft.agentId)
      .where("version_id", "=", firstDraft.versionId)
      .executeTakeFirstOrThrow();
    const secondVersion = await context.db
      .selectFrom("agent_versions")
      .select([
        "approval_state",
        "approved_at",
        "approved_by",
        "rejected_at",
        "rejected_by",
        "rejected_reason",
        "submitted_at",
        "submitted_by",
      ])
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", secondDraft.agentId)
      .where("version_id", "=", secondDraft.versionId)
      .executeTakeFirstOrThrow();

    // Assert
    assert.equal(rejectDraftResponse.status, 409);
    assert.deepEqual(rejectDraftResponse.body, {
      error: {
        code: "invalid_lifecycle_transition",
        message: "Only pending_review versions can be rejected.",
      },
    });
    assert.equal(submitResponse.status, 200);
    assert.equal((submitResponse.body as VersionLifecycleResponse).approvalState, "pending_review");
    assert.equal(resubmitResponse.status, 409);
    assert.equal(
      (resubmitResponse.body as ErrorResponseBody).error.code,
      "invalid_lifecycle_transition",
    );
    assert.equal(approveResponse.status, 200);
    assert.equal((approveResponse.body as VersionLifecycleResponse).approvalState, "approved");
    assert.equal(reapproveResponse.status, 409);
    assert.equal(
      (reapproveResponse.body as ErrorResponseBody).error.code,
      "invalid_lifecycle_transition",
    );
    assert.equal(secondSubmitResponse.status, 200);
    assert.equal(rejectResponse.status, 200);
    assert.equal((rejectResponse.body as VersionLifecycleResponse).approvalState, "rejected");
    assert.equal(rerejectResponse.status, 409);
    assert.equal(firstVersion.approval_state, "approved");
    assert.equal(firstVersion.submitted_by, "publisher-alpha");
    assert.equal(firstVersion.approved_by, "admin-alpha");
    assert.notEqual(firstVersion.submitted_at, null);
    assert.notEqual(firstVersion.approved_at, null);
    assert.equal(firstVersion.rejected_reason, null);
    assert.equal(firstVersion.rejected_by, null);
    assert.equal(secondVersion.approval_state, "rejected");
    assert.equal(secondVersion.submitted_by, "publisher-alpha");
    assert.equal(secondVersion.rejected_by, "admin-alpha");
    assert.equal(secondVersion.rejected_reason, "Missing threat model.");
    assert.notEqual(secondVersion.submitted_at, null);
    assert.notEqual(secondVersion.rejected_at, null);
    assert.equal(secondVersion.approved_by, null);
    assert.equal(secondVersion.approved_at, null);
  } finally {
    await context.close();
  }
});

test("approvals update the active version pointer only for the highest approved sequence", async () => {
  // Arrange
  const context = await createReviewApiContext();

  try {
    const firstDraft = await createDraftVersion(context, {
      versionLabel: "2026.03.13",
    });

    // Act
    const firstSubmit = await submitVersion(context, firstDraft.agentId, firstDraft.versionId);
    const firstApprove = await approveVersion(context, firstDraft.agentId, firstDraft.versionId);
    const secondDraftResponse = await requestJson<DraftAgentRegistrationResponse>(context, {
      body: createDraftRegistrationRequest({
        versionLabel: "2026.03.14",
      }),
      path: `/tenants/tenant-alpha/agents/${firstDraft.agentId}/versions`,
      subjectId: "publisher-alpha",
    });
    const secondSubmit = await submitVersion(
      context,
      firstDraft.agentId,
      secondDraftResponse.body.versionId,
    );
    const storedAgentAfterSecondSubmit = await context.db
      .selectFrom("agents")
      .select("active_version_id")
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", firstDraft.agentId)
      .executeTakeFirstOrThrow();
    const agentDetailAfterSecondSubmit = await requestJson<AgentAdminDetailResponse>(context, {
      method: "GET",
      path: `/tenants/tenant-alpha/agents/${firstDraft.agentId}`,
      subjectId: "admin-alpha",
    });

    // Assert
    assert.equal(firstSubmit.status, 200);
    assert.equal(firstApprove.status, 200);
    assert.equal(secondSubmit.status, 200);
    assert.equal(
      (secondSubmit.body as VersionLifecycleResponse).activeVersionId,
      firstDraft.versionId,
    );
    assert.equal(storedAgentAfterSecondSubmit.active_version_id, firstDraft.versionId);
    assert.equal(agentDetailAfterSecondSubmit.status, 200);
    assert.equal(agentDetailAfterSecondSubmit.body.activeVersionId, firstDraft.versionId);
    assert.equal(agentDetailAfterSecondSubmit.body.activeVersion?.versionId, firstDraft.versionId);

    // Act
    const thirdDraftResponse = await requestJson<DraftAgentRegistrationResponse>(context, {
      body: createDraftRegistrationRequest({
        versionLabel: "2026.03.15",
      }),
      path: `/tenants/tenant-alpha/agents/${firstDraft.agentId}/versions`,
      subjectId: "publisher-alpha",
    });
    const thirdSubmit = await submitVersion(context, firstDraft.agentId, thirdDraftResponse.body.versionId);
    const thirdApprove = await approveVersion(
      context,
      firstDraft.agentId,
      thirdDraftResponse.body.versionId,
    );
    const secondApprove = await approveVersion(
      context,
      firstDraft.agentId,
      secondDraftResponse.body.versionId,
    );
    const fourthDraftResponse = await requestJson<DraftAgentRegistrationResponse>(context, {
      body: createDraftRegistrationRequest({
        versionLabel: "2026.03.16",
      }),
      path: `/tenants/tenant-alpha/agents/${firstDraft.agentId}/versions`,
      subjectId: "publisher-alpha",
    });
    const fourthSubmit = await submitVersion(
      context,
      firstDraft.agentId,
      fourthDraftResponse.body.versionId,
    );
    const fourthReject = await rejectVersion(
      context,
      firstDraft.agentId,
      fourthDraftResponse.body.versionId,
      "QA sign-off missing.",
    );
    const storedAgent = await context.db
      .selectFrom("agents")
      .select("active_version_id")
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", firstDraft.agentId)
      .executeTakeFirstOrThrow();
    const agentDetail = await requestJson<AgentAdminDetailResponse>(context, {
      method: "GET",
      path: `/tenants/tenant-alpha/agents/${firstDraft.agentId}`,
      subjectId: "admin-alpha",
    });

    // Assert
    assert.equal(thirdSubmit.status, 200);
    assert.equal(thirdApprove.status, 200);
    assert.equal(secondApprove.status, 200);
    assert.equal(fourthSubmit.status, 200);
    assert.equal(fourthReject.status, 200);
    assert.equal(storedAgent.active_version_id, thirdDraftResponse.body.versionId);
    assert.equal(agentDetail.status, 200);
    assert.equal(agentDetail.body.activeVersionId, thirdDraftResponse.body.versionId);
    assert.deepEqual(
      agentDetail.body.versions.map((version) => ({
        approvalState: version.approvalState,
        versionId: version.versionId,
        versionSequence: version.versionSequence,
      })),
      [
        {
          approvalState: "approved",
          versionId: firstDraft.versionId,
          versionSequence: 1,
        },
        {
          approvalState: "approved",
          versionId: secondDraftResponse.body.versionId,
          versionSequence: 2,
        },
        {
          approvalState: "approved",
          versionId: thirdDraftResponse.body.versionId,
          versionSequence: 3,
        },
        {
          approvalState: "rejected",
          versionId: fourthDraftResponse.body.versionId,
          versionSequence: 4,
        },
      ],
    );
  } finally {
    await context.close();
  }
});

test("overlay endpoints persist separate agent and environment overlays and admin detail keeps version snapshots immutable", async () => {
  // Arrange
  const context = await createReviewApiContext();
  const draft = await createDraftVersion(context);
  await submitVersion(context, draft.agentId, draft.versionId);
  await approveVersion(context, draft.agentId, draft.versionId);
  const rejectedDraftResponse = await requestJson<DraftAgentRegistrationResponse>(context, {
    body: createDraftRegistrationRequest({
      versionLabel: "2026.03.14",
    }),
    path: `/tenants/tenant-alpha/agents/${draft.agentId}/versions`,
    subjectId: "publisher-alpha",
  });
  await submitVersion(context, draft.agentId, rejectedDraftResponse.body.versionId);
  const rejectedReason = "Missing incident response approval.";
  await rejectVersion(
    context,
    draft.agentId,
    rejectedDraftResponse.body.versionId,
    rejectedReason,
  );

  try {
    // Act
    const agentDisable = await requestJson<AgentOverlayResponse>(context, {
      path: `/tenants/tenant-alpha/agents/${draft.agentId}:disable`,
      subjectId: "admin-alpha",
    });
    const agentDeprecate = await requestJson<AgentOverlayResponse>(context, {
      path: `/tenants/tenant-alpha/agents/${draft.agentId}:deprecate`,
      subjectId: "admin-alpha",
    });
    const envDisable = await requestJson<AgentOverlayResponse>(context, {
      path: `/tenants/tenant-alpha/agents/${draft.agentId}/environments/prod:disable`,
      subjectId: "admin-alpha",
    });
    const envDeprecate = await requestJson<AgentOverlayResponse>(context, {
      path: `/tenants/tenant-alpha/agents/${draft.agentId}/environments/prod:deprecate`,
      subjectId: "admin-alpha",
    });
    const overlayRows = await context.db
      .selectFrom("tenant_policy_overlays")
      .select([
        "deprecated",
        "disabled",
        "environment_key",
        "required_roles",
        "required_scopes",
      ])
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", draft.agentId)
      .orderBy("environment_key")
      .execute();
    const agentRecord = await context.db
      .selectFrom("agents")
      .select(["deprecated", "disabled"])
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", draft.agentId)
      .executeTakeFirstOrThrow();
    const agentDetail = await requestJson<AgentAdminDetailResponse>(context, {
      method: "GET",
      path: `/tenants/tenant-alpha/agents/${draft.agentId}`,
      subjectId: "admin-alpha",
    });
    const versionDetail = await requestJson<VersionAdminDetailResponse>(context, {
      method: "GET",
      path: `/tenants/tenant-alpha/agents/${draft.agentId}/versions/${draft.versionId}`,
      subjectId: "admin-alpha",
    });
    const rejectedVersionDetail = await requestJson<VersionAdminDetailResponse>(context, {
      method: "GET",
      path: `/tenants/tenant-alpha/agents/${draft.agentId}/versions/${rejectedDraftResponse.body.versionId}`,
      subjectId: "admin-alpha",
    });

    // Assert
    assert.equal(agentDisable.status, 200);
    assert.equal(agentDeprecate.status, 200);
    assert.equal(envDisable.status, 200);
    assert.equal(envDeprecate.status, 200);
    assert.deepEqual(
      overlayRows
        .map((overlay) => ({
          deprecated: overlay.deprecated,
          disabled: overlay.disabled,
          environment_key: overlay.environment_key,
          required_roles: overlay.required_roles,
          required_scopes: overlay.required_scopes,
        }))
        .sort((left, right) => (left.environment_key ?? "").localeCompare(right.environment_key ?? "")),
      [
        {
          deprecated: true,
          disabled: true,
          environment_key: null,
          required_roles: [],
          required_scopes: [],
        },
        {
          deprecated: true,
          disabled: true,
          environment_key: "prod",
          required_roles: [],
          required_scopes: [],
        },
      ],
    );
    assert.deepEqual(agentRecord, {
      deprecated: false,
      disabled: false,
    });
    assert.equal(agentDetail.status, 200);
    assert.equal(agentDetail.body.activeVersionId, draft.versionId);
    assert.deepEqual(agentDetail.body.overlay, {
      agent: {
        deprecated: true,
        disabled: true,
        requiredRoles: [],
        requiredScopes: [],
      },
      environments: [
        {
          deprecated: true,
          disabled: true,
          environmentKey: "prod",
          requiredRoles: [],
          requiredScopes: [],
        },
      ],
    });
    assert.deepEqual(
      agentDetail.body.activeVersion?.publications.map((publication) => ({
        environmentKey: publication.environmentKey,
        healthStatus: publication.healthStatus,
      })),
      [
        {
          environmentKey: "dev",
          healthStatus: "unknown",
        },
        {
          environmentKey: "prod",
          healthStatus: "unknown",
        },
      ],
    );
    assert.equal(versionDetail.status, 200);
    assert.equal(versionDetail.body.active, true);
    assert.equal(versionDetail.body.approvalState, "approved");
    assert.deepEqual(versionDetail.body.requiredRoles, ["support-agent"]);
    assert.deepEqual(versionDetail.body.requiredScopes, ["tickets.read"]);
    assert.equal(versionDetail.body.review.approvedBy, "admin-alpha");
    assert.equal(versionDetail.body.review.rejectedReason, null);
    assert.equal(rejectedVersionDetail.status, 200);
    assert.equal(rejectedVersionDetail.body.active, false);
    assert.equal(rejectedVersionDetail.body.approvalState, "rejected");
    assert.equal(rejectedVersionDetail.body.review.approvedBy, null);
    assert.equal(rejectedVersionDetail.body.review.rejectedBy, "admin-alpha");
    assert.equal(rejectedVersionDetail.body.review.rejectedReason, rejectedReason);
    assert.notEqual(rejectedVersionDetail.body.review.rejectedAt, null);
    assert.deepEqual(
      versionDetail.body.publications.map((publication) => ({
        environmentKey: publication.environmentKey,
        healthStatus: publication.healthStatus,
        rawCard: publication.rawCard,
      })),
      [
        {
          environmentKey: "dev",
          healthStatus: "unknown",
          rawCard: createDraftRegistrationRequest().publications[0].rawCard,
        },
        {
          environmentKey: "prod",
          healthStatus: "unknown",
          rawCard: createDraftRegistrationRequest().publications[1].rawCard,
        },
      ],
    );
  } finally {
    await context.close();
  }
});

test("approval rejects hosted private probe targets and initializes unknown health when self-hosted private probing is allowed", async () => {
  // Arrange
  const hostedContext = await createReviewApiContext();
  const selfHostedContext = await createReviewApiContext({
    allowPrivateTargets: true,
    deploymentMode: "self-hosted",
  });

  try {
    const hostedDraft = await createDraftVersion(hostedContext, {
      publications: [
        {
          environmentKey: "dev",
          healthEndpointUrl: "https://127.0.0.1/health",
          rawCard: createRawCard({
            invocationEndpoint: "https://dev.agent.example.com/invoke",
          }),
        },
      ],
    });
    await submitVersion(hostedContext, hostedDraft.agentId, hostedDraft.versionId);

    const selfHostedDraft = await createDraftVersion(selfHostedContext, {
      publications: [
        {
          environmentKey: "dev",
          healthEndpointUrl: "https://127.0.0.1/health",
          rawCard: createRawCard({
            invocationEndpoint: "https://dev.agent.example.com/invoke",
          }),
        },
      ],
    });
    await submitVersion(selfHostedContext, selfHostedDraft.agentId, selfHostedDraft.versionId);

    // Act
    const hostedApprove = await approveVersion(
      hostedContext,
      hostedDraft.agentId,
      hostedDraft.versionId,
    );
    const selfHostedApprove = await approveVersion(
      selfHostedContext,
      selfHostedDraft.agentId,
      selfHostedDraft.versionId,
    );
    const hostedVersion = await hostedContext.db
      .selectFrom("agent_versions")
      .select("approval_state")
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", hostedDraft.agentId)
      .where("version_id", "=", hostedDraft.versionId)
      .executeTakeFirstOrThrow();
    const hostedHealthRows = await hostedContext.db
      .selectFrom("publication_health")
      .innerJoin(
        "environment_publications",
        "environment_publications.publication_id",
        "publication_health.publication_id",
      )
      .select("publication_health.health_status")
      .where("environment_publications.tenant_id", "=", "tenant-alpha")
      .where("environment_publications.agent_id", "=", hostedDraft.agentId)
      .where("environment_publications.version_id", "=", hostedDraft.versionId)
      .execute();
    const selfHostedHealthRows = await selfHostedContext.db
      .selectFrom("publication_health")
      .innerJoin(
        "environment_publications",
        "environment_publications.publication_id",
        "publication_health.publication_id",
      )
      .select("publication_health.health_status")
      .where("environment_publications.tenant_id", "=", "tenant-alpha")
      .where("environment_publications.agent_id", "=", selfHostedDraft.agentId)
      .where("environment_publications.version_id", "=", selfHostedDraft.versionId)
      .execute();

    // Assert
    assert.equal(hostedApprove.status, 400);
    assert.deepEqual(hostedApprove.body, {
      error: {
        code: "invalid_probe_target",
        message: "Hosted deployments cannot probe private or loopback health endpoints.",
      },
    });
    assert.equal(hostedVersion.approval_state, "pending_review");
    assert.deepEqual(hostedHealthRows, []);
    assert.equal(selfHostedApprove.status, 200);
    assert.deepEqual(selfHostedHealthRows, [
      {
        health_status: "unknown",
      },
    ]);
  } finally {
    await hostedContext.close();
    await selfHostedContext.close();
  }
});

test("approval rejects seeded hosted non-HTTPS probe targets before transitioning a pending version", async () => {
  // Arrange
  const context = await createReviewApiContext();
  const agentId = "agent-http-policy";
  const versionId = "version-http-policy";
  const healthEndpointUrl = "http://public-probe.example.test/health";

  try {
    await seedPendingReviewVersion(context, {
      agentId,
      healthEndpointUrl,
      publicationId: "publication-http-policy",
      versionId,
    });

    // Act
    const approveResponse = await approveVersion(context, agentId, versionId);
    const storedVersion = await context.db
      .selectFrom("agent_versions")
      .select("approval_state")
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", agentId)
      .where("version_id", "=", versionId)
      .executeTakeFirstOrThrow();
    const storedHealthRows = await context.db
      .selectFrom("publication_health")
      .innerJoin(
        "environment_publications",
        "environment_publications.publication_id",
        "publication_health.publication_id",
      )
      .select("publication_health.health_status")
      .where("environment_publications.tenant_id", "=", "tenant-alpha")
      .where("environment_publications.agent_id", "=", agentId)
      .where("environment_publications.version_id", "=", versionId)
      .execute();

    // Assert
    assert.equal(approveResponse.status, 400);
    assert.deepEqual(approveResponse.body, {
      error: {
        code: "invalid_probe_target",
        message: `Hosted deployments require HTTPS health endpoints; received '${healthEndpointUrl}'.`,
      },
    });
    assert.equal(storedVersion.approval_state, "pending_review");
    assert.deepEqual(storedHealthRows, []);
  } finally {
    await context.close();
  }
});

test("approval rejects hosted probe targets whose hostname resolves to a private address", async () => {
  // Arrange
  const resolveProbeHostname = async (hostname: string): Promise<string[]> => {
    if (hostname === "loopback-probe.example.test") {
      return ["127.0.0.1"];
    }

    return [];
  };
  const hostedContext = await createReviewApiContext({
    resolveProbeHostname,
  });
  const selfHostedContext = await createReviewApiContext({
    allowPrivateTargets: true,
    deploymentMode: "self-hosted",
    resolveProbeHostname,
  });

  try {
    const hostedDraft = await createDraftVersion(hostedContext, {
      publications: [
        {
          environmentKey: "dev",
          healthEndpointUrl: "https://loopback-probe.example.test/health",
          rawCard: createRawCard({
            invocationEndpoint: "https://dev.agent.example.com/invoke",
          }),
        },
      ],
    });
    await submitVersion(hostedContext, hostedDraft.agentId, hostedDraft.versionId);

    const selfHostedDraft = await createDraftVersion(selfHostedContext, {
      publications: [
        {
          environmentKey: "dev",
          healthEndpointUrl: "https://loopback-probe.example.test/health",
          rawCard: createRawCard({
            invocationEndpoint: "https://dev.agent.example.com/invoke",
          }),
        },
      ],
    });
    await submitVersion(selfHostedContext, selfHostedDraft.agentId, selfHostedDraft.versionId);

    // Act
    const hostedApprove = await approveVersion(
      hostedContext,
      hostedDraft.agentId,
      hostedDraft.versionId,
    );
    const selfHostedApprove = await approveVersion(
      selfHostedContext,
      selfHostedDraft.agentId,
      selfHostedDraft.versionId,
    );
    const hostedVersion = await hostedContext.db
      .selectFrom("agent_versions")
      .select("approval_state")
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", hostedDraft.agentId)
      .where("version_id", "=", hostedDraft.versionId)
      .executeTakeFirstOrThrow();
    const hostedHealthRows = await hostedContext.db
      .selectFrom("publication_health")
      .innerJoin(
        "environment_publications",
        "environment_publications.publication_id",
        "publication_health.publication_id",
      )
      .select("publication_health.health_status")
      .where("environment_publications.tenant_id", "=", "tenant-alpha")
      .where("environment_publications.agent_id", "=", hostedDraft.agentId)
      .where("environment_publications.version_id", "=", hostedDraft.versionId)
      .execute();
    const selfHostedHealthRows = await selfHostedContext.db
      .selectFrom("publication_health")
      .innerJoin(
        "environment_publications",
        "environment_publications.publication_id",
        "publication_health.publication_id",
      )
      .select("publication_health.health_status")
      .where("environment_publications.tenant_id", "=", "tenant-alpha")
      .where("environment_publications.agent_id", "=", selfHostedDraft.agentId)
      .where("environment_publications.version_id", "=", selfHostedDraft.versionId)
      .execute();

    // Assert
    assert.equal(hostedApprove.status, 400);
    assert.deepEqual(hostedApprove.body, {
      error: {
        code: "invalid_probe_target",
        message: "Hosted deployments cannot probe private or loopback health endpoints.",
      },
    });
    assert.equal(hostedVersion.approval_state, "pending_review");
    assert.deepEqual(hostedHealthRows, []);
    assert.equal(selfHostedApprove.status, 200);
    assert.deepEqual(selfHostedHealthRows, [
      {
        health_status: "unknown",
      },
    ]);
  } finally {
    await hostedContext.close();
    await selfHostedContext.close();
  }
});

test("approved publication health endpoint returns current status and recent probe history", async () => {
  // Arrange
  const context = await createReviewApiContext();

  try {
    const draft = await createDraftVersion(context, {
      publications: [
        {
          environmentKey: "dev",
          healthEndpointUrl: "https://dev.agent.example.com/health",
          rawCard: createRawCard({
            invocationEndpoint: "https://dev.agent.example.com/invoke",
          }),
        },
      ],
    });
    await submitVersion(context, draft.agentId, draft.versionId);
    await approveVersion(context, draft.agentId, draft.versionId);

    const publication = await context.db
      .selectFrom("environment_publications")
      .select("publication_id")
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", draft.agentId)
      .where("version_id", "=", draft.versionId)
      .where("environment_key", "=", "dev")
      .executeTakeFirstOrThrow();

    await context.db
      .updateTable("publication_health")
      .set({
        consecutive_failures: 1,
        health_status: "degraded",
        last_checked_at: "2026-03-13T00:02:00.000Z",
        last_error: "received 503 from health endpoint",
        last_success_at: "2026-03-13T00:01:00.000Z",
        recent_failures: 1,
      })
      .where("publication_id", "=", publication.publication_id)
      .execute();
    await context.db
      .insertInto("publication_probe_history")
      .values([
        {
          checked_at: "2026-03-13T00:02:00.000Z",
          error: "received 503 from health endpoint",
          ok: false,
          publication_id: publication.publication_id,
          status_code: 503,
        },
        {
          checked_at: "2026-03-13T00:01:00.000Z",
          error: null,
          ok: true,
          publication_id: publication.publication_id,
          status_code: 204,
        },
        {
          checked_at: "2026-03-13T00:00:00.000Z",
          error: null,
          ok: true,
          publication_id: publication.publication_id,
          status_code: 200,
        },
      ])
      .execute();

    // Act
    const response = await requestJson<PublicationHealthDetailResponse>(context, {
      method: "GET",
      path: `/tenants/tenant-alpha/agents/${draft.agentId}/versions/${draft.versionId}/environments/dev/health`,
      subjectId: "admin-alpha",
    });

    // Assert
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      current: {
        consecutiveFailures: 1,
        healthStatus: "degraded",
        lastCheckedAt: "2026-03-13T00:02:00.000Z",
        lastError: "received 503 from health endpoint",
        lastSuccessAt: "2026-03-13T00:01:00.000Z",
        recentFailures: 1,
      },
      environmentKey: "dev",
      history: [
        {
          checkedAt: "2026-03-13T00:02:00.000Z",
          error: "received 503 from health endpoint",
          ok: false,
          statusCode: 503,
        },
        {
          checkedAt: "2026-03-13T00:01:00.000Z",
          error: null,
          ok: true,
          statusCode: 204,
        },
        {
          checkedAt: "2026-03-13T00:00:00.000Z",
          error: null,
          ok: true,
          statusCode: 200,
        },
      ],
      publicationId: publication.publication_id,
    });
  } finally {
    await context.close();
  }
});

test("publication health endpoint returns 404 for unapproved versions", async () => {
  // Arrange
  const context = await createReviewApiContext();

  try {
    const draft = await createDraftVersion(context, {
      publications: [
        {
          environmentKey: "dev",
          healthEndpointUrl: "https://dev.agent.example.com/health",
          rawCard: createRawCard({
            invocationEndpoint: "https://dev.agent.example.com/invoke",
          }),
        },
      ],
    });

    // Act
    const response = await requestJson<ErrorResponseBody>(context, {
      method: "GET",
      path: `/tenants/tenant-alpha/agents/${draft.agentId}/versions/${draft.versionId}/environments/dev/health`,
      subjectId: "admin-alpha",
    });

    // Assert
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      error: {
        code: "publication_health_not_found",
        message:
          `Approved publication health was not found for tenant 'tenant-alpha', agent '${draft.agentId}', version '${draft.versionId}', environment 'dev'.`,
      },
    });
  } finally {
    await context.close();
  }
});
