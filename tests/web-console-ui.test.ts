import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import pg from "pg";

import { PrincipalResolver } from "../packages/auth/src/index.ts";
import { loadRegistryConfig, type RegistryConfig } from "../packages/config/src/index.ts";
import {
  KyselyAgentAdminDetailRepository,
  KyselyAgentDraftRegistrationRepository,
  KyselyAgentReviewRepository,
  KyselyBootstrapRepository,
  KyselyHealthRepository,
  KyselyPublicationTelemetryRepository,
  KyselyTenantEnvironmentRepository,
  KyselyTenantMembershipLookup,
  KyselyTenantRepository,
  createKyselyDb,
  destroyKyselyDb,
  migrateToLatest,
  type AgentRegistryDb,
} from "../packages/db/src/index.ts";
import { bootstrapFromConfig } from "../apps/api/src/bootstrap/index.ts";
import { AgentDraftRegistrationService } from "../apps/api/src/modules/agents/service.ts";
import { AgentVersionReviewService } from "../apps/api/src/modules/review/service.ts";
import { createWebRequestListener } from "../apps/web/src/http.ts";

const { Pool } = pg;

const integrationDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://registry:registry@postgres:5432/agent_registry";

interface FreshRegistryDatabase {
  cleanup(): Promise<void>;
  databaseUrl: string;
  db: AgentRegistryDb;
}

interface WebConsoleContext extends FreshRegistryDatabase {
  baseUrl: string;
  close(): Promise<void>;
  config: RegistryConfig;
}

