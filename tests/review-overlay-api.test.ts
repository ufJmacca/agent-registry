import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import pg from "pg";

import { bootstrapFromConfig } from "../apps/api/src/bootstrap/index.ts";
import { createApiRequestListener } from "../apps/api/src/http.ts";
import {
  AgentAdminDetailService,
  handleAgentAdminDetailRequest,
  matchAgentAdminDetailRoute,
} from "../apps/api/src/modules/admin-detail/index.ts";
import {
  handleTenantPolicyOverlayRequest,
  matchTenantPolicyOverlayRoute,
  TenantPolicyOverlayService,
} from "../apps/api/src/modules/overlays/index.ts";
import {
  AgentVersionReviewService,
  handleAgentVersionReviewRequest,
  matchAgentVersionReviewRoute,
} from "../apps/api/src/modules/review/index.ts";
import { PrincipalResolver } from "../packages/auth/src/index.ts";
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

interface TemporaryServerContext {
  baseUrl: string;
  close(): Promise<void>;
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
  capabilities: string[];
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
          // Keep review tests deterministic and offline by default.
          resolveProbeHostname:
            options.resolveProbeHostname ??
            (async () => ["203.0.113.10"]),
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

async function createTemporaryServerContext(
  listener: http.RequestListener,
): Promise<TemporaryServerContext> {
  const server = http.createServer(listener);

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();

  if (address === null || typeof address === "string") {
    throw new Error("Expected an IPv4 test server address");
  }

  return {
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
    },
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

test("concurrent approvals keep the highest approved version active", async () => {
  // Arrange
  const context = await createReviewApiContext();
  const lockDb = createKyselyDb(context.databaseUrl);
  let releaseAgentLock = () => {};
  let resolveAgentLockHeld = () => {};
  let holdAgentLock: Promise<void> | undefined;
  const agentLockHeld = new Promise<void>((resolve) => {
    resolveAgentLockHeld = resolve;
  });
  const agentLockReleased = new Promise<void>((resolve) => {
    releaseAgentLock = resolve;
  });

  try {
    const firstDraft = await createDraftVersion(context, {
      versionLabel: "2026.03.13",
    });
    await submitVersion(context, firstDraft.agentId, firstDraft.versionId);
    await approveVersion(context, firstDraft.agentId, firstDraft.versionId);
    const secondDraftResponse = await requestJson<DraftAgentRegistrationResponse>(context, {
      body: createDraftRegistrationRequest({
        versionLabel: "2026.03.14",
      }),
      path: `/tenants/tenant-alpha/agents/${firstDraft.agentId}/versions`,
      subjectId: "publisher-alpha",
    });
    const thirdDraftResponse = await requestJson<DraftAgentRegistrationResponse>(context, {
      body: createDraftRegistrationRequest({
        versionLabel: "2026.03.15",
      }),
      path: `/tenants/tenant-alpha/agents/${firstDraft.agentId}/versions`,
      subjectId: "publisher-alpha",
    });
    await submitVersion(context, firstDraft.agentId, secondDraftResponse.body.versionId);
    await submitVersion(context, firstDraft.agentId, thirdDraftResponse.body.versionId);

    holdAgentLock = lockDb.transaction().execute(async (transaction) => {
      await transaction
        .selectFrom("agents")
        .select("agent_id")
        .where("tenant_id", "=", "tenant-alpha")
        .where("agent_id", "=", firstDraft.agentId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      resolveAgentLockHeld();
      await agentLockReleased;
    });

    await agentLockHeld;

    const higherApproval = approveVersion(context, firstDraft.agentId, thirdDraftResponse.body.versionId);
    await delay(50);
    const lowerApproval = approveVersion(context, firstDraft.agentId, secondDraftResponse.body.versionId);
    await delay(50);
    releaseAgentLock();

    // Act
    const [higherApprovalResponse, lowerApprovalResponse] = await Promise.all([
      higherApproval,
      lowerApproval,
    ]);
    await holdAgentLock;
    const storedAgent = await context.db
      .selectFrom("agents")
      .select("active_version_id")
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", firstDraft.agentId)
      .executeTakeFirstOrThrow();

    // Assert
    assert.equal(higherApprovalResponse.status, 200);
    assert.equal(lowerApprovalResponse.status, 200);
    assert.equal(storedAgent.active_version_id, thirdDraftResponse.body.versionId);
  } finally {
    releaseAgentLock();
    await holdAgentLock?.catch(() => undefined);
    await destroyKyselyDb(lockDb);
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
    assert.deepEqual(versionDetail.body.capabilities, ["shared-capability"]);
    assert.deepEqual(versionDetail.body.requiredRoles, ["support-agent"]);
    assert.deepEqual(versionDetail.body.requiredScopes, ["tickets.read"]);
    assert.equal(versionDetail.body.review.approvedBy, "admin-alpha");
    assert.equal(versionDetail.body.review.rejectedReason, null);
    assert.equal(rejectedVersionDetail.status, 200);
    assert.equal(rejectedVersionDetail.body.active, false);
    assert.equal(rejectedVersionDetail.body.approvalState, "rejected");
    assert.deepEqual(rejectedVersionDetail.body.capabilities, ["shared-capability"]);
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

test("approval rejects hosted probe targets whose hostname cannot be resolved", async () => {
  // Arrange
  const resolveProbeHostname = async (): Promise<string[]> => {
    const error = new Error("hostname not found") as NodeJS.ErrnoException;
    error.code = "ENOTFOUND";
    throw error;
  };
  const hostedContext = await createReviewApiContext({
    resolveProbeHostname,
  });

  try {
    const hostedDraft = await createDraftVersion(hostedContext, {
      publications: [
        {
          environmentKey: "dev",
          healthEndpointUrl: "https://unresolved-probe.example.test/health",
          rawCard: createRawCard({
            invocationEndpoint: "https://dev.agent.example.com/invoke",
          }),
        },
      ],
    });
    await submitVersion(hostedContext, hostedDraft.agentId, hostedDraft.versionId);

    // Act
    const hostedApprove = await approveVersion(
      hostedContext,
      hostedDraft.agentId,
      hostedDraft.versionId,
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

    // Assert
    assert.equal(hostedApprove.status, 400);
    assert.deepEqual(hostedApprove.body, {
      error: {
        code: "invalid_probe_target",
        message: "Hosted deployments require resolvable health endpoint hostnames.",
      },
    });
    assert.equal(hostedVersion.approval_state, "pending_review");
    assert.deepEqual(hostedHealthRows, []);
  } finally {
    await hostedContext.close();
  }
});

test("approval rejects unresolved probe targets even when self-hosted private probing is allowed", async () => {
  // Arrange
  const resolveProbeHostname = async (): Promise<string[]> => {
    const error = new Error("hostname not found") as NodeJS.ErrnoException;
    error.code = "ENOTFOUND";
    throw error;
  };
  const selfHostedContext = await createReviewApiContext({
    allowPrivateTargets: true,
    deploymentMode: "self-hosted",
    resolveProbeHostname,
  });

  try {
    const draft = await createDraftVersion(selfHostedContext, {
      publications: [
        {
          environmentKey: "dev",
          healthEndpointUrl: "https://unresolved-probe.example.test/health",
          rawCard: createRawCard({
            invocationEndpoint: "https://dev.agent.example.com/invoke",
          }),
        },
      ],
    });
    await submitVersion(selfHostedContext, draft.agentId, draft.versionId);

    // Act
    const approveResponse = await approveVersion(
      selfHostedContext,
      draft.agentId,
      draft.versionId,
    );
    const storedVersion = await selfHostedContext.db
      .selectFrom("agent_versions")
      .select("approval_state")
      .where("tenant_id", "=", "tenant-alpha")
      .where("agent_id", "=", draft.agentId)
      .where("version_id", "=", draft.versionId)
      .executeTakeFirstOrThrow();
    const healthRows = await selfHostedContext.db
      .selectFrom("publication_health")
      .innerJoin(
        "environment_publications",
        "environment_publications.publication_id",
        "publication_health.publication_id",
      )
      .select("publication_health.health_status")
      .where("environment_publications.tenant_id", "=", "tenant-alpha")
      .where("environment_publications.agent_id", "=", draft.agentId)
      .where("environment_publications.version_id", "=", draft.versionId)
      .execute();

    // Assert
    assert.equal(approveResponse.status, 400);
    assert.deepEqual(approveResponse.body, {
      error: {
        code: "invalid_probe_target",
        message: "Health endpoint hostnames must be resolvable.",
      },
    });
    assert.equal(storedVersion.approval_state, "pending_review");
    assert.deepEqual(healthRows, []);
  } finally {
    await selfHostedContext.close();
  }
});

test("malformed review, overlay, and admin-detail route encoding returns 400 without taking down the API listener", async () => {
  // Arrange
  const context = await createReviewApiContext();

  try {
    // Act
    const reviewMalformedResponse = await requestJson<ErrorResponseBody>(context, {
      path: "/tenants/%E0%A4%A/agents/agent-alpha/versions/version-1:submit",
      subjectId: "publisher-alpha",
    });
    const overlayMalformedResponse = await requestJson<ErrorResponseBody>(context, {
      path: "/tenants/%E0%A4%A/agents/agent-alpha:disable",
      subjectId: "admin-alpha",
    });
    const adminDetailMalformedResponse = await requestJson<ErrorResponseBody>(context, {
      method: "GET",
      path: "/tenants/%E0%A4%A/agents/agent-alpha",
      subjectId: "admin-alpha",
    });
    const followUpResponse = await requestJson<DraftAgentRegistrationResponse>(context, {
      body: createDraftRegistrationRequest({
        versionLabel: "2026.03.17",
      }),
      path: "/tenants/tenant-alpha/agents",
      subjectId: "publisher-alpha",
    });

    // Assert
    assert.equal(reviewMalformedResponse.status, 400);
    assert.deepEqual(reviewMalformedResponse.body, {
      error: {
        code: "invalid_request",
        message: "Tenant id path segment must be valid URL encoding.",
      },
    });
    assert.equal(overlayMalformedResponse.status, 400);
    assert.deepEqual(overlayMalformedResponse.body, {
      error: {
        code: "invalid_request",
        message: "Tenant id path segment must be valid URL encoding.",
      },
    });
    assert.equal(adminDetailMalformedResponse.status, 400);
    assert.deepEqual(adminDetailMalformedResponse.body, {
      error: {
        code: "invalid_request",
        message: "Tenant id path segment must be valid URL encoding.",
      },
    });
    assert.equal(followUpResponse.status, 201);
    assert.equal(followUpResponse.body.approvalState, "draft");
  } finally {
    await context.close();
  }
});

test("unexpected resolver failures return 500 internal_error responses for review, overlay, and admin detail endpoints", async () => {
  // Arrange
  const principalResolver = new PrincipalResolver({
    async getMembership() {
      throw new Error("database unavailable");
    },
  });
  const reviewService = new AgentVersionReviewService({
    async approveVersion() {
      throw new Error("review repository should not be called");
    },
    async getVersionForReview() {
      throw new Error("review repository should not be called");
    },
    async rejectVersion() {
      throw new Error("review repository should not be called");
    },
    async submitVersion() {
      throw new Error("review repository should not be called");
    },
  });
  const overlayService = new TenantPolicyOverlayService({
    async listForAgent() {
      return [];
    },
    async upsertNarrowingOverlay() {
      return {
        agentId: "unused",
        deprecated: false,
        disabled: false,
        environmentKey: null,
        requiredRoles: [],
        requiredScopes: [],
      };
    },
  });
  const adminDetailService = new AgentAdminDetailService({
    async getAgentDetail() {
      throw new Error("admin detail repository should not be called");
    },
    async getVersionDetail() {
      throw new Error("admin detail repository should not be called");
    },
  });
  const server = await createTemporaryServerContext(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const reviewRoute = matchAgentVersionReviewRoute(url.pathname);

    if (reviewRoute !== null) {
      await handleAgentVersionReviewRequest(request, response, reviewRoute, {
        principalResolver,
        service: reviewService,
      });
      return;
    }

    const overlayRoute = matchTenantPolicyOverlayRoute(url.pathname);

    if (overlayRoute !== null) {
      await handleTenantPolicyOverlayRequest(request, response, overlayRoute, {
        principalResolver,
        service: overlayService,
      });
      return;
    }

    const adminDetailRoute = matchAgentAdminDetailRoute(url.pathname);

    if (adminDetailRoute !== null) {
      await handleAgentAdminDetailRequest(request, response, adminDetailRoute, {
        principalResolver,
        service: adminDetailService,
      });
      return;
    }

    throw new Error(`Unexpected route: ${url.pathname}`);
  });

  try {
    // Act
    const reviewResponse = await fetch(
      new URL("/tenants/tenant-alpha/agents/agent-alpha/versions/version-1:submit", server.baseUrl),
      {
        headers: new Headers({
          "x-agent-registry-subject-id": "publisher-alpha",
        }),
        method: "POST",
      },
    );
    const overlayResponse = await fetch(
      new URL("/tenants/tenant-alpha/agents/agent-alpha:disable", server.baseUrl),
      {
        headers: new Headers({
          "x-agent-registry-subject-id": "admin-alpha",
        }),
        method: "POST",
      },
    );
    const adminDetailResponse = await fetch(
      new URL("/tenants/tenant-alpha/agents/agent-alpha", server.baseUrl),
      {
        headers: new Headers({
          "x-agent-registry-subject-id": "admin-alpha",
        }),
        method: "GET",
      },
    );

    // Assert
    assert.equal(reviewResponse.status, 500);
    assert.deepEqual((await reviewResponse.json()) as ErrorResponseBody, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    assert.equal(overlayResponse.status, 500);
    assert.deepEqual((await overlayResponse.json()) as ErrorResponseBody, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
    assert.equal(adminDetailResponse.status, 500);
    assert.deepEqual((await adminDetailResponse.json()) as ErrorResponseBody, {
      error: {
        code: "internal_error",
        message: "Internal server error.",
      },
    });
  } finally {
    await server.close();
  }
});
