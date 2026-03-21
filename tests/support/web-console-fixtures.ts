import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { expect, test as base, type Page } from "@playwright/test";
import pg from "pg";

import { PrincipalResolver } from "../../packages/auth/src/index.ts";
import { loadRegistryConfig, type RegistryConfig } from "../../packages/config/src/index.ts";
import {
  KyselyAgentDraftRegistrationRepository,
  KyselyAgentReviewRepository,
  KyselyBootstrapRepository,
  KyselyHealthRepository,
  KyselyPublicationTelemetryRepository,
  KyselyTenantEnvironmentRepository,
  KyselyTenantMembershipLookup,
  KyselyTenantPolicyOverlayRepository,
  KyselyTenantRepository,
  createKyselyDb,
  destroyKyselyDb,
  migrateToLatest,
  type AgentRegistryDb,
} from "../../packages/db/src/index.ts";
import { bootstrapFromConfig } from "../../apps/api/src/bootstrap/index.ts";
import { AgentDraftRegistrationService } from "../../apps/api/src/modules/agents/service.ts";
import { TenantPolicyOverlayService } from "../../apps/api/src/modules/overlays/service.ts";
import {
  AgentVersionReviewService,
  type AgentVersionReviewServiceOptions,
} from "../../apps/api/src/modules/review/service.ts";
import {
  createWebRequestListener,
  type WebRequestListenerOptions,
} from "../../apps/web/src/http.ts";

const { Pool } = pg;

const integrationDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://registry:registry@postgres:5432/agent_registry";

export interface FreshRegistryDatabase {
  cleanup(): Promise<void>;
  databaseUrl: string;
  db: AgentRegistryDb;
}

export interface EmptyRegistryDatabase {
  cleanup(): Promise<void>;
  databaseUrl: string;
}

export interface WebConsoleSubjects {
  admin: string;
  alternatePublisher?: string;
  publisher: string;
  secondaryAdmin?: string;
}

export interface WebConsoleTenants {
  primary: string;
  secondary?: string;
}

export interface WebConsoleContext extends FreshRegistryDatabase {
  baseUrl: string;
  close(): Promise<void>;
  config: RegistryConfig;
  subjects: WebConsoleSubjects;
  tenants: WebConsoleTenants;
}

export interface PendingVersionFixture {
  agentId: string;
  publicationIds: Record<string, string>;
  routes: {
    agentDetail: string;
    agentOverlays: {
      deprecate: string;
      disable: string;
    };
    approve: string;
    environmentOverlays: Record<
      string,
      {
        deprecate: string;
        disable: string;
      }
    >;
    reject: string;
    submit: string;
    versionDetail: string;
  };
  tenantId: string;
  versionId: string;
}

type ActorRole = "admin" | "publisher";

export interface VisualRouteScenario {
  name: string;
  pathname: string;
  role: ActorRole | "anonymous";
}

export interface VisualConsoleFixture extends WebConsoleContext {
  adminSignIn: {
    subjectId: string;
    tenantId: string;
  };
  publisherSignIn: {
    subjectId: string;
    tenantId: string;
  };
  scenarios: VisualRouteScenario[];
}

function createIsolatedDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export async function createFreshRegistryDatabase(): Promise<FreshRegistryDatabase> {
  const databaseName = `agent_registry_visual_${randomUUID().replaceAll("-", "_")}`;
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

export async function createEmptyRegistryDatabase(): Promise<EmptyRegistryDatabase> {
  const databaseName = `agent_registry_visual_${randomUUID().replaceAll("-", "_")}`;
  const adminPool = new Pool({
    connectionString: createIsolatedDatabaseUrl(integrationDatabaseUrl, "postgres"),
  });

  try {
    await adminPool.query(`create database "${databaseName}" template template0`);
  } catch (error) {
    await adminPool.end();
    throw error;
  }

  return {
    async cleanup() {
      await adminPool.query(
        "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
        [databaseName],
      );
      await adminPool.query(`drop database if exists "${databaseName}"`);
      await adminPool.end();
    },
    databaseUrl: createIsolatedDatabaseUrl(integrationDatabaseUrl, databaseName),
  };
}

function buildBootstrapState(
  deploymentMode: "hosted" | "self-hosted",
): {
  manifest: string;
  subjects: WebConsoleSubjects;
  tenants: WebConsoleTenants;
} {
  if (deploymentMode === "self-hosted") {
    return {
      manifest: [
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
      ].join("\n"),
      subjects: {
        admin: "admin-self-hosted",
        publisher: "publisher-self-hosted",
      },
      tenants: {
        primary: "tenant-self-hosted",
      },
    };
  }

  return {
    manifest: [
      "tenants:",
      "  - tenantId: tenant-alpha",
      "    displayName: Tenant Alpha",
      "    environments: [dev, prod, staging]",
      "    memberships:",
      "      - subjectId: admin-alpha",
      "        roles: [tenant-admin]",
      "      - subjectId: publisher-alpha",
      "        roles: [publisher]",
      "      - subjectId: publisher-bravo",
      "        roles: [publisher]",
      "  - tenantId: tenant-beta",
      "    displayName: Tenant Beta",
      "    environments: [test]",
      "    memberships:",
      "      - subjectId: admin-beta",
      "        roles: [tenant-admin]",
      "",
    ].join("\n"),
    subjects: {
      admin: "admin-alpha",
      alternatePublisher: "publisher-bravo",
      publisher: "publisher-alpha",
      secondaryAdmin: "admin-beta",
    },
    tenants: {
      primary: "tenant-alpha",
      secondary: "tenant-beta",
    },
  };
}

export async function startWebConsoleServer(
  options: WebRequestListenerOptions,
): Promise<{
  baseUrl: string;
  close(): Promise<void>;
}> {
  const server = http.createServer(createWebRequestListener(options));

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

export async function createWebConsoleContext(options: {
  bootstrapManifest?: string;
  deploymentMode: "hosted" | "self-hosted";
  reviewServiceOptions?: Pick<
    AgentVersionReviewServiceOptions,
    "enqueuePublicationProbe" | "resolveProbeHostname"
  >;
}): Promise<WebConsoleContext> {
  const database = await createFreshRegistryDatabase();
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agent-registry-web-console-"));
  const manifestPath = path.join(tempDir, "bootstrap.yaml");
  const bootstrapState = buildBootstrapState(options.deploymentMode);

  try {
    await writeFile(manifestPath, options.bootstrapManifest ?? bootstrapState.manifest, "utf8");

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

    const server = await startWebConsoleServer({
      config,
      db: database.db,
      reviewServiceOptions: {
        resolveProbeHostname:
          options.reviewServiceOptions?.resolveProbeHostname ?? (async () => ["198.51.100.20"]),
        enqueuePublicationProbe: options.reviewServiceOptions?.enqueuePublicationProbe,
      },
    });

    return {
      ...database,
      baseUrl: server.baseUrl,
      config,
      async close() {
        await server.close();
        await rm(tempDir, { force: true, recursive: true });
        await database.cleanup();
      },
      subjects: bootstrapState.subjects,
      tenants: bootstrapState.tenants,
    };
  } catch (error) {
    await rm(tempDir, { force: true, recursive: true });
    await database.cleanup();
    throw error;
  }
}

export function createRawCard(overrides: Record<string, unknown> = {}): string {
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

function buildPendingVersionRoutes(
  tenantId: string,
  agentId: string,
  versionId: string,
  environments: string[],
): PendingVersionFixture["routes"] {
  const encodedTenantId = encodeURIComponent(tenantId);
  const encodedAgentId = encodeURIComponent(agentId);
  const encodedVersionId = encodeURIComponent(versionId);

  return {
    agentDetail: `/tenants/${encodedTenantId}/agents/${encodedAgentId}`,
    agentOverlays: {
      deprecate: `/tenants/${encodedTenantId}/agents/${encodedAgentId}/overlay/deprecate`,
      disable: `/tenants/${encodedTenantId}/agents/${encodedAgentId}/overlay/disable`,
    },
    approve: `/tenants/${encodedTenantId}/agents/${encodedAgentId}/versions/${encodedVersionId}/approve`,
    environmentOverlays: Object.fromEntries(
      environments.map((environmentKey) => {
        const encodedEnvironmentKey = encodeURIComponent(environmentKey);

        return [
          environmentKey,
          {
            deprecate: `/tenants/${encodedTenantId}/agents/${encodedAgentId}/environments/${encodedEnvironmentKey}/overlay/deprecate`,
            disable: `/tenants/${encodedTenantId}/agents/${encodedAgentId}/environments/${encodedEnvironmentKey}/overlay/disable`,
          },
        ];
      }),
    ),
    reject: `/tenants/${encodedTenantId}/agents/${encodedAgentId}/versions/${encodedVersionId}/reject`,
    submit: `/tenants/${encodedTenantId}/agents/${encodedAgentId}/versions/${encodedVersionId}/submit`,
    versionDetail: `/tenants/${encodedTenantId}/agents/${encodedAgentId}/versions/${encodedVersionId}`,
  };
}

export function getRedirectLocation(response: Response): string {
  const location = response.headers.get("location");

  if (location === null) {
    throw new Error(`Expected redirect location but received status ${response.status}`);
  }

  return location;
}

export class BrowserSession {
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

export async function signIn(
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

export async function createPendingVersion(
  context: WebConsoleContext,
  input: {
    agentId?: string;
    displayName: string;
    environments: string[];
    publisherId: string;
    summary: string;
    tenantId?: string;
    versionLabel: string;
  },
): Promise<PendingVersionFixture> {
  const tenantId = input.tenantId ?? context.tenants.primary;
  const principal = await resolvePrincipal(context.db, tenantId, input.publisherId);
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

  const draft = await draftService.createDraftAgent(
    principal,
    tenantId,
    {
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
    },
    {
      agentId: input.agentId,
    },
  );

  await reviewService.submitVersion(principal, tenantId, draft.agentId, draft.versionId);

  return {
    agentId: draft.agentId,
    publicationIds: Object.fromEntries(
      draft.publications.map((publication) => [publication.environmentKey, publication.publicationId]),
    ),
    routes: buildPendingVersionRoutes(tenantId, draft.agentId, draft.versionId, input.environments),
    tenantId,
    versionId: draft.versionId,
  };
}

export async function approvePendingVersion(
  context: WebConsoleContext,
  fixture: PendingVersionFixture,
): Promise<void> {
  const principal = await resolvePrincipal(context.db, fixture.tenantId, context.subjects.admin);
  const reviewService = new AgentVersionReviewService(
    new KyselyAgentReviewRepository(context.db),
    {
      deploymentMode: context.config.deploymentMode,
      requireHttps: context.config.healthProbe.requireHttps,
      resolveProbeHostname: async () => ["198.51.100.20"],
    },
  );

  await reviewService.approveVersion(
    principal,
    fixture.tenantId,
    fixture.agentId,
    fixture.versionId,
  );
}

export async function seedHealthAndTelemetry(
  db: AgentRegistryDb,
  fixture: PendingVersionFixture,
): Promise<void> {
  const publicationId = fixture.publicationIds.dev;

  if (publicationId === undefined) {
    throw new Error("Expected a dev publication before seeding health and telemetry.");
  }

  const healthRepository = new KyselyHealthRepository(db);
  const telemetryRepository = new KyselyPublicationTelemetryRepository(db);

  await healthRepository.recordPublicationProbe({
    checkedAt: "2026-03-13T10:00:00Z",
    error: null,
    ok: true,
    publicationId,
    statusCode: 200,
  });
  await healthRepository.recordPublicationProbe({
    checkedAt: "2026-03-13T10:01:00Z",
    error: "service unavailable",
    ok: false,
    publicationId,
    statusCode: 503,
  });
  await telemetryRepository.upsertPublicationTelemetry({
    agentId: fixture.agentId,
    environmentKey: "dev",
    errorCount: 1,
    invocationCount: 12,
    p50LatencyMs: 120,
    p95LatencyMs: 280,
    successCount: 11,
    tenantId: fixture.tenantId,
    versionId: fixture.versionId,
    windowEndedAt: "2026-03-13T10:15:00Z",
    windowStartedAt: "2026-03-13T10:00:00Z",
  });
}

async function pinReviewTimestamps(
  db: AgentRegistryDb,
  fixture: PendingVersionFixture,
  input: {
    approvedAt?: string;
    submittedAt: string;
  },
): Promise<void> {
  await db
    .updateTable("agent_versions")
    .set({
      approved_at: input.approvedAt ?? null,
      submitted_at: input.submittedAt,
    })
    .where("tenant_id", "=", fixture.tenantId)
    .where("agent_id", "=", fixture.agentId)
    .where("version_id", "=", fixture.versionId)
    .execute();
}

async function seedVisualConsoleContext(): Promise<VisualConsoleFixture> {
  const context = await createWebConsoleContext({
    deploymentMode: "hosted",
  });

  try {
    const approvedFixture = await createPendingVersion(context, {
      displayName: "Case Router",
      environments: ["dev", "prod"],
      publisherId: context.subjects.publisher,
      summary: "Routes support cases.",
      versionLabel: "v1",
    });
    const newestPendingFixture = await createPendingVersion(context, {
      displayName: "Escalation Router",
      environments: ["dev"],
      publisherId: context.subjects.publisher,
      summary: "Escalates complex support cases.",
      versionLabel: "v2",
    });
    const olderPendingFixture = await createPendingVersion(context, {
      displayName: "Billing Resolver",
      environments: ["staging"],
      publisherId: context.subjects.alternatePublisher ?? context.subjects.publisher,
      summary: "Handles billing-specific support queues.",
      versionLabel: "v7",
    });
    const overlayService = new TenantPolicyOverlayService(
      new KyselyTenantPolicyOverlayRepository(context.db),
    );
    const adminPrincipal = await resolvePrincipal(
      context.db,
      context.tenants.primary,
      context.subjects.admin,
    );

    await approvePendingVersion(context, approvedFixture);
    await seedHealthAndTelemetry(context.db, approvedFixture);
    await overlayService.deprecateEnvironment(
      adminPrincipal,
      context.tenants.primary,
      approvedFixture.agentId,
      "prod",
    );
    await pinReviewTimestamps(context.db, approvedFixture, {
      approvedAt: "2026-03-13T10:06:00Z",
      submittedAt: "2026-03-13T10:02:00Z",
    });
    await pinReviewTimestamps(context.db, newestPendingFixture, {
      submittedAt: "2026-03-14T09:30:00Z",
    });
    await pinReviewTimestamps(context.db, olderPendingFixture, {
      submittedAt: "2026-03-14T08:15:00Z",
    });

    return {
      ...context,
      adminSignIn: {
        subjectId: context.subjects.admin,
        tenantId: context.tenants.primary,
      },
      publisherSignIn: {
        subjectId: context.subjects.publisher,
        tenantId: context.tenants.primary,
      },
      scenarios: [
        {
          name: "landing",
          pathname: "/",
          role: "anonymous",
        },
        {
          name: "console-dashboard",
          pathname: "/console",
          role: "admin",
        },
        {
          name: "environment-management",
          pathname: `/tenants/${context.tenants.primary}/environments`,
          role: "admin",
        },
        {
          name: "draft-registration",
          pathname: `/tenants/${context.tenants.primary}/drafts/new`,
          role: "publisher",
        },
        {
          name: "review-queue",
          pathname: `/tenants/${context.tenants.primary}/review`,
          role: "admin",
        },
        {
          name: "active-agent-detail",
          pathname: approvedFixture.routes.agentDetail,
          role: "admin",
        },
        {
          name: "version-detail",
          pathname: approvedFixture.routes.versionDetail,
          role: "admin",
        },
      ],
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}

export async function signInAs(
  page: Page,
  fixture: VisualConsoleFixture,
  role: ActorRole,
): Promise<void> {
  const identity = role === "admin" ? fixture.adminSignIn : fixture.publisherSignIn;

  await page.goto(`${fixture.baseUrl}/`, { waitUntil: "networkidle" });
  await page.locator('select[name="tenantId"]').selectOption(identity.tenantId);
  await page.locator('select[name="subjectId"]').selectOption(identity.subjectId);
  await page.getByRole("button", { name: "Authenticate Identity" }).click();
  await page.waitForURL(`${fixture.baseUrl}/console`);
}

export async function waitForVisualReadiness(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.addStyleTag({
    content: `
      *,
      *::before,
      *::after {
        animation: none !important;
        caret-color: transparent !important;
        transition: none !important;
      }
    `,
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
}

type VisualFixtures = {
  visualConsole: VisualConsoleFixture;
};

export const test = base.extend<VisualFixtures>({
  visualConsole: [
    async ({}, use) => {
      const fixture = await seedVisualConsoleContext();

      try {
        await use(fixture);
      } finally {
        await fixture.close();
      }
    },
    { scope: "worker" },
  ],
});

export { expect };