interface PendingVersionFixture {
  agentId: string;
  versionId: string;
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

async function createWebConsoleContext(options: {
  deploymentMode: "hosted" | "self-hosted";
}): Promise<WebConsoleContext> {
  const database = await createFreshRegistryDatabase();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-registry-web-console-"));
  const manifestPath = path.join(tempDir, "bootstrap.yaml");

  try {
    const manifest =
      options.deploymentMode === "self-hosted"
        ? [
            "tenants:",
            "  - tenantId: tenant-self-hosted",
            "    displayName: Tenant Self Hosted",
            "    environments: [dev, prod]",
            "    memberships:",
            "      - subjectId: admin-self-hosted",
            "        roles: [tenant-admin]",
            "      - subjectId: publisher-self-hosted",
            "        roles: [publisher]",
            "",
          ].join("\n")
        : [
            "tenants:",
            "  - tenantId: tenant-alpha",
            "    displayName: Tenant Alpha",
            "    environments: [dev, prod, staging]",
            "    memberships:",
            "      - subjectId: admin-alpha",
            "        roles: [tenant-admin]",
            "      - subjectId: publisher-alpha",
            "        roles: [publisher]",
            "  - tenantId: tenant-beta",
            "    displayName: Tenant Beta",
            "    environments: [test]",
            "    memberships:",
            "      - subjectId: admin-beta",
            "        roles: [tenant-admin]",
            "",
          ].join("\n");

    await writeFile(manifestPath, manifest, "utf8");

    const config = loadRegistryConfig(
      options.deploymentMode === "self-hosted"
        ? {
            DATABASE_URL: database.databaseUrl,
            DEPLOYMENT_MODE: "self-hosted",
            SELF_HOSTED_BOOTSTRAP_FILE: manifestPath,
          }
        : {
            DATABASE_URL: database.databaseUrl,
            DEPLOYMENT_MODE: "hosted",
            HOSTED_BOOTSTRAP_FILE: manifestPath,
          },
    );

    await bootstrapFromConfig(config, new KyselyBootstrapRepository(database.db));

    const server = http.createServer(
      createWebRequestListener({
        config,
        db: database.db,
        reviewServiceOptions: {
          resolveProbeHostname: async () => ["198.51.100.20"],
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
      config,
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

function getRedirectLocation(response: Response): string {
  const location = response.headers.get("location");

  if (location === null) {
    throw new Error(`Expected redirect location but received status ${response.status}`);
  }

  return location;
}

class BrowserSession {
  private readonly baseUrl: string;

  private readonly cookies = new Map<string, string>();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async get(pathname: string): Promise<Response> {
    return this.request(pathname, {
      method: "GET",
    });
  }

  async postForm(pathname: string, formData: FormData): Promise<Response> {
    return this.request(pathname, {
      body: formData,
      method: "POST",
    });
  }

  async postUrlEncoded(pathname: string, values: Record<string, string>): Promise<Response> {
    return this.request(pathname, {
      body: new URLSearchParams(values),
      method: "POST",
    });
  }

  private async request(pathname: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    const cookieHeader = [...this.cookies.entries()]
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");

    if (cookieHeader !== "") {
      headers.set("cookie", cookieHeader);
    }

    const response = await fetch(new URL(pathname, this.baseUrl), {
      ...init,
      headers,
      redirect: "manual",
    });
    const setCookieHeader =
      typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];

    for (const cookie of setCookieHeader) {
      const [pair] = cookie.split(";", 1);
      const separatorIndex = pair.indexOf("=");

      if (separatorIndex <= 0) {
        continue;
      }

      const name = pair.slice(0, separatorIndex);
      const value = pair.slice(separatorIndex + 1);

      if (value === "") {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }

    return response;
  }
}

async function signIn(
  browser: BrowserSession,
  tenantId: string,
  subjectId: string,
): Promise<void> {
  const response = await browser.postUrlEncoded("/session", {
    subjectId,
    tenantId,
  });

  assert.equal(response.status, 303);
  assert.equal(getRedirectLocation(response), "/console");
}

async function resolvePrincipal(
  db: AgentRegistryDb,
  tenantId: string,
  subjectId: string,
) {
  return new PrincipalResolver(new KyselyTenantMembershipLookup(db)).resolve({
    auth: {
      subjectId,
    },
    tenantId,
  });
}

async function createPendingVersion(
  context: WebConsoleContext,
  input: {
    displayName: string;
    environments: string[];
    publisherId: string;
    summary: string;
    versionLabel: string;
  },
): Promise<PendingVersionFixture> {
  const principal = await resolvePrincipal(context.db, "tenant-alpha", input.publisherId);
  const draftService = new AgentDraftRegistrationService(
    new KyselyAgentDraftRegistrationRepository(context.db),
    new KyselyTenantEnvironmentRepository(context.db),
    new KyselyTenantRepository(context.db),
    {
      deploymentMode: context.config.deploymentMode,
      rawCardByteLimit: context.config.rawCardByteLimit,
      requireHttpsHealthEndpoints: context.config.healthProbe.requireHttps,
    },
  );
  const reviewService = new AgentVersionReviewService(
    new KyselyAgentReviewRepository(context.db),
    {
      deploymentMode: context.config.deploymentMode,
      requireHttps: context.config.healthProbe.requireHttps,
      resolveProbeHostname: async () => ["198.51.100.20"],
    },
  );

  const draft = await draftService.createDraftAgent(principal, "tenant-alpha", {
    capabilities: ["shared-capability"],
    contextContract: [
      {
        description: "Selects the client partition.",
        example: "client-123",
        key: "client_id",
        required: true,
        type: "string",
      },
    ],
    displayName: input.displayName,
    headerContract: [
      {
        description: "Passes the calling user identifier.",
        name: "X-User-Id",
        required: true,
        source: "user.id",
      },
    ],
    publications: input.environments.map((environmentKey) => ({
      environmentKey,
      healthEndpointUrl: `https://${environmentKey}.health.example.com/status`,
      rawCard: createRawCard({
        capabilities: ["card-search", `${environmentKey}-capability`],
        name: input.displayName,
        summary: input.summary,
        tags: ["card-tag", environmentKey],
      }),
    })),
    requiredRoles: ["support-agent"],
    requiredScopes: ["tickets.read"],
    summary: input.summary,
    tags: ["shared-tag"],
    versionLabel: input.versionLabel,
  });

  await reviewService.submitVersion(principal, "tenant-alpha", draft.agentId, draft.versionId);

  return {
    agentId: draft.agentId,
    versionId: draft.versionId,
  };
}

async function approvePendingVersion(
  context: WebConsoleContext,
  fixture: PendingVersionFixture,
): Promise<void> {
  const principal = await resolvePrincipal(context.db, "tenant-alpha", "admin-alpha");
  const reviewService = new AgentVersionReviewService(
    new KyselyAgentReviewRepository(context.db),
    {
      deploymentMode: context.config.deploymentMode,
      requireHttps: context.config.healthProbe.requireHttps,
      resolveProbeHostname: async () => ["198.51.100.20"],
    },
  );

  await reviewService.approveVersion(principal, "tenant-alpha", fixture.agentId, fixture.versionId);
}

async function seedHealthAndTelemetry(
  db: AgentRegistryDb,
  fixture: PendingVersionFixture,
): Promise<void> {
  const publication = await db
    .selectFrom("environment_publications")
    .select(["publication_id", "environment_key"])
    .where("tenant_id", "=", "tenant-alpha")
    .where("agent_id", "=", fixture.agentId)
    .where("version_id", "=", fixture.versionId)
    .where("environment_key", "=", "dev")
    .executeTakeFirstOrThrow();

  const healthRepository = new KyselyHealthRepository(db);
  const telemetryRepository = new KyselyPublicationTelemetryRepository(db);

  await healthRepository.recordPublicationProbe({
    checkedAt: "2026-03-13T10:00:00Z",
    error: null,
    ok: true,
    publicationId: publication.publication_id,
    statusCode: 200,
  });
  await healthRepository.recordPublicationProbe({
    checkedAt: "2026-03-13T10:01:00Z",
    error: "service unavailable",
    ok: false,
    publicationId: publication.publication_id,
    statusCode: 503,
  });
  await telemetryRepository.upsertPublicationTelemetry({
    agentId: fixture.agentId,
    environmentKey: publication.environment_key,
    errorCount: 1,
    invocationCount: 12,
    p50LatencyMs: 120,
    p95LatencyMs: 280,
    successCount: 11,
    tenantId: "tenant-alpha",
    versionId: fixture.versionId,
    windowEndedAt: "2026-03-13T10:15:00Z",
    windowStartedAt: "2026-03-13T10:00:00Z",
  });
}

test("publisher console creates a multi-environment draft and submits it for review", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const signInPage = await browser.get("/");
    const signInHtml = await signInPage.text();

    await signIn(browser, "tenant-alpha", "publisher-alpha");

    const dashboardPage = await browser.get("/console");
    const dashboardHtml = await dashboardPage.text();
    const newDraftPage = await browser.get("/tenants/tenant-alpha/drafts/new");
    const newDraftHtml = await newDraftPage.text();
    const draftForm = new FormData();

    draftForm.set("versionLabel", "v1");
    draftForm.set("displayName", "Case Resolver");
    draftForm.set("summary", "Handles support case routing.");
    draftForm.set("capabilities", "shared-capability, case-routing");
    draftForm.set("tags", "shared-tag, routing");
    draftForm.set("requiredRoles", "support-agent");
    draftForm.set("requiredScopes", "tickets.read, tickets.write");
    draftForm.set(
      "headerContract",
      JSON.stringify([
        {
          description: "Passes the calling user identifier.",
          name: "X-User-Id",
          required: true,
          source: "user.id",
        },
      ]),
    );
    draftForm.set(
      "contextContract",
      JSON.stringify([
        {
          description: "Selects the client partition.",
          example: "client-123",
          key: "client_id",
          required: true,
          type: "string",
        },
      ]),
    );
    draftForm.set("publication:dev:enabled", "on");
    draftForm.set("publication:dev:healthEndpointUrl", "https://dev.health.example.com/status");
    draftForm.set(
      "publication:dev:rawCard",
      new File(
        [
          createRawCard({
            capabilities: ["card-search", "dev-capability"],
            name: "Case Resolver",
            summary: "Handles support case routing.",
            tags: ["card-tag", "dev"],
          }),
        ],
        "dev-card.json",
        {
          type: "application/json",
        },
      ),
    );
    draftForm.set("publication:prod:enabled", "on");
    draftForm.set("publication:prod:healthEndpointUrl", "https://prod.health.example.com/status");
    draftForm.set(
      "publication:prod:rawCard",
      new File(
        [
          createRawCard({
            capabilities: ["card-search", "prod-capability"],
            name: "Case Resolver",
            summary: "Handles support case routing.",
            tags: ["card-tag", "prod"],
          }),
        ],
        "prod-card.json",
        {
          type: "application/json",
        },
      ),
    );

    // Act
    const createDraftResponse = await browser.postForm("/tenants/tenant-alpha/drafts", draftForm);
    const draftLocation = getRedirectLocation(createDraftResponse);
    const draftDetailPage = await browser.get(draftLocation);
    const draftDetailHtml = await draftDetailPage.text();
    const routeMatch =
      /^\/tenants\/tenant-alpha\/agents\/([^/]+)\/versions\/([^/]+)$/.exec(draftLocation);

    if (routeMatch === null) {
      throw new Error(`Unexpected draft redirect location '${draftLocation}'`);
    }

    const submitResponse = await browser.postUrlEncoded(
      `/tenants/tenant-alpha/agents/${routeMatch[1]}/versions/${routeMatch[2]}/submit`,
      {},
    );
    const submittedDetailPage = await browser.get(draftLocation);
    const submittedDetailHtml = await submittedDetailPage.text();
    const environmentsPage = await browser.get("/tenants/tenant-alpha/environments");
    const environmentsHtml = await environmentsPage.text();

    // Assert
    assert.equal(signInPage.status, 200);
    assert.match(signInHtml, /<select[^>]+name="tenantId"/);
    assert.match(dashboardHtml, /New Draft Registration/);
    assert.doesNotMatch(dashboardHtml, /Review Queue/);
    assert.equal(newDraftPage.status, 200);
    assert.match(newDraftHtml, /type="file"/);
    assert.match(newDraftHtml, /publication:dev:enabled/);
    assert.equal(createDraftResponse.status, 303);
    assert.match(draftDetailHtml, /Approval state: draft/);
    assert.match(draftDetailHtml, /Environment: dev/);
    assert.match(draftDetailHtml, /Environment: prod/);
    assert.match(draftDetailHtml, /X-User-Id/);
    assert.match(draftDetailHtml, /client_id/);
    assert.equal(submitResponse.status, 303);
    assert.equal(getRedirectLocation(submitResponse), draftLocation);
    assert.match(submittedDetailHtml, /Approval state: pending_review/);
    assert.equal(environmentsPage.status, 403);
    assert.match(environmentsHtml, /Tenant admin role is required/);
  } finally {
    await context.close();
  }
});

test("publisher console returns 403 for admin-only review and active agent detail routes", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const approvedFixture = await createPendingVersion(context, {
      displayName: "Case Router",
      environments: ["dev"],
      publisherId: "publisher-alpha",
      summary: "Routes support cases.",
      versionLabel: "v1",
    });

    await approvePendingVersion(context, approvedFixture);
    await signIn(browser, "tenant-alpha", "publisher-alpha");

    // Act
    const reviewQueuePage = await browser.get("/tenants/tenant-alpha/review");
    const reviewQueueHtml = await reviewQueuePage.text();
    const agentDetailPage = await browser.get(`/tenants/tenant-alpha/agents/${approvedFixture.agentId}`);
    const agentDetailHtml = await agentDetailPage.text();

    // Assert
    assert.equal(reviewQueuePage.status, 403);
    assert.match(reviewQueueHtml, /Tenant admin role is required/);
    assert.equal(agentDetailPage.status, 403);
    assert.match(agentDetailHtml, /Tenant admin role is required/);
  } finally {
    await context.close();
  }
});

test("admin console manages environments, reviews pending versions, edits overlays, and inspects details", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const approveFixture = await createPendingVersion(context, {
      displayName: "Case Router",
      environments: ["dev", "prod"],
      publisherId: "publisher-alpha",
      summary: "Routes support cases.",
      versionLabel: "v1",
    });
    const rejectFixture = await createPendingVersion(context, {
      displayName: "Case Escalator",
      environments: ["dev"],
      publisherId: "publisher-alpha",
      summary: "Escalates complex cases.",
      versionLabel: "v2",
    });

    await signIn(browser, "tenant-alpha", "admin-alpha");

    const dashboardPage = await browser.get("/console");
    const dashboardHtml = await dashboardPage.text();
    const environmentsPage = await browser.get("/tenants/tenant-alpha/environments");
    const environmentsHtml = await environmentsPage.text();

    // Act
    const createEnvironmentResponse = await browser.postUrlEncoded("/tenants/tenant-alpha/environments", {
      environmentKey: "qa",
    });
    const updatedEnvironmentsPage = await browser.get("/tenants/tenant-alpha/environments");
    const updatedEnvironmentsHtml = await updatedEnvironmentsPage.text();
    const reviewQueuePage = await browser.get("/tenants/tenant-alpha/review");
    const reviewQueueHtml = await reviewQueuePage.text();
    const approveResponse = await browser.postUrlEncoded(
      `/tenants/tenant-alpha/agents/${approveFixture.agentId}/versions/${approveFixture.versionId}/approve`,
      {},
    );

    await seedHealthAndTelemetry(context.db, approveFixture);

    const approvedVersionPage = await browser.get(
      `/tenants/tenant-alpha/agents/${approveFixture.agentId}/versions/${approveFixture.versionId}`,
    );
    const approvedVersionHtml = await approvedVersionPage.text();
    const deprecateEnvironmentResponse = await browser.postUrlEncoded(
      `/tenants/tenant-alpha/agents/${approveFixture.agentId}/environments/prod/overlay/deprecate`,
      {},
    );
    const agentDetailPage = await browser.get(`/tenants/tenant-alpha/agents/${approveFixture.agentId}`);
    const agentDetailHtml = await agentDetailPage.text();
    const rejectResponse = await browser.postUrlEncoded(
      `/tenants/tenant-alpha/agents/${rejectFixture.agentId}/versions/${rejectFixture.versionId}/reject`,
      {
        reason: "Needs clearer scopes.",
      },
    );
    const rejectedVersionPage = await browser.get(
      `/tenants/tenant-alpha/agents/${rejectFixture.agentId}/versions/${rejectFixture.versionId}`,
    );
    const rejectedVersionHtml = await rejectedVersionPage.text();
    const overlayRows = await new KyselyAgentAdminDetailRepository(context.db).getAgentDetail(
      "tenant-alpha",
      approveFixture.agentId,
    );

    // Assert
    assert.match(dashboardHtml, /Environment Management/);
    assert.match(dashboardHtml, /Review Queue/);
    assert.equal(environmentsPage.status, 200);
    assert.match(environmentsHtml, /staging/);
    assert.equal(createEnvironmentResponse.status, 303);
    assert.equal(getRedirectLocation(createEnvironmentResponse), "/tenants/tenant-alpha/environments");
    assert.match(updatedEnvironmentsHtml, /qa/);
    assert.match(reviewQueueHtml, /Case Router/);
    assert.match(reviewQueueHtml, /Case Escalator/);
    assert.equal(approveResponse.status, 303);
    assert.equal(getRedirectLocation(approveResponse), `/tenants/tenant-alpha/agents/${approveFixture.agentId}`);
    assert.match(approvedVersionHtml, /Health History/);
    assert.match(approvedVersionHtml, /503/);
    assert.match(approvedVersionHtml, /Invocation count: 12/);
    assert.match(approvedVersionHtml, /p95 latency: 280/);
    assert.equal(deprecateEnvironmentResponse.status, 303);
    assert.equal(
      getRedirectLocation(deprecateEnvironmentResponse),
      `/tenants/tenant-alpha/agents/${approveFixture.agentId}`,
    );
    assert.match(agentDetailHtml, /Overlay State/);
    assert.match(agentDetailHtml, /Environment overlay for prod/);
    assert.match(agentDetailHtml, /Deprecated: yes/);
    assert.deepEqual(
      overlayRows.overlay.environments.find((overlay) => overlay.environmentKey === "prod"),
      {
        deprecated: true,
        disabled: false,
        environmentKey: "prod",
        requiredRoles: [],
        requiredScopes: [],
      },
    );
    assert.equal(rejectResponse.status, 303);
    assert.equal(
      getRedirectLocation(rejectResponse),
      `/tenants/tenant-alpha/agents/${rejectFixture.agentId}/versions/${rejectFixture.versionId}`,
    );
    assert.match(rejectedVersionHtml, /Approval state: rejected/);
    assert.match(rejectedVersionHtml, /Rejected reason: Needs clearer scopes\./);
  } finally {
    await context.close();
  }
});

test("self-hosted console collapses tenant selection while keeping tenant-scoped routes", async () => {
  const context = await createWebConsoleContext({
    deploymentMode: "self-hosted",
  });
  const browser = new BrowserSession(context.baseUrl);

  try {
    // Arrange
    const signInPage = await browser.get("/");
    const signInHtml = await signInPage.text();

    // Act
    await signIn(browser, "tenant-self-hosted", "admin-self-hosted");

    const dashboardPage = await browser.get("/console");
    const dashboardHtml = await dashboardPage.text();

    // Assert
    assert.equal(signInPage.status, 200);
    assert.doesNotMatch(signInHtml, /<select[^>]+name="tenantId"/);
    assert.match(signInHtml, /type="hidden"[^>]+name="tenantId"[^>]+tenant-self-hosted/);
    assert.match(signInHtml, /Single-tenant deployment/);
    assert.match(dashboardHtml, /\/tenants\/tenant-self-hosted\/environments/);
    assert.match(dashboardHtml, /Tenant Self Hosted/);
  } finally {
    await context.close();
  }
});
